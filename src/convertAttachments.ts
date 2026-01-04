import { App, Notice, TFile, Vault } from "obsidian";
import ObsidianS3, { server } from "main";
import { buf2hex, generateResourceName } from "./helper";
import { mimeType } from "./settings";

export type ConvertScope = "current-note" | "current-folder" | "entire-vault";

export interface ConvertAttachmentsOptions {
	scope: ConvertScope;
	dryRun: boolean;
	makeBackup: boolean;
	linkMode: "proxy" | "public";
}

type RefKind = "obsidian-embed" | "obsidian-link" | "md-embed" | "md-link";

interface AttachmentRef {
	kind: RefKind;
	start: number;
	end: number;
	/** Original matched text (for reporting/debug). */
	raw: string;
	/** Link target as written (before cleanup), without surrounding syntax. */
	target: string;
	/** Optional label/alt text if present in the source syntax. */
	label?: string;
	/** Markdown-only: keep any fragment/query suffix (e.g. #page=2) */
	suffix?: string;
}

interface Replacement {
	start: number;
	end: number;
	newText: string;
}

export interface ConvertReport {
	notesScanned: number;
	/** Number of references considered as attachment candidates (i.e., look like files we support). */
	refsFound: number;
	refsRemoteSkipped: number;
	refsUnresolved: number;
	attachmentsUnsupported: number;
	uploadsAttempted: number;
	uploadsSkippedAlreadyExists: number;
	uploadsSucceeded: number;
	uploadsFailed: number;
	notesChanged: number;
	linksRewritten: number;
	backupCreated: number;
	errors: string[];
	previewLines: string[];
}

function isProbablyRemoteLink(target: string): boolean {
	const t = target.trim();
	return (
		t.startsWith("http://") ||
		t.startsWith("https://") ||
		t.startsWith("data:") ||
		t.startsWith("mailto:") ||
		t.startsWith("file:")
	);
}

function extractExtFromTarget(target: string): string | null {
	// Strip fragment/query
	const t = target.split("#")[0].split("?")[0].trim();
	// Ignore folder-only / empty
	if (!t) return null;
	// Get last path segment
	const last = t.split("/").pop() ?? t;
	const dot = last.lastIndexOf(".");
	if (dot === -1) return null;
	const ext = last.slice(dot + 1).toLowerCase();
	if (!ext) return null;
	return ext;
}

function isAttachmentCandidate(target: string): boolean {
	const ext = extractExtFromTarget(target);
	if (!ext) return false;
	// Don't treat markdown notes as attachments
	if (ext === "md") return false;
	return mimeType.includeEXT(ext);
}

/**
 * Extract a markdown link destination from inside `( ... )`.
 * Supports:
 * - `(path/to/file.png)`
 * - `(<path with spaces.png>)`
 * - `(path/to/file.png "optional title")`
 */
function parseMarkdownDest(destRaw: string): { dest: string; suffix?: string } {
	let d = destRaw.trim();

	// If wrapped in <...>, treat everything inside as the destination (spaces allowed).
	if (d.startsWith("<")) {
		const close = d.indexOf(">");
		if (close !== -1) {
			d = d.slice(1, close);
		}
	} else {
		// Otherwise, only strip a title if it looks like the common `"title"` or `'title'` form.
		// This keeps unencoded spaces in destinations (which Obsidian often tolerates).
		const mTitle = d.match(/^(.*?)(?:\s+(".*"|\'.*\'))\s*$/);
		if (mTitle?.[1]) d = mTitle[1];
	}

	// Preserve fragment/query (useful for pdf links like file.pdf#page=2).
	const m = d.match(/^([^#?]+)([?#].+)?$/);
	if (!m) return { dest: d };
	return { dest: m[1], suffix: m[2] };
}

function parseObsidianLinkTarget(inner: string): { linkpath: string; label?: string } {
	// Obsidian wikilinks may look like:
	// - path/to/file.png
	// - path/to/file.png|alias
	// - path/to/file.png|100x100 (image sizing)
	// - file#heading or file^block (for notes) -> strip for resolution
	let linkpath = inner.trim();
	let label: string | undefined;

	const pipeIdx = linkpath.indexOf("|");
	if (pipeIdx !== -1) {
		label = linkpath.slice(pipeIdx + 1).trim() || undefined;
		linkpath = linkpath.slice(0, pipeIdx).trim();
	}

	// Strip heading/block parts for resolution.
	linkpath = linkpath.split("#")[0].split("^")[0].trim();

	return { linkpath, label };
}

export function extractAttachmentRefs(content: string): AttachmentRef[] {
	const refs: AttachmentRef[] = [];

	// Obsidian embeds: ![[path/to/file.png]]
	{
		const re = /!\[\[([^\]]+?)\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const raw = m[0];
			const inner = m[1] ?? "";
			const parsed = parseObsidianLinkTarget(inner);
			refs.push({
				kind: "obsidian-embed",
				start: m.index,
				end: m.index + raw.length,
				raw,
				target: parsed.linkpath,
				label: parsed.label,
			});
		}
	}

	// Obsidian links (non-embed): [[path/to/file.pdf]]
	{
		const re = /(?<!!)\[\[([^\]]+?)\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const raw = m[0];
			const inner = m[1] ?? "";
			const parsed = parseObsidianLinkTarget(inner);
			refs.push({
				kind: "obsidian-link",
				start: m.index,
				end: m.index + raw.length,
				raw,
				target: parsed.linkpath,
				label: parsed.label,
			});
		}
	}

	// Markdown image embeds: ![alt](dest)
	{
		const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const raw = m[0];
			const alt = m[1] ?? "";
			const destRaw = m[2] ?? "";
			const parsed = parseMarkdownDest(destRaw);
			refs.push({
				kind: "md-embed",
				start: m.index,
				end: m.index + raw.length,
				raw,
				target: parsed.dest,
				label: alt,
				suffix: parsed.suffix,
			});
		}
	}

	// Markdown links: [text](dest) (but not images)
	{
		const re = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) {
			const raw = m[0];
			const text = m[1] ?? "";
			const destRaw = m[2] ?? "";
			const parsed = parseMarkdownDest(destRaw);
			refs.push({
				kind: "md-link",
				start: m.index,
				end: m.index + raw.length,
				raw,
				target: parsed.dest,
				label: text,
				suffix: parsed.suffix,
			});
		}
	}

	// Sort by start asc to make downstream logic predictable.
	refs.sort((a, b) => a.start - b.start);
	return refs;
}

function listMarkdownFilesInFolder(vault: Vault, folderPath: string): TFile[] {
	const normalized = folderPath.replace(/\/+$/, "");
	return vault.getMarkdownFiles().filter((f) => f.path.startsWith(normalized + "/"));
}

function getScopeFiles(app: App, scope: ConvertScope): TFile[] {
	const active = app.workspace.getActiveFile();
	const { vault } = app;

	if (scope === "current-note") {
		return active ? [active] : [];
	}
	if (scope === "current-folder") {
		if (!active?.parent) return [];
		return listMarkdownFilesInFolder(vault, active.parent.path);
	}
	return vault.getMarkdownFiles();
}

function getMethodForFile(file: TFile): "img" | "iframe" | "link" {
	const ext = file.extension;
	const mime = mimeType.getMIME(ext);
	return mimeType.getMethod(mime) as "img" | "iframe" | "link";
}

function buildReplacement(ref: AttachmentRef, url: string, resolved: TFile): string {
	const method = getMethodForFile(resolved);
	const suffix = ref.suffix ?? "";
	const urlWithSuffix = `${url}${suffix}`;

	if (method === "iframe") {
		return `<iframe src="${urlWithSuffix}" alt="${resolved.name}" style="overflow:hidden;height:400;width:100%" allowfullscreen></iframe>`;
	}

	if (method === "img") {
		const alt = ref.kind === "md-embed" ? (ref.label ?? "") : "";
		return `![${alt}](${urlWithSuffix})`;
	}

	// method === 'link'
	if (ref.kind === "md-link") {
		const label = (ref.label ?? "").trim() || resolved.basename;
		return `[${label}](${urlWithSuffix})`;
	}
	if (ref.kind === "obsidian-link") {
		const label = (ref.label ?? "").trim() || resolved.basename;
		return `[${label}](${urlWithSuffix})`;
	}
	return `${urlWithSuffix}`;
}

async function ensureBackup(vault: Vault, note: TFile): Promise<boolean> {
	const base = `${note.path}.bak`;
	let target = base;
	let n = 0;
	while (vault.getAbstractFileByPath(target)) {
		n += 1;
		target = `${base}.${n}`;
	}
	await vault.copy(note, target);
	return true;
}

async function sha1Hex(buf: ArrayBuffer): Promise<string> {
	const hashBuf = await crypto.subtle.digest("SHA-1", buf);
	return buf2hex(hashBuf);
}

async function buildS3FileNameForVaultFile(vault: Vault, file: TFile): Promise<{ fileName: string; bytes: ArrayBuffer }> {
	const bytes = await vault.readBinary(file);
	const hash = await sha1Hex(bytes);
	const fileName = generateResourceName(file.name, undefined, hash);
	return { fileName, bytes };
}

function buildTargetUrl(plugin: ObsidianS3, fileName: string, linkMode: "proxy" | "public"): string | null {
	const s3 = plugin.s3;
	if (linkMode === "public") {
		const u = s3.createPublicURL(fileName, plugin.getActive().publicBaseUrl);
		if (u) return u;
		new Notice('S3: Public link mode requested but "Public Base URL" is not set. Falling back to local proxy links.');
	}
	return s3.createObjURL(server.url, fileName);
}

export async function convertAttachments(plugin: ObsidianS3, opts: ConvertAttachmentsOptions): Promise<ConvertReport> {
	const report: ConvertReport = {
		notesScanned: 0,
		refsFound: 0,
		refsRemoteSkipped: 0,
		refsUnresolved: 0,
		attachmentsUnsupported: 0,
		uploadsAttempted: 0,
		uploadsSkippedAlreadyExists: 0,
		uploadsSucceeded: 0,
		uploadsFailed: 0,
		notesChanged: 0,
		linksRewritten: 0,
		backupCreated: 0,
		errors: [],
		previewLines: [],
	};

	if (!plugin.s3) {
		new Notice("S3: No active S3 client. Check your settings.");
		return report;
	}

	const scopeFiles = getScopeFiles(plugin.app, opts.scope);
	if (scopeFiles.length === 0) {
		new Notice("S3: No notes found for the chosen scope.");
		return report;
	}

	const { vault, metadataCache } = plugin.app;

	// De-dup uploads across the whole run: vaultPath -> remote url
	const resolvedUrlByVaultPath = new Map<string, string>();

	for (const note of scopeFiles) {
		report.notesScanned += 1;
		const content = await vault.read(note);
		// Only consider refs that look like supported attachment files.
		// This avoids treating normal [[note links]] / .md links as "attachments".
		const refs = extractAttachmentRefs(content).filter((r) => isAttachmentCandidate(r.target));
		report.refsFound += refs.length;

		const replacements: Replacement[] = [];

		for (const ref of refs) {
			if (!ref.target || ref.target.trim() === "") continue;
			if (isProbablyRemoteLink(ref.target)) {
				report.refsRemoteSkipped += 1;
				continue;
			}

			// Resolve to a TFile using Obsidian's link resolution logic.
			const resolved = metadataCache.getFirstLinkpathDest(ref.target, note.path);
			if (!resolved || !(resolved instanceof TFile)) {
				report.refsUnresolved += 1;
				report.previewLines.push(`[UNRESOLVED] ${note.path}: ${ref.raw}`);
				continue;
			}

			// Only rewrite supported attachment types (not markdown notes).
			if (resolved.extension === "md" || !mimeType.includeEXT(resolved.extension)) {
				report.attachmentsUnsupported += 1;
				continue;
			}

			let url = resolvedUrlByVaultPath.get(resolved.path);
			if (!url) {
				try {
					const { fileName, bytes } = await buildS3FileNameForVaultFile(vault, resolved);
					const targetUrl = buildTargetUrl(plugin, fileName, opts.linkMode);
					if (!targetUrl) {
						report.errors.push(`Unable to create target URL for ${resolved.path}`);
						continue;
					}

					const exists = await plugin.s3.objectExists(fileName);
					if (exists) {
						report.uploadsSkippedAlreadyExists += 1;
					} else {
						report.uploadsAttempted += 1;
						if (!opts.dryRun) {
							const mime = mimeType.getMIME(resolved.extension);
							const fileObj = new File([bytes], resolved.name, { type: mime });
							await plugin.s3.upload(fileObj, fileName);
							report.uploadsSucceeded += 1;
						}
					}

					url = targetUrl;
					resolvedUrlByVaultPath.set(resolved.path, url);
				} catch (e) {
					report.uploadsFailed += 1;
					report.errors.push(`Upload failed for ${resolved.path}: ${String(e)}`);
					continue;
				}
			}

			const newText = buildReplacement(ref, url, resolved);
			if (newText !== ref.raw) {
				replacements.push({ start: ref.start, end: ref.end, newText });
				report.linksRewritten += 1;
				report.previewLines.push(`[REWRITE] ${note.path}: ${ref.raw} -> ${newText}`);
			}
		}

		if (replacements.length === 0) continue;

		// Apply from end to start to keep indices stable.
		replacements.sort((a, b) => b.start - a.start);
		let next = content;
		for (const r of replacements) {
			next = next.slice(0, r.start) + r.newText + next.slice(r.end);
		}

		if (!opts.dryRun) {
			if (opts.makeBackup) {
				await ensureBackup(vault, note);
				report.backupCreated += 1;
			}
			await vault.modify(note, next);
			report.notesChanged += 1;
		}
	}

	if (opts.dryRun) {
		new Notice(`S3 dry-run: scanned ${report.notesScanned} notes, would rewrite ${report.linksRewritten} links.`);
	} else {
		new Notice(`S3: scanned ${report.notesScanned} notes, rewrote ${report.linksRewritten} links, uploaded ${report.uploadsSucceeded} files.`);
	}

	return report;
}


