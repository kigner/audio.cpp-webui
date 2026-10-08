# 角色与背景素材

实时场景现在按两层组合：背景由页面铺满，透明人物由 WebGL 单独绘制。桌面人物靠右、底部对齐，按可用区域等比缩放；缩小窗口或全屏时保留整张人物图，不再裁切头顶。背景的裁切不会影响人物比例。

当前素材：

- `assets/character.png`：1146 × 1372，带真实透明通道的人物图。
- `backgrounds/bedroom-private.png`：1672 × 941，默认暖光卧室；左侧暗色留白，人物周围保留床铺、台灯和窗帘。旧版 `bedroom.png` 保留。
- `assets/character.json`：人物图片和可选表情素材的描述文件。
- `assets/manifest.json`：内置 imagegen 生成记录、提示词要点和表情坐标配准结果。
- `assets/baijie/`：白洁的人物透明图、独立九格表情、面部配准及动作区域配置；生成提示词记录在该目录的 `manifest.json`。
- `backgrounds/baijie-living-room.png`：白洁的空客厅。图中没有预制黑色遮罩，页面负责柔焦和连续渐变。

白洁与小暖共用 `character.js` 和现有音频口型分析器。素材描述中的可选 `rig` 配置定义头肩动作范围、眼唇遮罩和肤色采样点；未提供时沿用小暖的原有数值。白洁的 `sceneLayout.subjectBounds` 使用完整场景坐标，人物与背景共用缩放和位移，让手掌、坐姿及沙发在窗口变化时保持对应。角色设置和参考声音分别保存，新增角色不会改变当前角色或已有设置。

以后新增角色时，先制作一张头顶留有透明余量的人物 PNG，再单独制作或复用背景。人物和背景不需要相同分辨率，也不需要重新合成一张图。

最小人物描述文件只需要图片路径：

```json
{"image": "character.png", "label": "新角色"}
```

图片路径相对于该 JSON。在 `profile.js` 的 `CHARACTER_DEFAULTS` 中为角色配置独立的 `visual`（人物 JSON）和 `background`（背景图片），路径相对于 `companion/`。切换背景只需要修改 `background`。角色选项从该表生成；新增角色的参数面板缩略图目前还需同步调整 `live.css` 中的 `.character-portrait`。

两张图片足以显示静态角色。口型和眨眼另需 `faceAtlas`、`registration`，以及与人物图匹配的坐标；不能直接把小暖的表情贴到另一张脸上。当前小暖继续使用原来的九格表情图，`referenceTransform` 把原动画坐标映射到新的透明人物坐标，保留口型、眨眼、呼吸和轻微头肩动作。旧 `assets/scene.png` 仅作为原始参考保留。
