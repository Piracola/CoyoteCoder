# Waveforms

把自定义 DG-LAB V3 波形文件放在这个目录里，软件会自动读取。

支持 `.json` / `.txt` / `.wave` / `.waves` / `.js` 文件。推荐 JSON：

```json
{
  "name": "自定义波形",
  "waves": [
    "0A0A0A0A00000000",
    "0A0A0A0A64646464",
    "0A0A0A0A00000000"
  ]
}
```

也支持直接放 HEX 文本，每行一个 16 位 V3 波形值。

如需换到别的目录，可设置环境变量 `COYOTE_WAVEFORMS_DIR`。除本 README 和 `example.json` 外，用户导入的波形文件默认不会提交到 git。
