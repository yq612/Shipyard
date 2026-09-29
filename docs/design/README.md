# 磷光 Phosphor 设计体系 v1.2

终端 / CRT 风格的网页设计体系。暗色主题是老显像管，亮色主题是老液晶屏，配色参考 morphllm.com。

## 文件

| 文件 | 作用 | 新项目要不要带 |
|---|---|---|
| `phosphor.css` | 所有样式和颜色变量 | 必须 |
| `phosphor-theme.js` | 亮暗主题切换 | 必须 |
| `starter.html` | 新项目模板，head 已配好，有导航、首屏、代码块 | 复制一份开始写 |
| `phosphor-design-system.html` | 说明页：配色、字体、组件写法和使用规则 | 建议带上当参考 |

## 新建项目

1. 把 `phosphor.css`、`phosphor-theme.js`、`starter.html` 复制到新项目
2. 把 `starter.html` 改名成 `index.html`，改标题和文案
3. 需要别的组件，打开说明页照着 HTML 写法抄
4. 交给别人或 AI 搭页面时，把说明页一起给过去

## 必须遵守

- `<head>` 里的顺序不能改：主题脚本第一个，而且不加 async / defer
- 颜色只用变量，不直接写色值，换主题时色值会变
- 绿色文字和线条用 `--c-accent-ink`，`--c-accent` 只用来做填充
- 像素字的字号只用 12 的倍数：12、24、36、48、96
- 间距用 6 的倍数，不用圆角和投影

## 字体

三款字体都是在线加载的，不在这几个文件里：

- Geist Pixel、Geist Mono：Google Fonts，Vercel 出品，OFL-1.1
- 缝合像素 Fusion Pixel：ZeoSeven 免费 CDN，TakWolf 出品，OFL-1.1

ZeoSeven 的免费地址不保证一直稳定。正式上线前，建议从 https://github.com/TakWolf/fusion-pixel-font 下载 12px 简体中文版，用 cn-font-split 切分后放到自己的服务器上。10px 版本里有版权来源不明的字形，商用只用 12px。
