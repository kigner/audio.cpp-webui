# 角色与背景素材

实时场景现在按两层组合：背景由页面铺满，透明人物由 WebGL 单独绘制。桌面人物靠右、底部对齐，按可用区域等比缩放；缩小窗口或全屏时保留整张人物图，不再裁切头顶。背景的裁切不会影响人物比例。

当前素材：

- `assets/character.png`：1146 × 1372，带真实透明通道的人物图。
- `backgrounds/bedroom.png`：1672 × 941，无窗卧室、两只睡枕。
- `assets/character.json`：人物图片和可选表情素材的描述文件。
- `assets/manifest.json`：内置 imagegen 生成记录、提示词要点和表情坐标配准结果。

以后新增角色时，先制作一张头顶留有透明余量的人物 PNG，再单独制作或复用背景。人物和背景不需要相同分辨率，也不需要重新合成一张图。

最小人物描述文件只需要图片路径：

```json
{"image": "character.png", "label": "新角色"}
```

图片路径相对于该 JSON。在 `profile.js` 的 `CHARACTER_DEFAULTS` 中为角色配置独立的 `visual`（人物 JSON）和 `background`（背景图片），路径相对于 `companion/`。切换背景只需要修改 `background`。角色选项从该表生成；新增角色的参数面板缩略图目前还需同步调整 `live.css` 中的 `.character-portrait`。

两张图片足以显示静态角色。口型和眨眼另需 `faceAtlas`、`registration`，以及与人物图匹配的坐标；不能直接把小暖的表情贴到另一张脸上。当前小暖继续使用原来的九格表情图，`referenceTransform` 把原动画坐标映射到新的透明人物坐标，保留口型、眨眼、呼吸和轻微头肩动作。旧 `assets/scene.png` 仅作为原始参考保留。
