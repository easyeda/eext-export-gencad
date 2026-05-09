import * as extensionConfig from '../extension.json';

export function activate(_status?: 'onStartupFinished', _arg?: string): void {}

// EasyEDA PCB unit is 1mil. GenCAD uses inches.
function mil2inch(mil: number): number {
	return mil / 1000.0;
}

function fmtInch(mil: number): string {
	return mil2inch(mil).toFixed(6);
}

interface LayerInfo {
	id: number;
	name: string;
	type: string;
}

interface PadStackEntry {
	id: number;
	shapeId: number;
	sx: number;
	sy: number;
	angle: number;
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

interface ViaInfo {
	primitiveId: string;
	x: number;
	y: number;
	net: string;
	diameter: number;
	holeDiameter: number;
	padStackId: number;
}

interface PadExportInfo {
	x: number;
	y: number;
	net: string;
	ref: string;
	padNumber: string;
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

function isCopperLayer(layer: LayerInfo): boolean {
	return layer.id === 1 || layer.id === 2 || (layer.id >= 3 && layer.id <= 32);
}

function sanitizeLayerName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 20);
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
		const info: LayerInfo = {
			id: l.id as number,
			name: l.name,
			type: l.type as string,
		};
		if (isCopperLayer(info)) {
			copperLayers.push(info);
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

	function findOrAddPadStack(entry: Omit<PadStackEntry, 'id'>): number {
		for (const ps of padStacks) {
			if (ps.shapeId === entry.shapeId
				&& ps.sx === entry.sx && ps.sy === entry.sy
				&& ps.drill === entry.drill && ps.angle === entry.angle
				&& ps.isThrough === entry.isThrough) {
				return ps.id;
			}
		}
		const id = padStacks.length;
		padStacks.push({ ...entry, id });
		return id;
	}

	for (const pad of allPads) {
		const padShape = pad.getState_Pad();
		let sx = 0;
		let sy = 0;
		let shapeId = 0; // 0=round/oval, 1=rect, 2=roundrect
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
			else if (shapeType === 'ROUNDRECT') shapeId = 2;
			else shapeId = 0;
		}
		const hole = pad.getState_Hole();
		let drill = 0;
		if (hole && 'diameter' in hole) {
			drill = (hole as any).diameter || 0;
		}
		const rotation = pad.getState_Rotation() || 0;
		const angle = 180.0 - rotation < 0 ? 180.0 - rotation + 360.0 : 180.0 - rotation;
		const layerId = pad.getState_Layer() as number;
		const isThrough = drill > 0;

		const psId = findOrAddPadStack({
			shapeId,
			sx,
			sy,
			angle,
			drill,
			layers: isThrough ? copperLayers.map(l => l.id) : [layerId],
			isThrough,
		});

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
		const psId = findOrAddPadStack({
			shapeId: 0,
			sx: diameter,
			sy: diameter,
			angle: 0,
			drill: holeDiameter,
			layers: copperLayers.map(l => l.id),
			isThrough: true,
		});
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
	const lines: string[] = [];

	// $HEADER
	lines.push('$HEADER');
	lines.push('PROGRAM "EasyEDA Pro" "1.0"');
	lines.push('UNITS INCH');
	lines.push('FILEFORMAT "GENCAD 1.4"');
	lines.push('$ENDHEADER');
	lines.push('');

	// $BOARD
	lines.push('$BOARD');
	lines.push('$OUTLINE');
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const comp of components) {
		if (comp.x < minX) minX = comp.x;
		if (comp.x > maxX) maxX = comp.x;
		if (comp.y < minY) minY = comp.y;
		if (comp.y > maxY) maxY = comp.y;
	}
	if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 4000; maxY = 3000; }
	const margin = 200;
	const bx1 = minX - margin, by1 = minY - margin;
	const bx2 = maxX + margin, by2 = maxY + margin;
	lines.push(`LINE ${fmtInch(bx1)} ${fmtInch(-by1)} ${fmtInch(bx2)} ${fmtInch(-by1)}`);
	lines.push(`LINE ${fmtInch(bx2)} ${fmtInch(-by1)} ${fmtInch(bx2)} ${fmtInch(-by2)}`);
	lines.push(`LINE ${fmtInch(bx2)} ${fmtInch(-by2)} ${fmtInch(bx1)} ${fmtInch(-by2)}`);
	lines.push(`LINE ${fmtInch(bx1)} ${fmtInch(-by2)} ${fmtInch(bx1)} ${fmtInch(-by1)}`);
	lines.push('$ENDOUTLINE');
	lines.push('$ENDBOARD');
	lines.push('');

	// $PADSTACKS
	lines.push('$PADSTACKS');
	for (const ps of padStacks) {
		const shapeName = ps.shapeId === 1 ? 'RECTANGLE' : ps.shapeId === 2 ? 'ROUNDRECT' : 'ROUND';
		lines.push(`PADSTACK "PS_${ps.id}" ${mil2inch(ps.drill).toFixed(6)}`);
		for (const layerId of ps.layers) {
			const layer = copperLayers.find(l => l.id === layerId);
			if (!layer) continue;
			const layerName = sanitizeLayerName(layer.name);
			if (ps.sx === ps.sy) {
				lines.push(`PAD ${shapeName} ${mil2inch(ps.sx).toFixed(6)} "${layerName}"`);
			}
			else {
				lines.push(`PAD ${shapeName} ${mil2inch(ps.sx).toFixed(6)} ${mil2inch(ps.sy).toFixed(6)} "${layerName}"`);
			}
		}
		lines.push('END_PADSTACK');
	}
	lines.push('$ENDPADSTACKS');
	lines.push('');

	// $COMPONENTS
	lines.push('$COMPONENTS');
	for (const comp of components) {
		if (!comp.designator) continue;
		const side = comp.layer === 1 ? 'TOP' : 'BOTTOM';
		lines.push(`COMPONENT "${comp.designator}"`);
		lines.push(`PLACE ${fmtInch(comp.x)} ${fmtInch(-comp.y)} ${side} ${comp.rotation.toFixed(2)}`);
		const compPads = padExports.filter(p => p.ref === comp.designator);
		for (const pad of compPads) {
			lines.push(`PIN "${pad.padNumber}" "PS_${pad.padStackId}" ${fmtInch(pad.x)} ${fmtInch(-pad.y)}`);
		}
		lines.push('END_COMP');
	}
	lines.push('$ENDCOMPONENTS');
	lines.push('');

	// $SIGNALS
	lines.push('$SIGNALS');
	for (const netName of nets) {
		if (!netName) continue;

		const netPins = padExports.filter(p => p.net === netName);
		const netVias = vias.filter(v => v.net === netName);
		const netTraces = traces.filter(t => t.net === netName);

		if (netPins.length === 0 && netVias.length === 0 && netTraces.length === 0) continue;

		lines.push(`SIGNAL "${netName}"`);

		for (const pin of netPins) {
			lines.push(`NODE "${pin.ref}.${pin.padNumber}"`);
		}

		for (const via of netVias) {
			lines.push(`VIA "PS_${via.padStackId}" ${fmtInch(via.x)} ${fmtInch(-via.y)}`);
		}

		for (const trace of netTraces) {
			const layer = copperLayers.find(l => l.id === trace.layer);
			if (!layer) continue;
			const layerName = sanitizeLayerName(layer.name);
			lines.push(`TRACK "${layerName}" ${fmtInch(trace.width)}`);
			lines.push(`ROUTE ${fmtInch(trace.startX)} ${fmtInch(-trace.startY)} ${fmtInch(trace.endX)} ${fmtInch(-trace.endY)}`);
			lines.push('END_TRACK');
		}

		lines.push('END_SIG');
	}
	lines.push('$ENDSIGNALS');
	lines.push('');

	// $VIAS
	const viasWithNet = vias.filter(v => v.net);
	if (viasWithNet.length > 0) {
		lines.push('$VIAS');
		for (const via of viasWithNet) {
			const topLayer = copperLayers[0] ? sanitizeLayerName(copperLayers[0].name) : 'Top';
			const botLayer = copperLayers[copperLayers.length - 1] ? sanitizeLayerName(copperLayers[copperLayers.length - 1].name) : 'Bottom';
			lines.push(`VIA "PS_${via.padStackId}" ${fmtInch(via.x)} ${fmtInch(-via.y)} SIGNAL "${via.net}" ${topLayer} ${botLayer}`);
		}
		lines.push('$ENDVIAS');
		lines.push('');
	}

	lines.push('$END');
	return lines.join('\n');
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
