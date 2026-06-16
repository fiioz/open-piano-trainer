# Open Piano Trainer

一个纯前端（HTML/CSS/JS）的开源钢琴练习与识谱学习应用，支持键盘/鼠标/触摸演奏，支持导入谱面并自动播放（含倍速、暂停、轮播）。

## 功能

- 虚拟钢琴键盘：鼠标/触摸点击发声，键盘映射演奏
- 节拍器：可调 BPM
- 识谱训练：随机出题、对错统计
- 导入并播放：
  - MusicXML（.musicxml/.xml）
  - JSON（自定义 events 格式）
  - MIDI（.mid/.midi）
  - PDF（仅预览，不用于自动播放）
- 参考站点资源模式（可选）：支持从部分页面提取 SVG+MIDI+JSON 并用 SVG 谱面同步高亮（可能受 CORS 限制）

## 运行

本项目无需安装依赖，直接用本地静态服务打开即可：

```bash
python3 -m http.server 5173
```

然后在浏览器打开：

```
http://localhost:5173/
```

## 导入 JSON 格式示例

```json
{
  "title": "My Song",
  "tempoBpm": 90,
  "events": [
    { "startBeat": 0, "durationBeats": 1, "midis": [60] },
    { "startBeat": 1, "durationBeats": 1, "midis": [62] },
    { "startBeat": 2, "durationBeats": 2, "midis": [64, 67] }
  ]
}
```

## License

MIT License，详见 [LICENSE](./LICENSE)。
