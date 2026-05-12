[简体中文](#) | [English](./README.en.md)

# Export GenCAD

嘉立创EDA (EasyEDA) 专业版扩展 — 将 PCB 设计导出为 GenCAD (.cad) 文件格式，用于 PCB 制造和测试数据交换。

## 功能

- 导出 PCB 为 GenCAD 1.4 标准格式
- 解析封装源数据（elibz2/elibu 格式），获取精确的焊盘几何和丝印轮廓
- 支持原生 GenCAD CIRCLE 和 ARC 命令（非线段近似）
- 正确处理焊盘旋转角度
- 输出 TEXT（位号/值），保留 PCB 中的原始属性：坐标、旋转、镜像、字号
- 缓存封装数据，避免重复解析
- 导出板框轮廓（支持 Polyline、Fill、Line 多种来源）
- 导出焊盘堆叠定义，自动去重
- 导出器件、引脚、网络、走线、过孔等完整信息
- 坐标自动转换：EasyEDA 内部单位 (mil) → 英寸 (inch)

## 使用方法

1. 在嘉立创EDA专业版中打开一个 PCB 文档
2. 点击 PCB 菜单栏 **Export GenCAD → Export GenCAD (.cad)...**
3. 自动生成并下载 `.cad` 文件

## 导出格式

生成的 `.cad` 文件遵循 GenCAD 1.4 格式规范，包含以下节：

| 节 | 描述 |
|---|------|
| `$HEADER` | 程序名称、版本、单位 (INCH)、原点 |
| `$BOARD` | 板框轮廓 (LINE) |
| `$PADS` | 焊盘几何定义（ROUND / RECTANGULAR / OBLONG） |
| `$PADSTACKS` | 焊盘堆叠定义，按层分配焊盘 |
| `$TRACKS` | 走线宽度定义 |
| `$SHAPES` | 器件外形（丝印轮廓 + 引脚位置） |
| `$COMPONENTS` | 器件放置信息（坐标、旋转、层、TEXT 属性） |
| `$DEVICES` | 器件类型描述 |
| `$SIGNALS` | 网络连接关系 (NODE) |
| `$ROUTES` | 走线路径和过孔 |
| `$LAYERS` | 铜层定义 |
| `$END` | 文件结束标记 |

## 项目结构

```
src/
├── index.ts               # 主逻辑：数据采集、GenCAD 生成、文件导出
├── footprintParser.ts     # 解析 elibz2/elibu 封装文件（ZIP + JSON）
└── footprintExtractor.ts  # 从解析后的图元提取焊盘和丝印数据
```

## 开发

```shell
npm install
npm run compile   # 编译 TypeScript 并打包到 dist/
npm run build     # 编译 + 打包为 .eext 扩展包
```

其他命令：

```shell
npm run lint      # ESLint 检查
npm run fix       # ESLint 自动修复
```

## 技术栈

- TypeScript
- esbuild（打包）
- JSZip（解析封装 ZIP 文件）
- @jlceda/pro-api-types（EasyEDA Pro 扩展 API 类型）

## 环境要求

- Node.js >= 20.17.0
- EasyEDA Pro >= 3.2.0

## 开源许可

[Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/)
