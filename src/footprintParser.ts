import JSZip from 'jszip';

export interface FootprintPrimitive {
	type: string;
	layerId: number;
	data: any;
}

export async function parseFootprintFile(file: File): Promise<string | null> {
	if (!file) return null;
	try {
		const zip = await JSZip.loadAsync(file);
		for (const fileName in zip.files) {
			const entry = zip.files[fileName];
			if (!entry.dir && fileName.endsWith('.elibu')) {
				return await entry.async('text');
			}
		}
		return null;
	}
	catch {
		return null;
	}
}

function parseElibuLine(line: string): { type: string; data: any } | null {
	if (!line || line.trim().length === 0) return null;
	try {
		const parts = line.split('||');
		if (parts.length < 2) return null;
		const header = JSON.parse(parts[0]);
		const innerStr = parts[1].replace(/\|$/, '');
		if (!innerStr) return null;
		const data = JSON.parse(innerStr);
		return { type: header.type || '', data };
	}
	catch {
		return null;
	}
}

export function parseElibuContent(content: string): FootprintPrimitive[] {
	const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
	const primitives: FootprintPrimitive[] = [];
	for (const line of lines) {
		const parsed = parseElibuLine(line);
		if (!parsed) continue;
		primitives.push({
			type: parsed.type,
			layerId: parsed.data.layerId ?? parsed.data.layer ?? 0,
			data: parsed.data,
		});
	}
	return primitives;
}
