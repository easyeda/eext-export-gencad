[简体中文](./README.md) | [English](#)

# Export GenCAD

An EasyEDA Pro extension that exports PCB designs to GenCAD (.cad) file format for PCB manufacturing and test data exchange.

## Features

- Exports PCB to GenCAD 1.4 standard format
- Parses footprint source data (elibz2/elibu format) for accurate pad geometry and silkscreen outlines
- Supports native GenCAD CIRCLE and ARC commands (not approximated with line segments)
- Handles pad rotation angles correctly
- Outputs TEXT (Designator/Value) with original PCB attributes: coordinates, rotation, mirror, font size
- Caches footprint data to avoid redundant parsing
- Exports board outline (supports Polyline, Fill, and Line sources)
- Exports pad stack definitions with automatic deduplication
- Exports complete component, pin, net, trace, and via information
- Automatic coordinate conversion: EasyEDA internal units (mil) to inches

## Usage

1. Open a PCB document in EasyEDA Pro
2. Click the PCB header menu **Export GenCAD → Export GenCAD (.cad)...**
3. The `.cad` file will be generated and downloaded automatically

## Output Format

The generated `.cad` file follows the GenCAD 1.4 format specification with the following sections:

| Section | Description |
|---------|-------------|
| `$HEADER` | Program name, version, units (INCH), origin |
| `$BOARD` | Board outline (LINE) |
| `$PADS` | Pad geometry definitions (ROUND / RECTANGULAR / OBLONG) |
| `$PADSTACKS` | Pad stack definitions with per-layer pad assignments |
| `$TRACKS` | Track width definitions |
| `$SHAPES` | Component shapes (silkscreen outline + pin locations) |
| `$COMPONENTS` | Component placement (coordinates, rotation, layer, TEXT attributes) |
| `$DEVICES` | Device type descriptions |
| `$SIGNALS` | Net connectivity (NODE) |
| `$ROUTES` | Trace routing paths and vias |
| `$LAYERS` | Copper layer definitions |
| `$END` | File terminator |

## Project Structure

```
src/
├── index.ts               # Main logic: data collection, GenCAD generation, file export
├── footprintParser.ts     # Parses elibz2/elibu footprint files (ZIP + JSON)
└── footprintExtractor.ts  # Extracts pad and silkscreen data from parsed primitives
```

## Development

```shell
npm install
npm run compile   # Compile TypeScript and bundle to dist/
npm run build     # Compile + package as .eext extension
```

Other commands:

```shell
npm run lint      # ESLint check
npm run fix       # ESLint auto-fix
```

## Tech Stack

- TypeScript
- esbuild (bundling)
- JSZip (parsing footprint ZIP archives)
- @jlceda/pro-api-types (EasyEDA Pro extension API types)

## Requirements

- Node.js >= 20.17.0
- EasyEDA Pro >= 3.2.0

## License

[Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/)
