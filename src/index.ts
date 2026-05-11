import * as extensionConfig from '../extension.json';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

// EasyEDA PCB unit is 1mil. GenCAD uses inches.
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
	shapeId: number; // 0=round, 1=rect
	sx: number; // width or diameter in mil
	sy: number; // height in mil
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

	const components: ComponentInfo[] = [];
	for (const comp of allComponents) {
		components.push({
			primitiveId: comp.getState_PrimitiveId(),
			designator: comp.getState_Designator() || '',
			name: comp.getState_Name() || 'Unknown',
			x: comp.getState_X(),
			y: comp.getState_Y(),
			rotation: comp.getState_Rotation(),
			layer: comp.getState_Layer() as number,
			pads: comp.getState_Pads() || [],
		});
	}

	const padStacks: PadStackEntry[] = [];
	const padExports: PadExportInfo[] = [];

	function findOrAddPadStack(shapeId: number, sx: number, sy: number, drill: number, layers: number[], isThrough: boolean): number {
		for (const ps of padStacks) {
			if (ps.shapeId === shapeId && ps.sx === sx && ps.sy === sy && ps.drill === drill && ps.isThrough === isThrough) {
				return ps.id;
			}
		}
		const id = padStacks.length;
		padStacks.push({ id, shapeId, sx, sy, drill, layers, isThrough });
		return id;
	}

	for (const pad of allPads) {
		const padShape = pad.getState_Pad();
		let sx = 0;
		let sy = 0;
		let shapeId = 0;
		if (padShape) {
			if ('width' in padShape && 'height' in padShape) {
				sx = (padShape as any).width || 0;
				sy = (padShape as any).height || 0;
			}
			else if ('diameter' in padShape) {
				sx = (padShape as any).diameter || 0;
				sy = sx;
			}
			const shapeType = ((padShape as any).shape || (padShape as any).type || '').toUpperCase();
			if (shapeType === 'RECT' || shapeType === 'RECTANGLE') shapeId = 1;
			else shapeId = 0;
		}
		const hole = pad.getState_Hole();
		const drill = hole && 'diameter' in hole ? (hole as any).diameter || 0 : 0;
		const layerId = pad.getState_Layer() as number;
		const isThrough = drill > 0;

		const psId = findOrAddPadStack(
			shapeId, sx, sy, drill,
			isThrough ? copperLayers.map(l => l.id) : [layerId],
			isThrough,
		);

		const net = pad.getState_Net() || '';
		const parentId = (pad as any).getState_ParentPrimitiveId?.() || '';
		let ref = '';
		let padNumber = pad.getState_PadNumber() || '1';

		for (const comp of components) {
			const matchPad = comp.pads.find(p => p.primitiveId === pad.getState_PrimitiveId());
			if (matchPad) {
				ref = comp.designator || 'EMPTY';
				padNumber = matchPad.padNumber || padNumber;
				break;
			}
		}

		if (!ref && parentId) {
			const parentComp = components.find(c => c.primitiveId === parentId);
			if (parentComp) ref = parentComp.designator || 'EMPTY';
		}

		if (ref) {
			padExports.push({
				x: pad.getState_X(),
				y: pad.getState_Y(),
				net,
				ref,
				padNumber,
				padStackId: psId,
			});
		}
	}

	const vias: ViaInfo[] = [];
	for (const via of allVias) {
		const diameter = via.getState_Diameter();
		const holeDiameter = via.getState_HoleDiameter();
		const psId = findOrAddPadStack(0, diameter, diameter, holeDiameter, copperLayers.map(l => l.id), true);
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

	// Pad shape registry: (shapeId, sx, sy) -> pad name
	const padShapeMap = new Map<string, string>();
	function getPadName(shapeId: number, sx: number, sy: number): string {
		const key = `${shapeId}_${sx}_${sy}`;
		if (!padShapeMap.has(key)) {
			padShapeMap.set(key, `pad${padShapeMap.size}`);
		}
		return padShapeMap.get(key)!;
	}
	for (const ps of padStacks) {
		getPadName(ps.shapeId, ps.sx, ps.sy);
	}

	// Track width registry: width -> track name
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
	for (const [key, name] of padShapeMap) {
		const parts = key.split('_');
		const shapeId = Number(parts[0]);
		const sx = Number(parts[1]);
		const sy = Number(parts[2]);
		if (shapeId === 1) {
			out.push(`PAD ${name} RECTANGULAR 0`);
			out.push(`RECTANGLE ${fmt(-sx / 2)} ${fmt(-sy / 2)} ${fmt(sx)} ${fmt(sy)}`);
		}
		else {
			out.push(`PAD ${name} ROUND 0`);
			out.push(`CIRCLE 0 0 ${fmt(sx / 2)}`);
		}
	}
	out.push('$ENDPADS');
	out.push('');

	// ========== $PADSTACKS ==========
	out.push('$PADSTACKS');
	for (const ps of padStacks) {
		const padName = getPadName(ps.shapeId, ps.sx, ps.sy);
		out.push(`PADSTACK ps${ps.id} ${fmt(ps.drill)}`);
		for (const layerId of ps.layers) {
			out.push(`PAD ${padName} ${layerIdToGencad(layerId)} 0 0`);
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
		const compPads = padExports.filter(p => p.ref === comp.designator);
		for (const pad of compPads) {
			const relX = pad.x - comp.x;
			const relY = comp.y - pad.y;
			const layer = comp.layer === 1 ? 'TOP' : 'BOTTOM';
			out.push(`PIN ${pad.padNumber} ps${pad.padStackId} ${fmt(relX)} ${fmt(relY)} ${layer} 0 0`);
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
		if (!doc || doc.documentType !== 3 /* EDMT_EditorDocumentType.PCB */) {
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
