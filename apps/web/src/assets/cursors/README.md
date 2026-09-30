# Pixelarticons 指针

来源：[halfmage/pixelarticons](https://github.com/halfmage/pixelarticons)，作者 Gerrit Halfmann，MIT 许可见 [LICENSE.txt](./LICENSE.txt)。

- [`cursor-minimal.svg`](https://github.com/halfmage/pixelarticons/blob/master/svg/cursor-minimal.svg)：默认箭头，热点 `(6, 4)`。
- [`pointer.svg`](https://github.com/halfmage/pixelarticons/blob/master/svg/pointer.svg)：可点击元素的手形，热点 `(8, 1)`。

这两份 SVG 保持上游内容不变，画布均为 24×24。`PhosphorCursor.tsx` 在运行时把 `currentColor` 替换为 `--c-accent-ink`，并添加 `--c-screen` 底色描边，使指针在反显背景上也可辨认；不调整路径或比例。
