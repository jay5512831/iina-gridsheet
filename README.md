# GridSheet · IINA 多宫格缩略图插件

**An IINA plugin for macOS that generates multi-grid thumbnail contact sheets from the current video.**
一个运行在 [IINA](https://iina.io) 里的多宫格缩略图（contact sheet）插件：不用离开播放器，就能把视频导出成带时间码的宫格图。

![插件窗口预览](docs/preview.png)

> 这是 IINA 插件，不是独立播放器。安装后出现在 IINA 的 **插件** 菜单里。

## 功能

- **5 种网格**：3×3、4×3、4×4、5×4、6×4，窗口内随时切换并重新生成
- **时间码**：跳过片头片尾各 2%，均匀抽帧，每格烧录 `HH:MM:SS`
- **HDR tonemap**：自动识别 PQ / HLG（`smpte2084` / `arib-std-b67`），先 tonemap 再拼图
- **点击跳转**：在预览窗口点任意一格，播放器跳到对应时间
- **中文界面**：独立预览窗口，支持复制图片、在访达中显示、另存为
- **一条龙**：生成后自动保存为 PNG，并显示保存路径

## 环境要求

- macOS
- IINA **1.4+**（在 1.5.0 上实测）
- `ffmpeg` 与 `ffprobe`

```sh
brew install ffmpeg
```

插件会自动在 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/bin`、`/usr/bin` 和插件自己的 `@data/bin` 里查找，不需要手动配置路径。

## 安装

### 从 Release 安装（推荐）

1. 下载 [最新 Release](https://github.com/jay5512831/iina-gridsheet/releases) 里的 `多宫格缩略图-*.iinaplgz`
2. 双击文件，按 IINA 提示安装
3. 打开 **IINA → 设置 → 插件**，确认「多宫格缩略图」已启用，然后重启 IINA

### 从 GitHub 安装

在 IINA 的插件设置里选择从 GitHub 安装，填入：

```text
jay5512831/iina-gridsheet
```

### 从源码加载（开发）

```sh
git clone https://github.com/jay5512831/iina-gridsheet.git
/Applications/IINA.app/Contents/MacOS/iina-plugin link "$PWD/iina-gridsheet"
```

## 使用

1. 用 IINA 打开一个本地视频
2. 菜单 **插件 → 为当前视频生成多宫格缩略图**，或按 `⌘⇧G`
3. 也可以选 **插件 → 选择视频文件生成多宫格缩略图…**，不播放也能生成
4. 预览窗口里：
   - 点画面：跳到对应时间
   - 顶部切换网格：立即重新生成
   - `在访达中显示` / `复制图片` / `另存为…`
   - `Esc` 关闭窗口，`⌘S` 另存为

生成的文件默认位于：

```text
~/Pictures/多宫格缩略图/<视频标题>_<列>x<行>.png
```

> 计划在 v1.1 改为**默认保存到视频所在目录**，可在设置里切回图片目录。

## 实现方式

1. `ffprobe` 读取时长、分辨率、旋转、HDR 标记；
2. 计算 `列 × 行` 个均匀时间点（避开片头片尾各 2%）；
3. 每个时间点用 `ffmpeg -ss ... -frames:v 1` 快速抽帧，按原片比例缩放并补边，`drawtext` 烧录时间码；
4. 用 `tile` 滤镜拼成一张 PNG；
5. 保存后把 PNG 以 base64 传给 IINA 的 `standaloneWindow` 预览；
6. 点击格子时通过 `core.seekTo()` 跳转。

抽帧使用 3 个并发；HDR 片源走 `zscale + tonemap`，如果本机 ffmpeg 不带 zscale 会自动降级重试。

## 开发

```
.
├── Info.json               # IINA 插件清单
├── src/index.js            # 主逻辑
├── ui/window.template.html # 窗口模板
├── ui/window.css
├── ui/window.js
├── ui/window.html          # 构建产物（内联 CSS/JS）
├── build_ui.py             # 生成 window.html
├── tests/mock-run.js       # 无头模拟 IINA API，跑通全流程
├── tests/preview.py        # 生成窗口静态预览
├── scripts/package.sh      # 打 .iinaplgz 安装包
└── docs/preview.png
```

```sh
python3 build_ui.py                 # 重新生成 ui/window.html
node tests/mock-run.js              # 抽帧 → 拼图 → 保存 → 消息 全流程测试
./scripts/package.sh                # 输出 dist/多宫格缩略图-<version>.iinaplgz
```

调试提示：`standaloneWindow.loadFile()` 会清空通过 `onMessage` 注册的监听器，因此本插件在每次 `loadFile` 之后重新注册监听器（见 `src/index.js` 的 `ensureWindow`）。

## 参考与致谢

本项目的实现代码为原创，**没有复制下列项目的代码**；仅在功能定位和交互上做了参考：

- **[ThumbnailGridStudio](https://github.com/leiweibau/ThumbnailGridStudio)**（leiweibau）——
  参考了「把视频导出为多宫格联系表」的产品思路。本项目通过 ffmpeg + IINA Plugin API 重新实现。
- **PotPlayer** 的「创建缩略图」对话框（Windows）——
  参考了设置项的组织方式（宫格、宽度、边距、保存位置等），用作后续设置面板的交互参考；未使用其代码。
- **[IINA Plugin API 文档](https://docs.iina.io/)** 与 `iina-plugin` 工具链。

## Roadmap

- **v1.1**：默认保存到视频所在目录；保存位置可配置；无写权限时回退到图片目录
- **v1.2**：PotPlayer 风格设置面板（`Alt+N`）：列/行、单格宽度、边距、JPEG/PNG、质量、字体、显示信息
- **v1.3**：批量处理文件夹、侧边栏常驻缩略图

## License

[MIT](LICENSE) © 2026 jay5512831
