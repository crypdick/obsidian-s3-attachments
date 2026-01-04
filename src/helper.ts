import { TFile, Vault } from "obsidian";

export function getS3Path(res: string | URL): string {
	if (typeof res === 'string') {
		res = new URL(encodeURI(res));
	}
	return decodeURI(res.pathname).slice(1);
}

function escapeRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchS3URLs(content: string, baseUrls: string[]): string[] {
	const out: string[] = [];
	for (const baseUrl of baseUrls) {
		if (!baseUrl) continue;
		const safe = escapeRegExp(baseUrl.replace(/\/+$/, ''));
		const reg = new RegExp(`${safe}\\/[^"\\]\\)\\s]*`, 'g');
		const matches = content.match(reg);
		if (matches) out.push(...matches);
	}
	return out;
}

export async function getS3URLs(files: TFile[], vault: Vault, baseUrls: string[]): Promise<string[]> {
	const obsidianIndex: string[] = [];

	for (let i = 0; i < files.length; i++) {
		const content = await vault.read(files[i]);
		obsidianIndex.push(...matchS3URLs(content, baseUrls));
	}

	return [...new Set(obsidianIndex)];
}

export function generateResourceName(fileName: string, parent?: string, hash?: string) {
	const [name, type] = fileName.split('.');
	if (hash)
		return `${name}-${hash}.${type}`;
	else
		return `${parent ? parent + '-' : ''}${name}-${Date.now()}.${type}`;
}

export function buf2hex(buffer: ArrayBuffer) {
	return [...new Uint8Array(buffer)]
		.map(x => x.toString(16).padStart(2, '0'))
		.join('');
}