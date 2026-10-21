# 衣序设计板

直接打开 [index.html](index.html)，无需服务、构建或网络。默认按场景使用主题；顶部可切换全部浅色、全部深色，查看器始终深色。手机框内可滚动，其他控件为静态设计示意。

- [完整设计说明](../UI设计稿.md)：页面、状态、文案及组件规格。
- `pages.json`：35 页的目标、布局、五类状态与文案。
- `shots/`：35 张页面截图、3 张长页续屏、2 张主题对照。
- `verification.json`：实际浏览器检查结果。

使用仓库已有依赖，脚本均在本目录；不需要重装。以下命令在仓库根执行：

```sh
export PATH="$HOME/.local/share/mise/installs/node/22.23.1/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/app/.tools/browsers"
node docs/design/prepare-assets.mjs
node docs/design/build-board.mjs
node docs/design/write-pages.mjs
node docs/design/capture.mjs
```

`prepare-assets.mjs` 只读原图，生成 720px 宽、单张不超过 200 KB 的本地 JPEG。`build-board.mjs` 输出的 HTML 内嵌样式、图标和主题脚本，只通过相对路径读取图片。

`capture.mjs --check` 只检查，不更新截图；默认先用指定目录的浏览器，缺少可执行文件时复用本机 Chrome。可通过 `DESIGN_CHROME_PATH` 指向已安装的可执行文件。脚本阻断任何外部请求，并断言外部请求、控制台错误和图片失败均为零；同时检查画布尺寸、主题、横向溢出、主按钮触控高度、自动模式接手入口和版本条首屏可见性。

截图使用全新的隔离浏览器上下文，入口为本地 `file://`。本目录不连接 App 或服务端，不验证真实生成、账号提交、相册权限、系统通知和分享面板；这些行为由完整设计说明规定，留给实现阶段验收。
