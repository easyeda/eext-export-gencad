# 1.0.28

- fix: 修复多层焊盘(TH)在预览器中隐藏单层后整体消失的问题，PIN 正确引用 PADSTACK
- fix: 使用实际铜层数量输出 PADSTACK，不再输出未使用的内层
- fix: 长圆形焊盘使用 POLYGON + ARC/LINE 描述，修正圆弧方向为 CCW
- fix: 修复多层焊盘钻孔直径未正确提取的问题（elibu hole.width）
- feat: SHAPE 使用封装名而非位号，相同封装去重输出
- docs: 更新 README

# 1.0.0

初始版本，支持导出 PCB 为 GenCAD (.cad) 格式文件。
