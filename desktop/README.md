# Sidekick Desktop

Electron 桌面端：侧栏可预览本地页面，支持交互与点选。

## 离线安装包（Windows）

在能联网的电脑上构建一次，把 `desktop/dist/Sidekick-Setup-*-win-x64.exe` 拷到离线机器双击安装即可，目标机不需要 Python / Node。

```powershell
.\scripts\build-windows.bat
```

详见 [packaging/windows/README.md](../packaging/windows/README.md)。

## 启动

仓库根目录双击或运行：

```powershell
.\start-desktop.bat
```

脚本会先确保项目内 `.venv`（无则用 `uv`/`py`/`python` 创建），再安装 Python 依赖、Playwright Chromium（如缺）、desktop/ui 的 npm 包、构建 UI，最后启动 Electron。换机器只需重跑脚本，不依赖本机 conda 路径。

可选环境变量：

- `SIDEKICK_PYTHON` — 覆盖解释器（也可用 `.sidekick-python`）
- `ELECTRON_MIRROR` / `PLAYWRIGHT_DOWNLOAD_HOST` — 国内镜像（脚本已带默认 npmmirror）

## 用法

1. 侧栏 **浏览器**，或对话里对链接 **右键** / Ctrl+点击 →「在沙盒打开」
2. 地址优先用 `http://localhost:5173`（Windows 上 Vite 常只监听 IPv6）
3. **选择元素** → 点选 → 附件进对话

角标「实时」= 桌面 live；纯网页版为「截图」退化模式。

## 说明

- 后端：桌面壳自动 `python main.py serve`（8787 已有服务则复用）
- 给人看的预览走侧栏内嵌页；Agent `browser_*` 仍可用 Playwright
