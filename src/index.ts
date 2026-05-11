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

function layerIdToGencad(id: number): string {
	if (id === 1) return 'TOP';
	if (id === 2) return 'BOTTOM';
	if (id >= 3 && id <= 32) return `INNER${id - 2}`;
	return 'ALL';
}

function isCopperLayer(layerId: number): boolean {
	return layerId === 1 || layerId === 2 || (layerId >= 3 && layerId <= 32);
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

interface ComponentInfo {
	primitiveId: string;
	designator: string;
	name: string;
	x: number;
	y: number;
	rotation: number;
	layer: number;
	pads: Array<{ primitiveId: string; net: string; padNumber: string }>;
	footprintData: FootprintData | null;
}

interface PadExportInfo {
	x: number;
	y: number;
	net: string;
	ref: string;
	padNumber: string;
	padStackId: number;
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

function padStackKey(shape: string, w: number, h: number, drill: number, isThrough: boolean): string {
	return `${shape}_${w}_${h}_${drill}_${isThrough}`;
}

async function getFootprintData(comp: IPCB_PrimitiveComponent, cache: Map<string, FootprintData | null>): Promise<FootprintData | null> {
	const fpInfo = comp.getState_Footprint?.();
	if (!fpInfo || !fpInfo.uuid) return null;

	const cacheKey = fpInfo.uuid;
	if (cache.has(cacheKey)) return cache.get(cacheKey)!;

	try {
		const file = await eda.sys_FileManager.getFootprintFileByFootprintUuid(fpInfo.uuid, fpInfo.libraryUuid, 'elibz2');
		if (!file) {
			cache.set(cacheKey, null);
			return null;
		}
		const content = await parseFootprintFile(file);
		if (!content) {
			cache.set(cacheKey, null);
			return null;
		}
		const primitives = parseElibuContent(content);
		const data = extractFootprintData(primitives);
		cache.set(cacheKey, data);
		return data;
	}
	catch {
		cache.set(cacheKey, null);
		return null;
	}
}

async function collectBoardData() {
	const layers = await eda.pcb_Layer.getAllLayers();
	const nets = await eda.pcb_Net.getAllNetsName();
	const allComponents = await eda.pcb_PrimitiveComponent.getAll();
	const allVias = await eda.pcb_PrimitiveVia.getAll();
	const allLines = await eda.pcb_PrimitiveLine.getAll();
	const allPads = await eda.pcb_PrimitivePad.getAll();

	const copperLayers: LayerInfo[] = [];
	for (const l of layers) {
		if (isCopperLayer(l.id as number)) {
			copperLayers.push({ id: l.id as number, name: l.name, type: l.type as string });
		}
	}
	copperLayers.sort((a, b) => a.id - b.id);

	const footprintCache = new Map<string, FootprintData | null>();
	const components: ComponentInfo[] = [];

	for (const comp of allComponents) {
		const fpData = await getFootprintData(comp, footprintCache);
		components.push({
			primitiveId: comp.getState_PrimitiveId(),
			designator: comp.getState_Designator() || '',
			name: comp.getState_Name() || 'Unknown',
			x: comp.getState_X(),
			y: comp.getState_Y(),
			rotation: comp.getState_Rotation(),
			layer: comp.getState_Layer() as number,
			pads: comp.getState_Pads() || [],
			footprintData: fpData,
		});
	}

	const compByPrimId = new Map<string, ComponentInfo>();
	for (const comp of components) {
		compByPrimId.set(comp.primitiveId, comp);
	}

	const padStacks: PadStackEntry[] = [];
	const padExports: PadExportInfo[] = [];

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

	// Build pad exports from footprint data when available, fallback to PCB pads
	for (const comp of components) {
		if (!comp.designator) continue;

		if (comp.footprintData && comp.footprintData.pads.length > 0) {
			for (const fpPad of comp.footprintData.pads) {
				const isThrough = fpPad.holeDiameter > 0;
				const psLayers = isThrough ? copperLayers.map(l => l.id) : [comp.layer];
				const psId = findOrAddPadStack(
					fpPad.shape, fpPad.width, fpPad.height, fpPad.holeDiameter,
					psLayers, isThrough,
				);

				// Find net for this pad from component's pad list
				let net = '';
				const matchPad = comp.pads.find(p => p.padNumber === fpPad.padNumber);
				if (matchPad) net = matchPad.net || '';

				// Footprint pad coordinates are local to component origin
				const padX = comp.x + fpPad.x;
				const padY = comp.y + fpPad.y;

				padExports.push({
					x: padX,
					y: padY,
					net,
					ref: comp.designator,
					padNumber: fpPad.padNumber || '1',
					padStackId: psId,
				});
			}
		}
		else {
			// Fallback: use PCB-level pad data
			for (const padInfo of comp.pads) {
				const pcbPad = allPads.find(p => p.getState_PrimitiveId() === padInfo.primitiveId);
				if (!pcbPad) continue;

				const hole = pcbPad.getState_Hole();
				const drill = hole && 'diameter' in hole ? (hole as any).diameter || 0 : 0;
				const isThrough = drill > 0;
				const layerId = pcbPad.getState_Layer() as number;
				const psLayers = isThrough ? copperLayers.map(l => l.id) : [layerId];

				// Fallback shape: use a default round pad
				const psId = findOrAddPadStack('ELLIPSE', 60, 60, drill, psLayers, isThrough);

				padExports.push({
					x: pcbPad.getState_X(),
					y: pcbPad.getState_Y(),
					net: padInfo.net || '',
					ref: comp.designator,
					padNumber: padInfo.padNumber || '1',
					padStackId: psId,
				});
			}
		}
	}

	const vias: ViaInfo[] = [];
	for (const via of allVias) {
		const diameter = via.getState_Diameter();
		const holeDiameter = via.getState_HoleDiameter();
		const psId = findOrAddPadStack('ELLIPSE', diameter, diameter, holeDiameter, copperLayers.map(l => l.id), true);
		vias.push({
			primitiveId: via.getState_PrimitiveId(),
			x: via.getState_X(),
			y: via.getState_Y(),
			net: via.getState_Net(),
			diameter,
			holeDiameter,
			padStackId: psId,
		});
	}

	const traces: TraceInfo[] = [];
	for (const line of allLines) {
		traces.push({
			net: line.getState_Net(),
			layer: line.getState_Layer() as number,
			startX: line.getState_StartX(),
			startY: line.getState_StartY(),
			endX: line.getState_EndX(),
			endY: line.getState_EndY(),
			width: line.getState_LineWidth(),
		});
	}

	return { copperLayers, nets, components, vias, traces, padStacks, padExports };
}

function generateGencadContent(data: Awaited<ReturnType<typeof collectBoardData>>): string {
	const { copperLayers, nets, components, vias, traces, padStacks, padExports } = data;
	const out: string[] = [];

	// Track width registry
	const trackMap = new Map<number, string>();
	function getTrackName(width: number): string {
		if (!trackMap.has(width)) {
			trackMap.set(width, `trk${trackMap.size}`);
		}
		return trackMap.get(width)!;
	}
	for (const tr of traces) {
		getTrackName(tr.width);
	}

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
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const comp of components) {
		if (comp.x < minX) minX = comp.x;
		if (comp.x > maxX) maxX = comp.x;
		if (comp.y < minY) minY = comp.y;
		if (comp.y > maxY) maxY = comp.y;
	}
	if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 4000; maxY = 3000; }
	const m = 200;
	out.push(`LINE ${fmt(minX - m)} ${fmt(-(minY - m))} ${fmt(maxX + m)} ${fmt(-(minY - m))}`);
	out.push(`LINE ${fmt(maxX + m)} ${fmt(-(minY - m))} ${fmt(maxX + m)} ${fmt(-(maxY + m))}`);
	out.push(`LINE ${fmt(maxX + m)} ${fmt(-(maxY + m))} ${fmt(minX - m)} ${fmt(-(maxY + m))}`);
	out.push(`LINE ${fmt(minX - m)} ${fmt(-(maxY + m))} ${fmt(minX - m)} ${fmt(-(minY - m))}`);
	out.push('$ENDBOARD');
	out.push('');

	// ========== $PADS ==========
	out.push('$PADS');
	const padDefs = new Map<number, boolean>();
	for (const ps of padStacks) {
		if (padDefs.has(ps.id)) continue;
		padDefs.set(ps.id, true);

		const shape = ps.shape.toUpperCase();
		if (shape === 'RECT' || shape === 'RECTANGLE' || shape === 'ROUNDRECT') {
			out.push(`PAD pad${ps.id} RECTANGULAR 0`);
			out.push(`RECTANGLE ${fmt(-ps.width / 2)} ${fmt(-ps.height / 2)} ${fmt(ps.width)} ${fmt(ps.height)}`);
		}
		else if (shape === 'OVAL') {
			out.push(`PAD pad${ps.id} ROUND 0`);
			out.push(`CIRCLE 0 0 ${fmt(Math.max(ps.width, ps.height) / 2)}`);
		}
		else {
			// ELLIPSE, NGON, or default → round
			out.push(`PAD pad${ps.id} ROUND 0`);
			out.push(`CIRCLE 0 0 ${fmt(ps.width / 2)}`);
		}
	}
	out.push('$ENDPADS');
	out.push('');

	// ========== $PADSTACKS ==========
	out.push('$PADSTACKS');
	for (const ps of padStacks) {
		out.push(`PADSTACK ps${ps.id} ${fmt(ps.drill)}`);
		for (const layerId of ps.layers) {
			out.push(`PAD pad${ps.id} ${layerIdToGencad(layerId)} 0 0`);
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
		out.push(`SHAPE shape_${comp.designator}`);

		// Silkscreen outline from footprint source
		if (comp.footprintData && comp.footprintData.outlines.length > 0) {
			for (const ln of comp.footprintData.outlines) {
				out.push(`LINE ${fmt(ln.x1)} ${fmt(-ln.y1)} ${fmt(ln.x2)} ${fmt(-ln.y2)}`);
			}
		}
		else {
			// Fallback: simple box from pad extents
			const compPads = padExports.filter(p => p.ref === comp.designator);
			if (compPads.length > 0) {
				let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;
				for (const p of compPads) {
					const rx = p.x - comp.x;
					const ry = p.y - comp.y;
					if (rx < pMinX) pMinX = rx;
					if (rx > pMaxX) pMaxX = rx;
					if (ry < pMinY) pMinY = ry;
					if (ry > pMaxY) pMaxY = ry;
				}
				const pad = 30;
				pMinX -= pad; pMinY -= pad; pMaxX += pad; pMaxY += pad;
				out.push(`LINE ${fmt(pMinX)} ${fmt(-pMinY)} ${fmt(pMaxX)} ${fmt(-pMinY)}`);
				out.push(`LINE ${fmt(pMaxX)} ${fmt(-pMinY)} ${fmt(pMaxX)} ${fmt(-pMaxY)}`);
				out.push(`LINE ${fmt(pMaxX)} ${fmt(-pMaxY)} ${fmt(pMinX)} ${fmt(-pMaxY)}`);
				out.push(`LINE ${fmt(pMinX)} ${fmt(-pMaxY)} ${fmt(pMinX)} ${fmt(-pMinY)}`);
			}
		}

		// Pins from footprint data
		if (comp.footprintData && comp.footprintData.pads.length > 0) {
			for (const fpPad of comp.footprintData.pads) {
				const compPadExport = padExports.find(p => p.ref === comp.designator && p.padNumber === fpPad.padNumber);
				if (!compPadExport) continue;
				const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
				out.push(`PIN ${fpPad.padNumber} ps${compPadExport.padStackId} ${fmt(fpPad.x)} ${fmt(-fpPad.y)} ${layer} 0 0`);
			}
		}
		else {
			const compPads = padExports.filter(p => p.ref === comp.designator);
			for (const pad of compPads) {
				const relX = pad.x - comp.x;
				const relY = pad.y - comp.y;
				const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
				out.push(`PIN ${pad.padNumber} ps${pad.padStackId} ${fmt(relX)} ${fmt(-relY)} ${layer} 0 0`);
			}
		}
	}
	out.push('$ENDSHAPES');
	out.push('');

	// ========== $COMPONENTS ==========
	out.push('$COMPONENTS');
	for (const comp of components) {
		if (!comp.designator) continue;
		const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
		out.push(`COMPONENT ${comp.designator}`);
		out.push(`DEVICE dev_${comp.designator}`);
		out.push(`PLACE ${fmt(comp.x)} ${fmt(-comp.y)}`);
		out.push(`LAYER ${layer}`);
		out.push(`ROTATION ${comp.rotation.toFixed(2)}`);
		out.push(`SHAPE shape_${comp.designator} 0 ${comp.layer === 1 ? '0' : 'FLIP'}`);
	}
	out.push('$ENDCOMPONENTS');
	out.push('');

	// ========== $DEVICES ==========
	out.push('$DEVICES');
	for (const comp of components) {
		if (!comp.designator) continue;
		out.push(`DEVICE dev_${comp.designator}`);
		out.push(`DESC "${comp.name}"`);
	}
	out.push('$ENDDEVICES');
	out.push('');

	// ========== $SIGNALS ==========
	out.push('$SIGNALS');
	for (const netName of nets) {
		if (!netName) continue;
		const netPins = padExports.filter(p => p.net === netName);
		if (netPins.length === 0) continue;
		out.push(`SIGNAL ${netName}`);
		for (const pin of netPins) {
			out.push(`NODE ${pin.ref} ${pin.padNumber}`);
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
					const layerName = layerIdToGencad(trace.layer);
					if (layerName !== curLayer) {
						out.push(`LAYER ${layerName}`);
						curLayer = layerName;
					}
					out.push(`LINE ${fmt(trace.startX)} ${fmt(-trace.startY)} ${fmt(trace.endX)} ${fmt(-trace.endY)}`);
				}
			}

			const netVias = vias.filter(v => v.net === netName);
			for (const via of netVias) {
				out.push(`VIA ps${via.padStackId} ${fmt(via.x)} ${fmt(-via.y)} ALL ${fmt(via.holeDiameter)} via${viaIdx++}`);
			}
		}
		out.push('$ENDROUTES');
		out.push('');
	}

	// ========== $LAYERS ==========
	out.push('$LAYERS');
	for (const cl of copperLayers) {
		const gencadName = layerIdToGencad(cl.id);
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
		const gencadContent = generateGencadContent(data);

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
