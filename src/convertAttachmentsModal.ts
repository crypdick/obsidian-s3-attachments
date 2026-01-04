import { App, Modal, Setting } from "obsidian";
import ObsidianS3 from "main";
import { ConvertAttachmentsOptions, ConvertReport, ConvertScope, convertAttachments } from "./convertAttachments";

function scopeLabel(scope: ConvertScope): string {
	if (scope === "current-note") return "Current note";
	if (scope === "current-folder") return "Current folder";
	return "Entire vault";
}

export class ConvertAttachmentsReportModal extends Modal {
	private report: ConvertReport;

	constructor(app: App, report: ConvertReport) {
		super(app);
		this.report = report;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "S3 conversion report" });
		contentEl.createEl("p", {
			text:
				`Scanned ${this.report.notesScanned} notes. ` +
				`Rewrote ${this.report.linksRewritten} links. ` +
				`Uploads: ${this.report.uploadsSucceeded} succeeded, ${this.report.uploadsSkippedAlreadyExists} skipped (already exists), ${this.report.uploadsFailed} failed.`,
		});

		if (this.report.errors.length) {
			contentEl.createEl("h3", { text: "Errors" });
			const pre = contentEl.createEl("pre");
			pre.setText(this.report.errors.join("\n"));
		}

		contentEl.createEl("h3", { text: "Preview (first 200 changes)" });
		const pre = contentEl.createEl("pre");
		pre.setText(this.report.previewLines.slice(0, 200).join("\n"));
	}
}

export class ConvertAttachmentsModal extends Modal {
	private plugin: ObsidianS3;
	private opts: ConvertAttachmentsOptions;

	constructor(app: App, plugin: ObsidianS3, preset?: Partial<ConvertAttachmentsOptions>) {
		super(app);
		this.plugin = plugin;
		this.opts = {
			scope: preset?.scope ?? "current-note",
			dryRun: preset?.dryRun ?? true,
			makeBackup: preset?.makeBackup ?? true,
			linkMode: preset?.linkMode ?? "proxy",
			deleteOriginal: preset?.deleteOriginal ?? false,
			deleteOnlyIfNoExternalRefs: preset?.deleteOnlyIfNoExternalRefs ?? true,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Upload existing attachments to S3 and rewrite links" });

		new Setting(contentEl)
			.setName("Scope")
			.setDesc("Choose which notes to scan for local attachments.")
			.addDropdown((d) => {
				d.addOptions({
					"current-note": "Current note",
					"current-folder": "Current folder",
					"entire-vault": "Entire vault",
				});
				d.setValue(this.opts.scope);
				d.onChange((v) => (this.opts.scope = v as ConvertScope));
			});

		new Setting(contentEl)
			.setName("Dry-run")
			.setDesc("Preview changes without uploading or modifying notes.")
			.addToggle((t) => {
				t.setValue(this.opts.dryRun);
				t.onChange((v) => (this.opts.dryRun = v));
			});

		new Setting(contentEl)
			.setName("Create .bak copies")
			.setDesc("Before modifying a note, create a side-by-side .bak copy.")
			.addToggle((t) => {
				t.setValue(this.opts.makeBackup);
				t.onChange((v) => (this.opts.makeBackup = v));
			});

		new Setting(contentEl)
			.setName("Delete original local attachments")
			.setDesc("Careful: this can break other notes if they still reference the local file. Only deletes after the remote URL is verified accessible.")
			.addToggle((t) => {
				t.setValue(this.opts.deleteOriginal);
				t.onChange((v) => (this.opts.deleteOriginal = v));
			});

		new Setting(contentEl)
			.setName("Only delete if not referenced outside scope")
			.setDesc("Safety check: only delete a local file if all of its references are within the chosen scope (i.e., it is never referenced by notes outside the scope).")
			.addToggle((t) => {
				t.setValue(this.opts.deleteOnlyIfNoExternalRefs);
				t.setDisabled(!this.opts.deleteOriginal);
				t.onChange((v) => (this.opts.deleteOnlyIfNoExternalRefs = v));
			});

		new Setting(contentEl)
			.setName("Link mode")
			.setDesc("How rewritten links should be written.")
			.addDropdown((d) => {
				d.addOptions({
					proxy: "Local proxy (http://localhost:PORT/...)",
					public: "Public URL (https://.../folder/file)",
				});
				d.setValue(this.opts.linkMode);
				d.onChange((v) => (this.opts.linkMode = v as "proxy" | "public"));
			});

		if (this.opts.scope === "entire-vault") {
			contentEl.createEl("p", { text: "Warning: Entire vault can take a while on large vaults." });
		}

		new Setting(contentEl).addButton((b) => {
			b.setButtonText(this.opts.dryRun ? "Run dry-run" : "Run conversion");
			b.setCta();
			b.onClick(async () => {
				b.setDisabled(true);
				try {
					const report = await convertAttachments(this.plugin, this.opts);
					// Always log the report so users can inspect/keep a record.
					console.log("[s3-attachments-storage] convertAttachments report:", report);
					if (report.previewLines?.length) {
						console.log("[s3-attachments-storage] convertAttachments preview (first 200):\n" + report.previewLines.slice(0, 200).join("\n"));
					}
					if (report.errors?.length) {
						console.warn("[s3-attachments-storage] convertAttachments errors:\n" + report.errors.join("\n"));
					}
					this.close();
					new ConvertAttachmentsReportModal(this.app, report).open();
				} finally {
					b.setDisabled(false);
				}
			});
		}).setName("Run");
	}
}


