import type { FootprintPrimitive } from './footprintParser';

const LAYER_SILKSCREEN = 3;

export interface FootprintPadData {
	padNumber: string;
	x: number;
	y: number;
	width: number;
	height: number;
	shape: string;
	holeDiameter: number;
	rotation: number;
	layerId: number;
}

export interface FootprintOutlineLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface FootprintData {
	pads: FootprintPadData[];
	outlines: FootprintOutlineLine[];
}

export function extractFootprintData(primitives: FootprintPrimitive[]): FootprintData {
	const pads: FootprintPadData[] = [];
	const outlines: FootprintOutlineLine[] = [];

	for (const prim of primitives) {
		if (prim.type.toUpperCase() === 'PAD') {
			const d = prim.data;
			pads.push({
				padNumber: String(d.padNumber ?? d.number ?? d.name ?? ''),
				x: Number(d.x ?? 0),
				y: Number(d.y ?? 0),
				width: Number(d.width ?? 0),
				height: Number(d.height ?? 0),
				shape: String(d.shape ?? 'RECT').toUpperCase(),
				holeDiameter: Number(d.holeDiameter ?? d.drill ?? d.holeRadius * 2 ?? 0),
				rotation: Number(d.rotation ?? d.angle ?? 0),
				layerId: prim.layerId,
			});
		}

		if (prim.layerId !== LAYER_SILKSCREEN) continue;

		const t = prim.type.toUpperCase();
		const d = prim.data;

		if (t === 'LINE') {
			const x1 = Number(d.x1 ?? d.startX ?? 0);
			const y1 = Number(d.y1 ?? d.startY ?? 0);
			const x2 = Number(d.x2 ?? d.endX ?? 0);
			const y2 = Number(d.y2 ?? d.endY ?? 0);
			outlines.push({ x1, y1, x2, y2 });
		}
		else if (t === 'ARC') {
			const cx = Number(d.centerX ?? d.x ?? 0);
			const cy = Number(d.centerY ?? d.y ?? 0);
			const radius = Number(d.radius ?? 0);
			const startAngle = Number(d.startAngle ?? 0);
			const endAngle = Number(d.endAngle ?? 0);
			if (radius > 0) {
				const segments = Math.max(8, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 8)));
				for (let i = 0; i < segments; i++) {
					const a1 = startAngle + (endAngle - startAngle) * (i / segments);
					const a2 = startAngle + (endAngle - startAngle) * ((i + 1) / segments);
					outlines.push({
						x1: cx + radius * Math.cos(a1),
						y1: cy + radius * Math.sin(a1),
						x2: cx + radius * Math.cos(a2),
						y2: cy + radius * Math.sin(a2),
					});
				}
			}
		}
		else if (t === 'CIRCLE') {
			const cx = Number(d.x ?? d.centerX ?? 0);
			const cy = Number(d.y ?? d.centerY ?? 0);
			const radius = Number(d.radius ?? d.r ?? 0);
			if (radius > 0) {
				const segments = 16;
				for (let i = 0; i < segments; i++) {
					const a1 = (2 * Math.PI * i) / segments;
					const a2 = (2 * Math.PI * (i + 1)) / segments;
					outlines.push({
						x1: cx + radius * Math.cos(a1),
						y1: cy + radius * Math.sin(a1),
						x2: cx + radius * Math.cos(a2),
						y2: cy + radius * Math.sin(a2),
					});
				}
			}
		}
		else if (t === 'RECTANGLE' || t === 'RECT') {
			const x = Number(d.x ?? 0);
			const y = Number(d.y ?? 0);
			const w = Number(d.width ?? 0);
			const h = Number(d.height ?? 0);
			if (w > 0 && h > 0) {
				const x1 = x - w / 2;
				const y1 = y - h / 2;
				const x2 = x + w / 2;
				const y2 = y + h / 2;
				outlines.push({ x1, y1: y1, x2, y2: y1 });
				outlines.push({ x1: x2, y1: y1, x2, y2 });
				outlines.push({ x1: x2, y1: y2, x2: x1, y2 });
				outlines.push({ x1: x1, y1: y2, x2: x1, y2: y1 });
			}
		}
		else if (t === 'POLY' || t === 'POLYLINE') {
			const path = d.path ?? d.points ?? [];
			if (Array.isArray(path)) {
				const points: { x: number; y: number }[] = [];
				if (path.length > 0 && typeof path[0] === 'object') {
					for (const p of path) {
						points.push({ x: Number(p.x ?? 0), y: Number(p.y ?? 0) });
					}
				}
				else {
					let i = 0;
					while (i < path.length) {
						if (typeof path[i] === 'number' && typeof path[i + 1] === 'number') {
							points.push({ x: path[i], y: path[i + 1] });
							i += 2;
						}
						else {
							i++;
						}
					}
				}
				for (let i = 0; i < points.length - 1; i++) {
					outlines.push({ x1: points[i].x, y1: points[i].y, x2: points[i + 1].x, y2: points[i + 1].y });
				}
			}
		}
	}

	return { pads, outlines };
}
