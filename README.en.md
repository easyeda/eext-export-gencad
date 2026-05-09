[简体中文](./README.md) | [English](#)

# Export GenCAD

An EasyEDA Pro extension that exports PCB designs to GenCAD (.cad) file format for PCB manufacturing and test data exchange.

## Features

- Export board outline (BOARD OUTLINE)
- Export pad stack definitions (PADSTACK) with automatic deduplication
- Export component and pin information (COMPONENTS)
- Export net data (SIGNALS) including nodes (NODE), tracks (TRACK), and vias (VIA)
- Export track data (TRACKS) organized by layer and net
- Export via data (VIAS)
- Automatic coordinate conversion: EasyEDA internal units (mil) → inches
- Compatible with GenCAD 1.4 format

## Usage

1. Open a PCB document in EasyEDA Pro
2. Click menu **Export GenCAD → Export GenCAD (.cad)...**
3. The `.cad` file will be generated and downloaded automatically

## Output Format

The generated `.cad` file follows the GenCAD 1.4 format specification with the following sections:

| Section | Description |
|---------|-------------|
| `$HEADER` | Program name, version, units (INCH), file format |
| `$BOARD` | Board outline (LINE) |
| `$PADSTACKS` | Pad stack definitions (PAD) |
| `$COMPONENTS` | Component list (PLACE / PIN) |
| `$SIGNALS` | Net data (NODE / VIA / TRACK / ROUTE) |
| `$VIAS` | Via data |
| `$END` | File terminator |

## Development

```shell
npm install
npm run build
```

The extension package is generated at `./build/dist/export-gencad_v1.0.0.eext` and can be installed in EasyEDA Pro.

## License

[Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/)
