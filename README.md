[简体中文](#) | [English](./README.en.md)

# Export GenCAD

嘉立创EDA (EasyEDA) 专业版扩展 — 将 PCB 设计导出为 GenCAD (.cad) 文件格式，用于 PCB 制造和测试数据交换。

## 功能

- 导出板框轮廓 (BOARD OUTLINE)
- 导出焊盘堆叠定义 (PADSTACK)，自动去重
- 导出器件及引脚信息 (COMPONENTS)
- 导出网络信息 (SIGNALS)，包含节点 (NODE)、走线 (TRACK)、过孔 (VIA)
- 导出走线数据 (TRACKS)，按层和网络组织
- 导出过孔数据 (VIAS)
- 坐标自动转换：EasyEDA 内部单位 (mil) → 英寸 (inch)
- 兼容 GenCAD 1.4 格式

## 使用方法

1. 在嘉立创EDA专业版中打开一个 PCB 文档
2. 点击菜单栏 **Export GenCAD → Export GenCAD (.cad)...**
3. 自动生成并下载 `.cad` 文件

## 导出格式

生成的 `.cad` 文件遵循 GenCAD 1.4 格式规范，包含以下节：

| 节 | 描述 |
|---|------|
| `$HEADER` | 程序名称、版本、单位 (INCH)、文件格式 |
| `$BOARD` | 板框轮廓 (LINE) |
| `$PADSTACKS` | 焊盘堆叠定义 (PAD) |
| `$COMPONENTS` | 器件列表 (PLACE / PIN) |
| `$SIGNALS` | 网络数据 (NODE / VIA / TRACK / ROUTE) |
| `$VIAS` | 过孔数据 |
| `$END` | 文件结束标记 |

## 开发

```shell
npm install
npm run build
```

生成的扩展包位于 `./build/dist/export-gencad_v1.0.0.eext`，可在嘉立创EDA专业版中安装。

## 开源许可

[Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/)
