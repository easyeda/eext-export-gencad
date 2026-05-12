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
	lineWidth: number;
	arc?: { cx: number; cy: number };
	circle?: { cx: number; cy: number; r: number };
}

export interface FootprintData {
	pads: FootprintPadData[];
	outlines: FootprintOutlineLine[];
}

export function extractFootprintData(primitives: FootprintPrimitive[]): FootprintData {
	const pads: FootprintPadData[] = [];
	const outlines: FootprintOutlineLine[] = [];

	for (const prim of primitives) {
		const t = prim.type.toUpperCase();
		const d = prim.data;

		if (t === 'PAD') {
			const dp = d.defaultPad || {};
			const hole = d.hole;
			let holeDia = 0;
			if (hole) {
				if (typeof hole === 'object') {
					holeDia = Number(hole.diameter ?? hole.width ?? (hole.radius ? (hole.radius * 2) : 0));
				} else {
					holeDia = Number(hole) || 0;
				}
			}
			pads.push({
				padNumber: String(d.num ?? d.padNumber ?? d.number ?? d.name ?? ''),
				x: Number(d.centerX ?? d.x ?? 0),
				y: Number(d.centerY ?? d.y ?? 0),
				width: Number(dp.width ?? d.width ?? 0),
				height: Number(dp.height ?? d.height ?? 0),
				shape: String(dp.padType ?? d.shape ?? 'RECT').toUpperCase(),
				holeDiameter: holeDia,
				rotation: Number(d.padAngle ?? d.rotation ?? d.angle ?? 0),
				layerId: prim.layerId,
			});
			continue;
		}

		if (prim.layerId !== LAYER_SILKSCREEN) continue;

		if (t === 'LINE') {
			const x1 = Number(d.x1 ?? d.startX ?? 0);
			const y1 = Number(d.y1 ?? d.startY ?? 0);
			const x2 = Number(d.x2 ?? d.endX ?? 0);
			const y2 = Number(d.y2 ?? d.endY ?? 0);
			const lw = Number(d.lineWidth ?? d.strokeWidth ?? d.width ?? 6);
			outlines.push({ x1, y1, x2, y2, lineWidth: lw });
		}
		else if (t === 'ARC') {
			const cx = Number(d.centerX ?? d.x ?? 0);
			const cy = Number(d.centerY ?? d.y ?? 0);
			const radius = Number(d.radius ?? 0);
			const startAngle = Number(d.startAngle ?? 0);
			const endAngle = Number(d.endAngle ?? 0);
			const lw = Number(d.lineWidth ?? d.strokeWidth ?? d.width ?? 6);
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
						lineWidth: lw,
					});
				}
			}
		}
		else if (t === 'CIRCLE') {
			const cx = Number(d.x ?? d.centerX ?? 0);
			const cy = Number(d.y ?? d.centerY ?? 0);
			const radius = Number(d.radius ?? d.r ?? 0);
			const lw = Number(d.lineWidth ?? d.strokeWidth ?? d.width ?? 6);
			if (radius > 0) {
				outlines.push({ x1: 0, y1: 0, x2: 0, y2: 0, lineWidth: lw, circle: { cx, cy, r: radius } });
			}
		}
		else if (t === 'RECTANGLE' || t === 'RECT') {
			const x = Number(d.x ?? d.centerX ?? 0);
			const y = Number(d.y ?? d.centerY ?? 0);
			const w = Number(d.width ?? 0);
			const h = Number(d.height ?? 0);
			const lw = Number(d.lineWidth ?? d.strokeWidth ?? 6);
			if (w > 0 && h > 0) {
				const x1 = x - w / 2;
				const y1 = y - h / 2;
				const x2 = x + w / 2;
				const y2 = y + h / 2;
				outlines.push({ x1, y1, x2: x2, y2: y1, lineWidth: lw });
				outlines.push({ x1: x2, y1, x2: x2, y2, lineWidth: lw });
				outlines.push({ x1: x2, y1: y2, x2: x1, y2, lineWidth: lw });
				outlines.push({ x1, y1: y2, x2: x1, y2: y1, lineWidth: lw });
			}
		}
		else if (t === 'POLY' || t === 'POLYLINE' || t === 'FILL' || t === 'FILLPATH') {
			const path = d.path ?? d.points ?? [];
			const lw = Number(d.width ?? d.lineWidth ?? d.strokeWidth ?? 6);
			if (Array.isArray(path) && path.length >= 4) {
				let curX = 0, curY = 0;
				let i = 0;
				if (typeof path[0] === 'number' && typeof path[1] === 'number') {
					curX = path[0];
					curY = path[1];
					i = 2;
				}
				while (i < path.length) {
					const val = path[i];
					if (typeof val === 'string') {
						const cmd = val.toUpperCase();
						if (cmd === 'M') {
							if (i + 2 < path.length) {
								curX = Number(path[i + 1]);
								curY = Number(path[i + 2]);
								i += 3;
							} else { i++; }
						} else if (cmd === 'L') {
							if (i + 2 < path.length) {
								const nx = Number(path[i + 1]);
								const ny = Number(path[i + 2]);
								outlines.push({ x1: curX, y1: curY, x2: nx, y2: ny, lineWidth: lw });
								curX = nx;
								curY = ny;
								i += 3;
							} else { i++; }
						} else if (cmd === 'ARC') {
							// Format: "ARC", sweepAngleDeg, endX, endY
							// Positive = CCW, Negative = CW
							if (i + 3 < path.length) {
								const sweepDeg = Number(path[i + 1]);
								const endX = Number(path[i + 2]);
								const endY = Number(path[i + 3]);
								const absSweepDeg = Math.abs(sweepDeg);
								if (absSweepDeg > 0.01) {
									const halfSweepRad = absSweepDeg * Math.PI / 360;
									const dx = (endX - curX) / 2;
									const dy = (endY - curY) / 2;
									const halfChord = Math.sqrt(dx * dx + dy * dy);
									const radius = halfChord / Math.sin(halfSweepRad);
									const d = radius * Math.cos(halfSweepRad);
									const midX = (curX + endX) / 2;
									const midY = (curY + endY) / 2;
									// Perpendicular pointing LEFT of start→end
									const perpX = -(endY - curY) / (2 * halfChord);
									const perpY = (endX - curX) / (2 * halfChord);
									let cx: number, cy: number;
									if (sweepDeg > 0) {
										// CCW: center to the left
										cx = midX + d * perpX;
										cy = midY + d * perpY;
									} else {
										// CW: center to the right
										cx = midX - d * perpX;
										cy = midY - d * perpY;
									}
									outlines.push({ x1: sweepDeg > 0 ? curX : endX, y1: sweepDeg > 0 ? curY : endY, x2: sweepDeg > 0 ? endX : curX, y2: sweepDeg > 0 ? endY : curY, lineWidth: lw, arc: { cx, cy } });
								} else {
									outlines.push({ x1: curX, y1: curY, x2: endX, y2: endY, lineWidth: lw });
								}
								curX = endX;
								curY = endY;
								i += 4;
							} else { i++; }
						} else if (cmd === 'CIRCLE') {
							// Format: 'CIRCLE', cx, cy, radius
							const ccx = Number(path[i + 1]);
							const ccy = Number(path[i + 2]);
							const cr = Number(path[i + 3]);
							if (cr > 0) {
								outlines.push({ x1: 0, y1: 0, x2: 0, y2: 0, lineWidth: lw, circle: { cx: ccx, cy: ccy, r: cr } });
							}
							i += 4;
						} else if (cmd === 'Z') {
							i++;
						} else {
							i++;
						}
					} else if (typeof val === 'number') {
						if (i + 1 < path.length && typeof path[i + 1] === 'number') {
							const nx = val;
							const ny = Number(path[i + 1]);
							outlines.push({ x1: curX, y1: curY, x2: nx, y2: ny, lineWidth: lw });
							curX = nx;
							curY = ny;
							i += 2;
						} else { i++; }
					} else {
						i++;
					}
				}
			}
		}
	}

	return { pads, outlines };
}
