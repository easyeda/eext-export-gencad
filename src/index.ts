import { parseFootprintFile, parseElibuContent } from './footprintParser';
import { extractFootprintData } from './footprintExtractor';
import type { FootprintData } from './footprintExtractor';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

function mil2inch(mil: number): number {
	return mil / 1000.0;
}

function fmt(mil: number): string {
	return mil2inch(mil).toFixed(6);
}

// EasyEDA copper layers: [1,2] + [15..44]
const ALL_COPPER_LAYERS: number[] = [1, 2];
for (let i = 15; i <= 44; i++) ALL_COPPER_LAYERS.push(i);

function isCopperLayer(layerId: number): boolean {
	return ALL_COPPER_LAYERS.includes(layerId);
}

function layerIdToGencad(id: number, copperLayers?: LayerInfo[]): string {
	if (id === 1) return 'TOP';
	if (id === 2) return 'BOTTOM';
	if (id >= 15 && id <= 44 && copperLayers) {
		const innerLayers = copperLayers.filter(l => l.id >= 15 && l.id <= 44);
		const idx = innerLayers.findIndex(l => l.id === id);
		if (idx >= 0) return `INNER${idx + 1}`;
	}
	if (id >= 15 && id <= 44) return `INNER${id - 14}`;
	return 'ALL';
}

interface LayerInfo {
	id: number;
	name: string;
	type: string;
}

interface PadStackEntry {
	id: number;
	shape: string;
	width: number;
	height: number;
	drill: number;
	layers: number[];
	isThrough: boolean;
}

interface ComponentAttribute {
	key: string;
	value: string;
	x: number;
	y: number;
	rotation: number;
	fontSize: number;
	mirror: boolean;
	layer: number;
}

interface ComponentInfo {
	primitiveId: string;
	designator: string;
	name: string;
	value: string;
	x: number;
	y: number;
	rotation: number; // degrees
	layer: number;
	pads: Array<{ primitiveId: string; net: string; padNumber: string }>;
	footprintData: FootprintData | null;
	attributes: ComponentAttribute[];
}

interface PadExportInfo {
	x: number;
	y: number;
	net: string;
	ref: string;
	padNumber: string;
	padStackId: number;
	padId: number;
}

interface ViaInfo {
	primitiveId: string;
	x: number;
	y: number;
	net: string;
	diameter: number;
	holeDiameter: number;
	padStackId: number;
}

interface TraceInfo {
	net: string;
	layer: number;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	width: number;
}

interface BoardOutlineSeg {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

function padStackKey(shape: string, w: number, h: number, drill: number, isThrough: boolean): string {
	return `${shape}_${w}_${h}_${drill}_${isThrough}`;
}

// Parse pad shape from getState_Pad() — values are used directly (not doubled)
// Reference: eext-balance-copper createPadPolygon uses padShape[1] as w, padShape[2] as h directly
function parsePadShape(raw: any): { shape: string; width: number; height: number } {
	if (!Array.isArray(raw) || raw.length < 2) {
		return { shape: 'ELLIPSE', width: 0, height: 0 };
	}
	const type = String(raw[0]).toUpperCase();
	const w = Number(raw[1]) || 0;
	const h = Number(raw[2]) || 0;
	if (type === 'RECT' || type === 'RECTANGLE') {
		return { shape: 'RECT', width: w, height: h };
	}
	if (type === 'OVAL' || type === 'OBLONG') {
		return { shape: 'OVAL', width: w, height: h };
	}
	if (type === 'NGON' || type === 'REGULAR_POLYGON') {
		return { shape: 'ELLIPSE', width: w, height: w };
	}
	if (type === 'ELLIPSE') {
		return { shape: 'ELLIPSE', width: w, height: h };
	}
	return { shape: 'ELLIPSE', width: w, height: h };
}

function parseHole(raw: any): number {
	if (!Array.isArray(raw) || raw.length < 2) return 0;
	const type = String(raw[0]).toUpperCase();
	if (type === 'ROUND') return Number(raw[1]) || 0;
	if (type === 'SLOT') return Number(raw[1]) || 0;
	return 0;
}

// Parse EasyEDA polyline source array into coordinate points
// Source format: flat array with mixed types like [x1,y1,..,'CIRCLE',cx,cy,r,..,'R',x,y,w,h,rot,cr,..]
function parseSourceToPoints(source: (number | string)[]): Array<{ x: number; y: number }> {
	const points: Array<{ x: number; y: number }> = [];
	let i = 0;
	while (i < source.length) {
		const val = source[i];
		if (typeof val === 'string') {
			const cmd = val.toUpperCase();
			if (cmd === 'CIRCLE') {
				const cx = Number(source[i + 1]) || 0;
				const cy = Number(source[i + 2]) || 0;
				const r = Number(source[i + 3]) || 0;
				const segs = 24;
				for (let j = 0; j <= segs; j++) {
					const a = (2 * Math.PI * j) / segs;
					points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
				}
				i += 4;
			}
			else if (cmd === 'R') {
				// R rx ry w h [rotation] [corner_radius]
				const rx = Number(source[i + 1]) || 0;
				const ry = Number(source[i + 2]) || 0;
				const w = Number(source[i + 3]) || 0;
				const h = Number(source[i + 4]) || 0;
				// Simple rectangle from top-left rx,ry
				points.push({ x: rx, y: ry });
				points.push({ x: rx + w, y: ry });
				points.push({ x: rx + w, y: ry - h });
				points.push({ x: rx, y: ry - h });
				points.push({ x: rx, y: ry }); // close
				i += 5;
				// skip optional rotation and corner_radius
				while (i < source.length && typeof source[i] === 'number') i++;
			}
			else if (cmd === 'A') {
				// Arc: A cx cy rx ry startAngle endAngle
				const cx = Number(source[i + 1]) || 0;
				const cy = Number(source[i + 2]) || 0;
				const rx = Number(source[i + 3]) || 0;
				// const ry = Number(source[i + 4]) || 0;
				const startAngle = Number(source[i + 5]) || 0;
				const endAngle = Number(source[i + 6]) || 0;
				const segs = Math.max(8, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 8)));
				for (let j = 0; j <= segs; j++) {
					const a = startAngle + (endAngle - startAngle) * (j / segs);
					points.push({ x: cx + rx * Math.cos(a), y: cy + rx * Math.sin(a) });
				}
				i += 7;
			}
			else {
				i++;
			}
		}
		else if (typeof val === 'number') {
			if (i + 1 < source.length && typeof source[i + 1] === 'number') {
				points.push({ x: val, y: source[i + 1] as number });
				i += 2;
			}
			else {
				i++;
			}
		}
		else {
			i++;
		}
	}
	return points;
}

async function getFootprintData(comp: IPCB_PrimitiveComponent, cache: Map<string, FootprintData | null>): Promise<FootprintData | null> {
	const fpInfo = comp.getState_Footprint?.();
	if (!fpInfo || !fpInfo.uuid) return null;

	const cacheKey = fpInfo.uuid;
	if (cache.has(cacheKey)) return cache.get(cacheKey)!;

	try {
		console.warn('[GC] Fetching footprint:', fpInfo.uuid, 'lib:', fpInfo.libraryUuid);
		const file = await eda.sys_FileManager.getFootprintFileByFootprintUuid(fpInfo.uuid, fpInfo.libraryUuid, 'elibz2');
		if (!file) {
			console.warn('[GC] Footprint file is null for:', fpInfo.uuid);
			cache.set(cacheKey, null);
			return null;
		}
		console.warn('[GC] Footprint file size:', file.size, 'type:', file.type);
		const content = await parseFootprintFile(file);
		if (!content) {
			console.warn('[GC] No elibu content found in footprint ZIP');
			cache.set(cacheKey, null);
			return null;
		}
		console.warn('[GC] Elibu content length:', content.length);
		const primitives = parseElibuContent(content);
		console.warn('[GC] Parsed primitives:', primitives.length);
		const data = extractFootprintData(primitives);
		console.warn('[GC] Extracted pads:', data.pads.length, 'outlines:', data.outlines.length);
		if (data.pads.length > 0) {
			console.warn('[GC] First 3 pads:', JSON.stringify(data.pads.slice(0, 3)));
		}
		if (data.outlines.length > 0) {
			console.warn('[GC] First 3 outlines:', JSON.stringify(data.outlines.slice(0, 3)));
		}
		cache.set(cacheKey, data);
		return data;
	}
	catch (err) {
		console.warn('[GC] Footprint fetch error:', err);
		cache.set(cacheKey, null);
		return null;
	}
}

async function collectBoardData() {
	const _gcLogs: string[] = [];
	const _gcLog = (...args: any[]) => { _gcLogs.push(args.map(a => String(a)).join(' ')); };
	(globalThis as any).__gcLogs = _gcLogs;
	const LAYER_BOARD_OUTLINE = 11;
	const LAYER_SILKSCREEN_TOP = 3;
	const LAYER_SILKSCREEN_BOTTOM = 4;

	const layers = await eda.pcb_Layer.getAllLayers();
	const nets = await eda.pcb_Net.getAllNetsName();
	const allComponents = await eda.pcb_PrimitiveComponent.getAll();
	const allVias = await eda.pcb_PrimitiveVia.getAll();
	const allPads = await eda.pcb_PrimitivePad.getAll();
	const allAttributes = await eda.pcb_PrimitiveAttribute.getAll().catch(() => [] as any[]);

	// Board outline: use Polyline on layer 11 (NOT Line)
	const [polylines, boardLines] = await Promise.all([
		eda.pcb_PrimitivePolyline.getAll(undefined, LAYER_BOARD_OUTLINE as any).catch(() => [] as any[]),
		eda.pcb_PrimitiveLine.getAll().catch(() => [] as any[]),
	]);

	const copperLayers: LayerInfo[] = [];
	for (const l of layers) {
		if (isCopperLayer(l.id as number)) {
			copperLayers.push({ id: l.id as number, name: l.name, type: l.type as string });
		}
	}
	copperLayers.sort((a, b) => a.id - b.id);

	// Board outline from polylines on layer 11
	const boardOutline: BoardOutlineSeg[] = [];
	if (polylines.length > 0) {
		for (const polyline of polylines) {
			try {
				const polygon = polyline.getState_Polygon();
				const source = polygon.getSource();
				const sources: (number | string)[][] = Array.isArray(source) && source.length > 0 && Array.isArray(source[0])
					? source as (number | string)[][]
					: [source as (number | string)[]];

				for (const src of sources) {
					const pts = parseSourceToPoints(src);
					for (let i = 0; i < pts.length - 1; i++) {
						boardOutline.push({
							x1: pts[i].x, y1: pts[i].y,
							x2: pts[i + 1].x, y2: pts[i + 1].y,
						});
					}
				}
			}
			catch { /* skip */ }
		}
	}

	// Fallback: if no polyline outline found, try fills/regions on layer 11
	if (boardOutline.length === 0) {
		try {
			const fills = await (eda as any).pcb_PrimitiveFill.getAll(LAYER_BOARD_OUTLINE);
			for (const fill of fills || []) {
				try {
					const complexPolygon = fill.getState_ComplexPolygon();
					const source = complexPolygon.getSource?.();
					if (!source) continue;
					const sources: (number | string)[][] = Array.isArray(source) && source.length > 0 && Array.isArray(source[0])
						? source as (number | string)[][]
						: [source as (number | string)[]];
					for (const src of sources) {
						const pts = parseSourceToPoints(src);
						for (let i = 0; i < pts.length - 1; i++) {
							boardOutline.push({
								x1: pts[i].x, y1: pts[i].y,
								x2: pts[i + 1].x, y2: pts[i + 1].y,
							});
						}
					}
				}
				catch { /* skip */ }
			}
		}
		catch { /* skip */ }
	}

	// Last resort: use lines on layer 11
	if (boardOutline.length === 0) {
		for (const line of boardLines) {
			try {
				const layer = (line.getState_Layer as any) ? line.getState_Layer() as number : 0;
				if (layer === LAYER_BOARD_OUTLINE) {
					boardOutline.push({
						x1: line.getState_StartX(), y1: line.getState_StartY(),
						x2: line.getState_EndX(), y2: line.getState_EndY(),
					});
				}
			}
			catch { /* skip */ }
		}
	}

	// Board-level silkscreen lines (for components without footprint data)
	const boardSilkscreenTop: BoardOutlineSeg[] = [];
	const boardSilkscreenBottom: BoardOutlineSeg[] = [];
	for (const line of boardLines) {
		try {
			const layer = (line.getState_Layer as any) ? line.getState_Layer() as number : 0;
			if (layer === LAYER_SILKSCREEN_TOP || layer === LAYER_SILKSCREEN_BOTTOM) {
				const seg: BoardOutlineSeg = {
					x1: line.getState_StartX(), y1: line.getState_StartY(),
					x2: line.getState_EndX(), y2: line.getState_EndY(),
				};
				if (layer === LAYER_SILKSCREEN_TOP) boardSilkscreenTop.push(seg);
				else boardSilkscreenBottom.push(seg);
			}
		}
		catch { /* skip */ }
	}

	const footprintCache = new Map<string, FootprintData | null>();
	const components: ComponentInfo[] = [];

	for (const comp of allComponents) {
		try {
		const fpData = await getFootprintData(comp, footprintCache);
		const otherProps = comp.getState_OtherProperty?.() || {};
		const rawName = String(comp.getState_Name() || '');
		const safeName = rawName.startsWith('={') ? '' : rawName;
		const deviceName = String(otherProps.Device || otherProps.Description || otherProps.device || otherProps.title || safeName || 'Unknown');
		const rawValue = String(otherProps.Value || '');
		const compValue = rawValue.startsWith('={') ? '' : rawValue;
		const compId = comp.getState_PrimitiveId();

		// Collect attributes (refdes, value, etc.) belonging to this component
		const attrs: ComponentAttribute[] = [];
		for (const attr of allAttributes) {
			try {
				if (attr.getState_ParentPrimitiveId?.() !== compId) continue;
				attrs.push({
					key: attr.getState_Key?.() || '',
					value: attr.getState_Value?.() || '',
					x: attr.getState_X?.() ?? 0,
					y: attr.getState_Y?.() ?? 0,
					rotation: attr.getState_Rotation?.() ?? 0,
					fontSize: attr.getState_FontSize?.() ?? 50,
					mirror: attr.getState_Mirror?.() ?? false,
					layer: attr.getState_Layer?.() ?? 0,
				});
			}
			catch { /* skip */ }
		}

		components.push({
			primitiveId: compId,
			designator: comp.getState_Designator() || '',
			name: deviceName,
			value: compValue,
			x: comp.getState_X(),
			y: comp.getState_Y(),
			rotation: comp.getState_Rotation(), // RADIANS
			layer: comp.getState_Layer() as number,
			pads: comp.getState_Pads() || [],
			footprintData: fpData,
			attributes: attrs,
		});
		_gcLog('[GC] Comp:', comp.getState_Designator(), 'name:', deviceName, 'fpPads:', fpData?.pads.length || 0, 'fpOutlines:', fpData?.outlines.length || 0, 'attrs:', attrs.length, 'pcbPads:', (comp.getState_Pads() || []).length);
		} catch(compErr: any) {
			_gcLog('[GC] Comp error:', comp.getState_Designator ? comp.getState_Designator() : "?", compErr?.message || compErr);
		}
	}

	const padStacks: PadStackEntry[] = [];
	const padExports: PadExportInfo[] = [];
	let padGlobalIdx = 0;

	function findOrAddPadStack(shape: string, w: number, h: number, drill: number, layers: number[], isThrough: boolean): number {
		const key = padStackKey(shape, w, h, drill, isThrough);
		for (const ps of padStacks) {
			if (padStackKey(ps.shape, ps.width, ps.height, ps.drill, ps.isThrough) === key) {
				return ps.id;
			}
		}
		const id = padStacks.length;
		padStacks.push({ id, shape, width: w, height: h, drill, layers, isThrough });
		return id;
	}

	for (const comp of components) {
		if (!comp.designator) continue;
		const cosA = Math.cos(comp.rotation * Math.PI / 180);
		const sinA = Math.sin(comp.rotation * Math.PI / 180);

		if (comp.footprintData && comp.footprintData.pads.length > 0) {
			_gcLog('[GC] Using footprint pads for:', comp.designator, 'count:', comp.footprintData.pads.length);
			for (const fpPad of comp.footprintData.pads) {
				_gcLog('[GC]   Pad:', fpPad.padNumber, 'shape:', fpPad.shape, 'w:', fpPad.width, 'h:', fpPad.height, 'drill:', fpPad.holeDiameter, 'pos:', fpPad.x, fpPad.y, 'rot:', fpPad.rotation);
				const isThrough = fpPad.holeDiameter > 0;
				const psLayers = isThrough ? copperLayers.map(l => l.id) : [comp.layer];
				const psId = findOrAddPadStack(
					fpPad.shape, fpPad.width, fpPad.height, fpPad.holeDiameter,
					psLayers, isThrough,
				);
				const pid = padGlobalIdx++;

				let net = '';
				const matchPad = comp.pads.find(p => p.padNumber === fpPad.padNumber);
				if (matchPad) net = matchPad.net || '';

				// Transform footprint local coords to PCB absolute coords
				const absX = comp.x + fpPad.x * cosA - fpPad.y * sinA;
				const absY = comp.y + fpPad.x * sinA + fpPad.y * cosA;

				padExports.push({
					x: absX, y: absY, net,
					ref: comp.designator,
					padNumber: fpPad.padNumber || '1',
					padStackId: psId, padId: pid,
				});
			}
		}
		else {
			_gcLog('[GC] Using PCB pad API fallback for:', comp.designator, 'pads:', comp.pads.length);
			for (const padInfo of comp.pads) {
				const pcbPad = allPads.find(p => p.getState_PrimitiveId() === comp.primitiveId + padInfo.primitiveId);
				if (!pcbPad) continue;

				const rawShape = pcbPad.getState_Pad?.();
				_gcLog('[GC]   RawPad:', JSON.stringify(rawShape), 'rawHole:', JSON.stringify(pcbPad.getState_Hole?.()));
				const { shape, width, height } = parsePadShape(rawShape);
				const rawHole = pcbPad.getState_Hole?.();
				const drill = parseHole(rawHole);
				_gcLog('[GC]   Parsed:', shape, 'w:', width, 'h:', height, 'drill:', drill);
				const isThrough = drill > 0;
				const layerId = pcbPad.getState_Layer() as number;
				const psLayers = isThrough ? copperLayers.map(l => l.id) : [layerId];

				const psId = findOrAddPadStack(shape, width, height, drill, psLayers, isThrough);
				const pid = padGlobalIdx++;

				const net = pcbPad.getState_Net?.() || padInfo.net || '';

				padExports.push({
					x: pcbPad.getState_X(), y: pcbPad.getState_Y(), net,
					ref: comp.designator,
					padNumber: padInfo.padNumber || '1',
					padStackId: psId, padId: pid,
				});
			}
		}
	}

	// Free pads (not belonging to any component)
	const compPadIds = new Set<string>();
	for (const comp of components) {
		for (const padInfo of comp.pads) {
			compPadIds.add(comp.primitiveId + padInfo.primitiveId);
		}
	}
	const freePads: PadExportInfo[] = [];
	for (const pcbPad of allPads) {
		const padId = pcbPad.getState_PrimitiveId();
		if (compPadIds.has(padId)) continue;
		try {
			const rawShape = pcbPad.getState_Pad?.();
			const { shape, width, height } = parsePadShape(rawShape);
			const rawHole = pcbPad.getState_Hole?.();
			const drill = parseHole(rawHole);
			const isThrough = drill > 0;
			const layerId = pcbPad.getState_Layer() as number;
			const psLayers = isThrough ? copperLayers.map(l => l.id) : [layerId];
			const psId = findOrAddPadStack(shape, width, height, drill, psLayers, isThrough);
			const pid = padGlobalIdx++;
			const net = pcbPad.getState_Net?.() || '';
			freePads.push({
				x: pcbPad.getState_X(), y: pcbPad.getState_Y(), net,
				ref: '',
				padNumber: '1',
				padStackId: psId, padId: pid,
			});
		} catch { /* skip */ }
	}

	const vias: ViaInfo[] = [];
	for (const via of allVias) {
		const diameter = via.getState_Diameter();
		const holeDiameter = via.getState_HoleDiameter();
		const psId = findOrAddPadStack('ELLIPSE', diameter, diameter, holeDiameter, copperLayers.map(l => l.id), true);
		vias.push({
			primitiveId: via.getState_PrimitiveId(),
			x: via.getState_X(), y: via.getState_Y(),
			net: via.getState_Net(), diameter, holeDiameter, padStackId: psId,
		});
	}

	const traces: TraceInfo[] = [];
	for (const line of boardLines) {
		try {
			const layer = (line.getState_Layer as any) ? line.getState_Layer() as number : 0;
			if (!isCopperLayer(layer)) continue;
			traces.push({
				net: line.getState_Net() || '',
				layer,
				startX: line.getState_StartX(), startY: line.getState_StartY(),
				endX: line.getState_EndX(), endY: line.getState_EndY(),
				width: line.getState_LineWidth(),
			});
		}
		catch { /* skip */ }
	}

	return {
		copperLayers, nets, components, vias, traces, padStacks, padExports, freePads,
		boardOutline, boardSilkscreenTop, boardSilkscreenBottom,
	};
}

function generateGencadContent(data: Awaited<ReturnType<typeof collectBoardData>>): string {
	const { copperLayers, nets, components, vias, traces, padStacks, padExports, freePads,
		boardOutline, boardSilkscreenTop, boardSilkscreenBottom } = data;
	const out: string[] = [];

	const trackMap = new Map<number, string>();
	function getTrackName(width: number): string {
		if (!trackMap.has(width)) trackMap.set(width, `trk${trackMap.size}`);
		return trackMap.get(width)!;
	}
	for (const tr of traces) getTrackName(tr.width);

	// ========== $HEADER ==========
	out.push('$HEADER');
	out.push('GENCAD 1.4');
	out.push('USER "EasyEDA Pro"');
	out.push('UNITS INCH');
	out.push('ORIGIN 0 0');
	out.push('INTERTRACK 0');
	out.push('$ENDHEADER');
	out.push('');

	// ========== $BOARD ==========
	out.push('$BOARD');
	if (boardOutline.length > 0) {
		for (const seg of boardOutline) {
			out.push(`LINE ${fmt(seg.x1)} ${fmt(seg.y1)} ${fmt(seg.x2)} ${fmt(seg.y2)}`);
		}
	}
	else {
		// Fallback: compute from component bounds
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const comp of components) {
			if (comp.x < minX) minX = comp.x;
			if (comp.x > maxX) maxX = comp.x;
			if (comp.y < minY) minY = comp.y;
			if (comp.y > maxY) maxY = comp.y;
		}
		if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 4000; maxY = 3000; }
		const m = 200;
		out.push(`LINE ${fmt(minX - m)} ${fmt(minY - m)} ${fmt(maxX + m)} ${fmt(minY - m)}`);
		out.push(`LINE ${fmt(maxX + m)} ${fmt(minY - m)} ${fmt(maxX + m)} ${fmt(maxY + m)}`);
		out.push(`LINE ${fmt(maxX + m)} ${fmt(maxY + m)} ${fmt(minX - m)} ${fmt(maxY + m)}`);
		out.push(`LINE ${fmt(minX - m)} ${fmt(maxY + m)} ${fmt(minX - m)} ${fmt(minY - m)}`);
	}
	out.push('$ENDBOARD');
	out.push('');

	// ========== Build PAD name map (unique per geometry) ==========
	// Each unique pad geometry gets a unique PAD name (P0, P1, ...)
	// Multiple padStacks with identical geometry share the same PAD
	const padNameByPsId = new Map<number, string>(); // padStackId → PAD name
	const geometryToPadName = new Map<string, string>(); // geometry key → PAD name
	let padNameIdx = 0;

	for (const ps of padStacks) {
		const geoKey = `${ps.shape}_${ps.width}_${ps.height}_${ps.drill}`;
		if (!geometryToPadName.has(geoKey)) {
			geometryToPadName.set(geoKey, `P${padNameIdx++}`);
		}
		padNameByPsId.set(ps.id, geometryToPadName.get(geoKey)!);
	}

	// ========== $PADS ==========
	out.push('$PADS');
	const emittedPadNames = new Set<string>();
	for (const ps of padStacks) {
		const padName = padNameByPsId.get(ps.id)!;
		if (emittedPadNames.has(padName)) continue;
		emittedPadNames.add(padName);

		const shape = ps.shape.toUpperCase();
		if (shape === 'RECT' || shape === 'RECTANGLE' || shape === 'ROUNDRECT') {
			out.push(`PAD ${padName} RECTANGULAR ${fmt(ps.drill)}`);
			out.push(`RECTANGLE ${fmt(-ps.width / 2)} ${fmt(-ps.height / 2)} ${fmt(ps.width)} ${fmt(ps.height)}`);
		}
		else if (shape === 'OVAL') {
			if (Math.abs(ps.width - ps.height) < 0.01) {
				out.push(`PAD ${padName} ROUND ${fmt(ps.drill)}`);
				out.push(`CIRCLE 0 0 ${fmt(ps.width / 2)}`);
			}
			else {
				out.push(`PAD ${padName} OBLONG ${fmt(ps.drill)}`);
				out.push(`RECTANGLE ${fmt(-ps.width / 2)} ${fmt(-ps.height / 2)} ${fmt(ps.width)} ${fmt(ps.height)}`);
			}
		}
		else {
			out.push(`PAD ${padName} ROUND ${fmt(ps.drill)}`);
			out.push(`CIRCLE 0 0 ${fmt(ps.width / 2)}`);
		}
	}
	out.push('$ENDPADS');
	out.push('');

	// ========== $PADSTACKS ==========
	out.push('$PADSTACKS');
	for (const ps of padStacks) {
		const padName = padNameByPsId.get(ps.id)!;
		out.push(`PADSTACK ps${ps.id} ${fmt(ps.drill)}`);
		for (const layerId of ps.layers) {
			out.push(`PAD ${padName} ${layerIdToGencad(layerId, copperLayers)} 0 0`);
		}
	}
	out.push('$ENDPADSTACKS');
	out.push('');

	// ========== $TRACKS ==========
	out.push('$TRACKS');
	for (const [width, name] of trackMap) {
		out.push(`TRACK ${name} ${fmt(width)}`);
	}
	out.push('$ENDTRACKS');
	out.push('');

	// ========== $SHAPES ==========
	out.push('$SHAPES');
	for (const comp of components) {
		if (!comp.designator) continue;
		out.push(`SHAPE "${comp.designator}"`);

		// INSERT SMD or TH based on whether any pad has a drill hole
		const compPadsForInsert = padExports.filter(p => p.ref === comp.designator);
		const isThrough = compPadsForInsert.some(p => {
			const ps = padStacks[p.padStackId];
			return ps && ps.drill > 0;
		});
		out.push(isThrough ? 'INSERT TH' : 'INSERT SMD');

		console.warn('[GC] SHAPE:', comp.designator, 'footprintOutlines:', comp.footprintData?.outlines.length || 0);

		// Silkscreen outline from footprint source
		if (comp.footprintData && comp.footprintData.outlines.length > 0) {
			let curWidth = -1;
			for (const ln of comp.footprintData.outlines) {
				if (ln.lineWidth !== curWidth) {
					curWidth = ln.lineWidth;
					out.push(`WIDTH ${fmt(curWidth)}`);
				}
				if (ln.circle) {
					out.push(`CIRCLE ${fmt(ln.circle.cx)} ${fmt(ln.circle.cy)} ${fmt(ln.circle.r)}`);
				} else if (ln.arc) {
					out.push(`ARC ${fmt(ln.x1)} ${fmt(ln.y1)} ${fmt(ln.x2)} ${fmt(ln.y2)} ${fmt(ln.arc.cx)} ${fmt(ln.arc.cy)}`);
				} else {
					out.push(`LINE ${fmt(ln.x1)} ${fmt(ln.y1)} ${fmt(ln.x2)} ${fmt(ln.y2)}`);
				}
			}
		}
		else {
			// Fallback: bounding box from pad extents
			const cosA2 = Math.cos(-comp.rotation * Math.PI / 180);
			const sinA2 = Math.sin(-comp.rotation * Math.PI / 180);
			const compPads = padExports.filter(p => p.ref === comp.designator);
			if (compPads.length > 0) {
				let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
				for (const p of compPads) {
					const dx = p.x - comp.x;
					const dy = p.y - comp.y;
					const lx = dx * cosA2 - dy * sinA2;
					const ly = dx * sinA2 + dy * cosA2;
					if (lx < pMinX) pMinX = lx;
					if (lx > pMaxX) pMaxX = lx;
					if (ly < pMinY) pMinY = ly;
					if (ly > pMaxY) pMaxY = ly;
				}
				const pad = 30;
				pMinX -= pad; pMinY -= pad; pMaxX += pad; pMaxY += pad;
				out.push(`LINE ${fmt(pMinX)} ${fmt(pMinY)} ${fmt(pMaxX)} ${fmt(pMinY)}`);
				out.push(`LINE ${fmt(pMaxX)} ${fmt(pMinY)} ${fmt(pMaxX)} ${fmt(pMaxY)}`);
				out.push(`LINE ${fmt(pMaxX)} ${fmt(pMaxY)} ${fmt(pMinX)} ${fmt(pMaxY)}`);
				out.push(`LINE ${fmt(pMinX)} ${fmt(pMaxY)} ${fmt(pMinX)} ${fmt(pMinY)}`);
			}
		}

		// Pins with local coordinates (un-rotated from PCB absolute)
		const cosA = Math.cos(-comp.rotation * Math.PI / 180);
		const sinA = Math.sin(-comp.rotation * Math.PI / 180);
		const compPads = padExports.filter(p => p.ref === comp.designator);
		for (const pad of compPads) {
			const dx = pad.x - comp.x;
			const dy = pad.y - comp.y;
			const lx = dx * cosA - dy * sinA;
			const ly = dx * sinA + dy * cosA;
			const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
			out.push(`PIN "${pad.padNumber}" ${padNameByPsId.get(pad.padStackId) || 'P0'} ${fmt(lx)} ${fmt(ly)} ${layer} 0 0`);
		}
	}

	// Free pads as virtual components
	for (let fi = 0; fi < freePads.length; fi++) {
		const fp = freePads[fi];
		const padName = padNameByPsId.get(fp.padStackId) || 'P0';
		out.push(`SHAPE "FP${fi + 1}"`);
		out.push('INSERT SMD');
		out.push(`PIN "1" ${padName} 0 0 TOP 0 0`);
	}

	out.push('$ENDSHAPES');
	out.push('');

	// ========== $COMPONENTS ==========
	out.push('$COMPONENTS');
	for (const comp of components) {
		if (!comp.designator) continue;
		const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
		const rotDeg = comp.rotation;
		out.push(`COMPONENT "${comp.designator}"`);
		out.push(`DEVICE "${comp.name}"`);
		out.push(`PLACE ${fmt(comp.x)} ${fmt(comp.y)}`);
		out.push(`LAYER ${layer}`);
		out.push(`ROTATION ${rotDeg.toFixed(2)}`);
		out.push(`SHAPE "${comp.designator}" 0 ${comp.layer === 1 ? '0' : 'FLIP'}`);


		// TEXT entries: only RefDes and Value using actual attribute positions
		// Format: TEXT x y height rotation mirror layer "text" bbox_x bbox_y bbox_w bbox_h
		const textLayer = comp.layer === 1 ? 'SILKSCREEN_TOP' : 'SILKSCREEN_BOTTOM';
		const refDesText = comp.designator;
		const valueText = comp.value;
		const sheetParts: string[] = [];

		// Find Designator attribute for position
		const desAttr = comp.attributes.find(a => a.key === 'Designator');
		if (desAttr) {
			const isAbsolute = Math.abs(desAttr.x) > 1000 || Math.abs(desAttr.y) > 1000;
			let localX: number, localY: number;
			if (isAbsolute) {
				const dx = desAttr.x - comp.x;
				const dy = desAttr.y - comp.y;
				const cosR = Math.cos(-comp.rotation * Math.PI / 180);
				const sinR = Math.sin(-comp.rotation * Math.PI / 180);
				localX = dx * cosR - dy * sinR;
				localY = dx * sinR + dy * cosR;
			} else {
				localX = desAttr.x;
				localY = desAttr.y;
			}
			const textH = 0.0393701; // 1mm standard
			const textX = mil2inch(localX);
			const textY = mil2inch(localY);
			const textW = refDesText.length * textH * 0.6;
			out.push(`TEXT ${textX.toFixed(6)} ${textY.toFixed(6)} ${textH.toFixed(6)} 0 0 ${textLayer} "${refDesText}" ${textX.toFixed(6)} ${textY.toFixed(6)} ${textW.toFixed(6)} ${textH.toFixed(6)}`);
			sheetParts.push(`RefDes: ${refDesText}`);
		} else {
			const textH = 0.0393701;
			const refW = refDesText.length * textH * 0.6;
			out.push(`TEXT 0 0.071654 ${textH.toFixed(6)} 0 0 ${textLayer} "${refDesText}" 0 0.071654 ${refW.toFixed(6)} ${textH.toFixed(6)}`);
			sheetParts.push(`RefDes: ${refDesText}`);
		}

		// Value text
		if (valueText) {
			const valAttr = comp.attributes.find(a => a.key === 'Value' || a.value === valueText);
			if (valAttr) {
				const isAbsolute = Math.abs(valAttr.x) > 1000 || Math.abs(valAttr.y) > 1000;
				let localX: number, localY: number;
				if (isAbsolute) {
					const dx = valAttr.x - comp.x;
					const dy = valAttr.y - comp.y;
					const cosR = Math.cos(-comp.rotation * Math.PI / 180);
					const sinR = Math.sin(-comp.rotation * Math.PI / 180);
					localX = dx * cosR - dy * sinR;
					localY = dx * sinR + dy * cosR;
				} else {
					localX = valAttr.x;
					localY = valAttr.y;
				}
				const textH = 0.0393701;
				const textX = mil2inch(localX);
				const textY = mil2inch(localY);
				const textW = valueText.length * textH * 0.6;
				out.push(`TEXT ${textX.toFixed(6)} ${textY.toFixed(6)} ${textH.toFixed(6)} 0 0 ${textLayer} "${valueText}" ${textX.toFixed(6)} ${textY.toFixed(6)} ${textW.toFixed(6)} ${textH.toFixed(6)}`);
			} else {
				const textH = 0.0393701;
				const valW = valueText.length * textH * 0.6;
				out.push(`TEXT 0 -0.071654 ${textH.toFixed(6)} 0 0 ${textLayer} "${valueText}" 0 -0.071654 ${valW.toFixed(6)} ${textH.toFixed(6)}`);
			}
			sheetParts.push(`Value: ${valueText}`);
		}

		if (sheetParts.length > 0) out.push(`SHEET "${sheetParts.join(', ')}"`);
	}

	// Free pads as virtual components
	for (let fi = 0; fi < freePads.length; fi++) {
		const fp = freePads[fi];
		out.push(`COMPONENT "FP${fi + 1}"`);
		out.push(`DEVICE "FreePad"`);
		out.push(`PLACE ${fmt(fp.x)} ${fmt(fp.y)}`);
		out.push('LAYER TOP');
		out.push('ROTATION 0');
		out.push(`SHAPE "FP${fi + 1}" 0 0`);
	}

	out.push("$ENDCOMPONENTS");
	out.push("");

	// ========== $DEVICES ==========
	out.push('$DEVICES');
	for (const comp of components) {
		if (!comp.designator) continue;
		out.push(`DEVICE "${comp.name}"`);
		out.push(`DESC "${comp.name}"`);
	}
	if (freePads.length > 0) {
		out.push('DEVICE "FreePad"');
		out.push('DESC "Free Pad"');
	}
	out.push('$ENDDEVICES');
	out.push('');

	// ========== $SIGNALS ==========
	out.push('$SIGNALS');
	for (const netName of nets) {
		if (!netName) continue;
		const netPins = padExports.filter(p => p.net === netName);
		const netFreePads = freePads.filter(p => p.net === netName);
		if (netPins.length === 0 && netFreePads.length === 0) continue;
		out.push(`SIGNAL "${netName}"`);
		for (const pin of netPins) {
			out.push(`NODE "${pin.ref}" "${pin.padNumber}"`);
		}
		for (const fp of netFreePads) {
			const idx = freePads.indexOf(fp);
			out.push(`NODE "FP${idx + 1}" "1"`);
		}
	}
	out.push('$ENDSIGNALS');
	out.push('');

	// ========== $ROUTES ==========
	const hasRoutes = traces.length > 0 || vias.length > 0;
	if (hasRoutes) {
		out.push('$ROUTES');
		const allNetNames = [...new Set([
			...traces.map(t => t.net),
			...vias.map(v => v.net),
		].filter(Boolean))];

		let viaIdx = 0;
		for (const netName of allNetNames) {
			out.push(`ROUTE ${netName}`);

			const netTraces = traces.filter(t => t.net === netName);
			if (netTraces.length > 0) {
				let curTrack = '';
				let curLayer = '';
				for (const trace of netTraces) {
					const trackName = getTrackName(trace.width);
					if (trackName !== curTrack) {
						out.push(`TRACK ${trackName}`);
						curTrack = trackName;
						curLayer = '';
					}
					const layerName = layerIdToGencad(trace.layer, copperLayers);
					if (layerName !== curLayer) {
						out.push(`LAYER ${layerName}`);
						curLayer = layerName;
					}
					out.push(`LINE ${fmt(trace.startX)} ${fmt(trace.startY)} ${fmt(trace.endX)} ${fmt(trace.endY)}`);
				}
			}

			const netVias = vias.filter(v => v.net === netName);
			for (const via of netVias) {
				out.push(`VIA ps${via.padStackId} ${fmt(via.x)} ${fmt(via.y)} ALL ${fmt(via.holeDiameter)} via${viaIdx++}`);
			}
		}
		out.push('$ENDROUTES');
		out.push('');
	}

	// ========== $LAYERS ==========
	out.push('$LAYERS');
	for (const cl of copperLayers) {
		const gencadName = layerIdToGencad(cl.id, copperLayers);
		out.push(`DEFINE ${gencadName} "${cl.name}"`);
	}
	out.push('$ENDLAYERS');
	out.push('');

	out.push('$END');
	return out.join('\n');
}

export async function exportGencad(): Promise<void> {
	try {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc || doc.documentType !== 3) {
			eda.sys_Dialog.showInformationMessage(
				eda.sys_I18n.text('Please open a PCB document first'),
				eda.sys_I18n.text('Export GenCAD'),
			);
			return;
		}

		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Collecting PCB data...'));

		const data = await collectBoardData();
		console.warn('[GC] Board data collected. Components:', data.components.length, 'PadExports:', data.padExports.length, 'PadStacks:', data.padStacks.length);
		const gencadContent = generateGencadContent(data);
		console.warn('[GC] GenCAD content length:', gencadContent.length);
		console.warn('[GC] GenCAD preview:', gencadContent.substring(0, 3000));

		const projectInfo = await eda.dmt_Project.getCurrentProjectInfo();
		const projectName = (projectInfo as any)?.friendlyName || (projectInfo as any)?.name || 'board';
		const fileName = `${projectName}.cad`;

		const blob = new Blob([gencadContent], { type: 'application/octet-stream' });
		await eda.sys_FileSystem.saveFile(blob, fileName);

		eda.sys_Message.showToastMessage(eda.sys_I18n.text('GenCAD export completed'));
	}
	catch (err: any) {
		eda.sys_Dialog.showInformationMessage(
			`${eda.sys_I18n.text('Export failed')}: ${err?.message || err}`,
			eda.sys_I18n.text('Export GenCAD'),
		);
	}
}
