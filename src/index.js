/*
 * 多宫格缩略图 (Grid Sheet) — IINA 插件
 *
 * 为当前播放的视频（或任意本地视频文件）生成一张多宫格缩略图（contact sheet）。
 * 依赖 ffmpeg / ffprobe：自动在 Homebrew、~/.local/bin 等常见位置查找。
 *
 * 主要流程：
 *   1. ffprobe 读取时长、分辨率、标题；
 *   2. 按时间均匀抽帧（跳过片头片尾各 2%），每帧用 drawtext 烧录时间码；
 *   3. ffmpeg tile 滤镜拼成网格 PNG；
 *   4. 自动保存到 ~/Pictures/多宫格缩略图/，并在独立窗口中预览；
 *   5. 点击任意格子跳转到对应播放时间。
 */

const { core, event, file, global, menu, standaloneWindow, utils, console: logger } = iina;

const SAVE_DIR = "~/Pictures/多宫格缩略图";
const SETTINGS_PATH = "@data/settings.json";
const TEMP_ROOT = "@tmp/gridsheet";

const GRID_PADDING = 12;
const GRID_MARGIN = 12;
const OUTPUT_WIDTHS = [1920, 2560, 3840, 5120];


const FONT_CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/SFNS.ttf",
];

const VIDEO_EXTS = [
  "mp4", "mkv", "mov", "avi", "webm", "flv", "ts", "m4v", "mpg", "mpeg",
  "wmv", "rmvb", "rm", "3gp", "m2ts", "mts", "vob", "ogv", "divx", "asf",
];

const state = {
  cols: 4,
  rows: 3,
  ready: false,
  queue: [],
  runId: 0,
  last: null,
  ffmpeg: null,
  ffprobe: null,
  frameSet: false,
  saveToVideoDir: true,
  outputWidth: 2560,
};

function log(message) {
  try {
    logger.log("[gridsheet] " + message);
  } catch (e) {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function loadSettings() {
  try {
    if (!file.exists(SETTINGS_PATH)) return;
    const data = JSON.parse(file.read(SETTINGS_PATH));
    const cols = Number(data.cols);
    const rows = Number(data.rows);
    if (cols >= 2 && cols <= 8 && rows >= 2 && rows <= 8) {
      state.cols = cols;
      state.rows = rows;
    }
    if (typeof data.saveToVideoDir === "boolean") {
      state.saveToVideoDir = data.saveToVideoDir;
    }
    const outputWidth = Number(data.outputWidth);
    if (OUTPUT_WIDTHS.indexOf(outputWidth) >= 0) {
      state.outputWidth = outputWidth;
    }
  } catch (e) {
    log("读取设置失败：" + e);
  }
}

function saveSettings() {
  try {
    file.write(SETTINGS_PATH, JSON.stringify({
      cols: state.cols,
      rows: state.rows,
      saveToVideoDir: state.saveToVideoDir,
      outputWidth: state.outputWidth,
    }));
  } catch (e) {
    log("写入设置失败：" + e);
  }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatTime(seconds, withHours) {
  let sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0 || withHours) return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
  return pad2(m) + ":" + pad2(s);
}

function tail(text, lines) {
  if (!text) return "";
  const parts = String(text).trim().split("\n");
  return parts.slice(-(lines || 2)).join(" ").slice(0, 400);
}

function basename(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || "视频";
}

function dirname(path) {
  const value = String(path);
  const index = value.lastIndexOf("/");
  return index > 0 ? value.slice(0, index) : "/";
}

function normalizeLocalPath(url) {
  if (!url) return null;
  const raw = String(url);
  if (raw.indexOf("file://") === 0) {
    const withoutScheme = raw.replace(/^file:\/\/(localhost)?/, "");
    try {
      return decodeURIComponent(withoutScheme);
    } catch (e) {
      return withoutScheme;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null; // 网络地址
  return raw;
}

function currentVideoPath() {
  try {
    if (core.status.isNetworkResource) return null;
    return normalizeLocalPath(core.status.url);
  } catch (e) {
    return null;
  }
}

function findTool(name) {
  const dirs = [
    "@data/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.local/bin",
    "~/bin",
    "/usr/bin",
    "/bin",
  ];
  for (const dir of dirs) {
    try {
      const path = utils.resolvePath(dir + "/" + name);
      if (file.exists(path)) return path;
    } catch (e) {
      // ignore
    }
  }
  try {
    if (utils.fileInPath(name)) return name;
  } catch (e) {
    // ignore
  }
  return null;
}

function ensureTools() {
  if (!state.ffmpeg) state.ffmpeg = findTool("ffmpeg");
  if (!state.ffprobe) state.ffprobe = findTool("ffprobe");
  if (!state.ffmpeg || !state.ffprobe) {
    throw new Error(
      "找不到 ffmpeg / ffprobe。请先安装 ffmpeg（例如 brew install ffmpeg），" +
      "或把 ffmpeg 与 ffprobe 放到 ~/.local/bin/ 后重试。"
    );
  }
}

async function ensureDir(path) {
  const r = await utils.exec("/bin/mkdir", ["-p", path]);
  if (r.status !== 0) throw new Error("无法创建文件夹：" + path);
}

/* ------------------------------------------------------------------ */
/* 视频信息                                                            */
/* ------------------------------------------------------------------ */

function rotationOf(stream) {
  let rot = 0;
  if (Array.isArray(stream.side_data_list)) {
    for (const item of stream.side_data_list) {
      if (item && item.rotation != null) rot = Number(item.rotation) || 0;
    }
  }
  if (!rot && stream.tags && stream.tags.rotate) rot = Number(stream.tags.rotate) || 0;
  return rot;
}

async function probeVideo(path) {
  const result = await utils.exec(state.ffprobe, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    "-i", path,
  ]);

  if (result.status !== 0) {
    throw new Error("无法读取视频信息。" + tail(result.stderr));
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error("ffprobe 返回了无法解析的数据。");
  }

  const streams = data.streams || [];
  let video = null;
  for (const stream of streams) {
    if (stream.codec_type === "video" &&
        !(stream.disposition && stream.disposition.attached_pic)) {
      video = stream;
      break;
    }
  }
  if (!video) throw new Error("这个文件里没有视频画面。");

  let width = Number(video.width) || 0;
  let height = Number(video.height) || 0;
  const rotation = rotationOf(video);
  if (Math.abs(rotation) % 180 === 90) {
    const tmp = width;
    width = height;
    height = tmp;
  }

  const format = data.format || {};
  const duration = Number(format.duration) || Number(video.duration) || 0;
  if (!(duration > 0)) throw new Error("无法获取视频时长。");

  const tagTitle = format.tags && (format.tags.title || format.tags.TITLE);
  const title = (tagTitle && String(tagTitle).trim()) ||
    basename(path).replace(/\.[^.]+$/, "");

  const transfer = String(video.color_transfer || "").toLowerCase();
  const hdr = transfer === "smpte2084" || transfer === "arib-std-b67";

  return { duration, width, height, title, hdr };
}

/* ------------------------------------------------------------------ */
/* 取帧与拼图                                                          */
/* ------------------------------------------------------------------ */

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

function cellSize(width, height, cols, outputWidth) {
  let aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  if (!isFinite(aspect) || aspect <= 0) aspect = 16 / 9;

  const usable = outputWidth - GRID_MARGIN * 2 - GRID_PADDING * (cols - 1);
  let cw = Math.floor(usable / cols);
  cw = Math.max(240, Math.floor(cw / 2) * 2);
  let ch = Math.max(120, Math.round(cw / aspect));
  ch = Math.floor(ch / 2) * 2;

  return { cw: cw, ch: ch };
}

function computeTimes(duration, count) {
  const inset = duration > 10 ? duration * 0.02 : 0;
  const start = inset;
  const end = Math.max(start + 0.05, duration - inset);
  if (count <= 1) return [(start + end) / 2];
  const step = (end - start) / (count - 1);
  const times = [];
  for (let i = 0; i < count; i++) {
    times.push(Math.min(Math.max(0, duration - 0.05), start + step * i));
  }
  return times;
}

function pickFont() {
  for (const path of FONT_CANDIDATES) {
    try {
      if (file.exists(path)) return path;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

function escapeFilterText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

const HDR_TONEMAP = "zscale=t=linear:npl=100,format=gbrpf32le," +
  "zscale=p=bt709,tonemap=hable:desat=0," +
  "zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

function buildFilter(cw, ch, label, font, hdr) {
  const fontSize = Math.max(13, Math.round(cw / 26));
  const fontArg = font ? "fontfile=" + font + ":" : "";
  const parts = [];
  if (hdr) parts.push(HDR_TONEMAP);
  parts.push(
    "scale=" + cw + ":" + ch + ":force_original_aspect_ratio=decrease:flags=lanczos",
    "pad=" + cw + ":" + ch + ":(ow-iw)/2:(oh-ih)/2:color=0x111114",
    "drawtext=" + fontArg +
      "text='" + escapeFilterText(label) + "'" +
      ":x=w-tw-16:y=h-th-14" +
      ":fontsize=" + fontSize +
      ":fontcolor=white" +
      ":borderw=1:bordercolor=black@0.85" +
      ":box=1:boxcolor=black@0.5:boxborderw=8"
  );
  return parts.join(",");
}

async function extractOne(videoPath, time, index, dir, cw, ch, label, font, hdr) {
  const out = dir + "/f_" + String(index).padStart(3, "0") + ".png";
  const args = function (useTonemap) {
    return [
      "-hide_banner", "-loglevel", "error",
      "-ss", time.toFixed(3),
      "-i", videoPath,
      "-frames:v", "1",
      "-an", "-sn",
      "-vf", buildFilter(cw, ch, label, font, useTonemap),
      "-y", out,
    ];
  };

  let result = await utils.exec(state.ffmpeg, args(hdr));
  if (result.status !== 0 && hdr) {
    // 某些 ffmpeg 构建可能不带 zscale，降级为直接转 sRGB
    result = await utils.exec(state.ffmpeg, args(false));
  }
  if (result.status !== 0) {
    throw new Error("抽取 " + label + " 处的画面失败。" + tail(result.stderr));
  }
}

async function extractFrames(videoPath, times, cw, ch, dir, runId, emit, withHours, hdr) {
  const font = pickFont();
  const queue = times.map((time, index) => ({ time, index }));
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    while (queue.length > 0) {
      if (runId !== state.runId) return;
      const job = queue.shift();
      await extractOne(
        videoPath, job.time, job.index, dir, cw, ch,
        formatTime(job.time, withHours), font, hdr
      );
      done++;
      emit("progress", {
        done,
        total,
        phase: "正在抽取画面 " + done + " / " + total,
      });
    }
  };

  const workerCount = Math.min(3, total);
  const workers = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
}

/* ------------------------------------------------------------------ */
/* 独立窗口通信                                                        */
/* ------------------------------------------------------------------ */

function sendNow(name, data) {
  try {
    standaloneWindow.postMessage(name, data);
  } catch (e) {
    log("窗口消息发送失败：" + e);
  }
}

function send(name, data) {
  if (!state.ready) {
    state.queue.push([name, data]);
  } else {
    sendNow(name, data);
  }
}

function flushQueue() {
  const queue = state.queue.splice(0);
  for (const item of queue) sendNow(item[0], item[1]);
}

function ensureWindow() {
  state.ready = false;
  state.queue = [];
  try {
    standaloneWindow.loadFile("ui/window.html");
    // loadFile 会清空消息监听器，所以必须在加载后重新注册
    registerWindowHandlers();
    standaloneWindow.setProperty({ title: "预览", resizable: true });
    if (!state.frameSet) {
      standaloneWindow.setFrame(1180, 880);
      state.frameSet = true;
    }
    if (typeof standaloneWindow.open === "function") {
      standaloneWindow.open();
    } else if (typeof standaloneWindow.show === "function") {
      standaloneWindow.show();
    }
  } catch (e) {
    log("打开窗口失败：" + e);
    throw new Error("无法打开预览窗口：" + e);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function safeBaseName(title) {
  let base = String(title || "视频")
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) base = "视频";
  if (base.length > 60) base = base.slice(0, 60).trim();
  return base;
}

async function generate(options) {
  const opts = options || {};
  const runId = ++state.runId;
  const startedAt = Date.now();
  const videoPath = opts.path || currentVideoPath();

  if (!videoPath) {
    try { core.osd("多宫格缩略图：没有正在播放的本地视频"); } catch (e) {}
    return;
  }

  const cols = Number(opts.cols) || state.cols;
  const rows = Number(opts.rows) || state.rows;
  state.cols = cols;
  state.rows = rows;
  saveSettings();
  state.last = null;

  const emit = function (name, data) {
    if (runId === state.runId) send(name, data);
  };

  let workDir = null;
  try {
    ensureWindow();

    emit("init", {
      filePath: videoPath,
      title: basename(videoPath),
      cols,
      rows,
      phase: "正在读取视频信息…",
    });

    ensureTools();

    const info = await probeVideo(videoPath);
    if (runId !== state.runId) return;

    const canSeek = videoPath === currentVideoPath();
    const count = cols * rows;
    const times = computeTimes(info.duration, count);
    const cells = cellSize(info.width, info.height, cols, state.outputWidth);
    const sheetWidth = cols * cells.cw + (cols - 1) * GRID_PADDING + GRID_MARGIN * 2;
    const sheetHeight = rows * cells.ch + (rows - 1) * GRID_PADDING + GRID_MARGIN * 2;
    const withHours = info.duration >= 3600;
    const title = info.title || basename(videoPath);

    emit("init", {
      filePath: videoPath,
      title,
      cols,
      rows,
      phase: "正在抽取 " + count + " 帧画面…",
      duration: info.duration,
      width: info.width,
      height: info.height,
      saveToVideoDir: state.saveToVideoDir,
      outputWidth: state.outputWidth,
    });

    workDir = utils.resolvePath(TEMP_ROOT + "/run-" + runId + "-" + Date.now());
    await ensureDir(workDir);

    await extractFrames(
      videoPath, times, cells.cw, cells.ch, workDir, runId, emit, withHours, info.hdr
    );
    if (runId !== state.runId) return;

    emit("progress", {
      done: count,
      total: count,
      phase: "正在拼接网格…",
    });

    const sheetPath = workDir + "/sheet.png";
    const tile = await utils.exec(state.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-framerate", "1",
      "-start_number", "0",
      "-i", workDir + "/f_%03d.png",
      "-vf", "tile=" + cols + "x" + rows +
        ":padding=" + GRID_PADDING + ":margin=" + GRID_MARGIN + ":color=0x111114",
      "-frames:v", "1",
      "-y", sheetPath,
    ]);
    if (tile.status !== 0) {
      throw new Error("拼接缩略图失败。" + tail(tile.stderr));
    }
    if (runId !== state.runId) return;

    const fileName = safeBaseName(title) + "_grid_" + cols + "x" + rows + ".png";
    let savedPath = null;
    let saveFallback = false;

    if (state.saveToVideoDir) {
      const videoDir = dirname(videoPath);
      const candidate = videoDir + "/" + fileName;
      const result = await utils.exec("/bin/cp", ["-f", sheetPath, candidate]);
      if (result.status === 0) {
        savedPath = candidate;
      } else {
        saveFallback = true;
        log("视频目录不可写，回退到图片目录：" + tail(result.stderr));
      }
    }

    if (!savedPath) {
      const outDir = utils.resolvePath(SAVE_DIR);
      await ensureDir(outDir);
      const candidate = outDir + "/" + fileName;
      const result = await utils.exec("/bin/cp", ["-f", sheetPath, candidate]);
      if (result.status !== 0) {
        throw new Error("保存图片失败。" + tail(result.stderr));
      }
      savedPath = candidate;
    }

    let previewPath = savedPath;
    if (sheetWidth > 2600) {
      const preview = workDir + "/preview.jpg";
      const previewResult = await utils.exec(state.ffmpeg, [
        "-hide_banner", "-loglevel", "error",
        "-i", savedPath,
        "-vf", "scale=2000:-2:flags=lanczos",
        "-q:v", "3",
        "-y", preview,
      ]);
      if (previewResult.status === 0) previewPath = preview;
    }

    const base64 = await utils.exec("/usr/bin/base64", ["-i", previewPath]);
    if (base64.status !== 0) {
      throw new Error("读取生成的图片失败。" + tail(base64.stderr));
    }
    const imageMime = previewPath.endsWith(".jpg") ? "image/jpeg" : "image/png";
    if (runId !== state.runId) return;

    const elapsed = Math.round((Date.now() - startedAt) / 100) / 10;
    const meta = {
      title,
      filePath: videoPath,
      duration: info.duration,
      width: info.width,
      height: info.height,
      cols,
      rows,
      count,
      elapsed,
      canSeek,
      saveToVideoDir: state.saveToVideoDir,
      saveFallback,
      outputWidth: state.outputWidth,
      sheetWidth,
      sheetHeight,
    };

    state.last = {
      videoPath,
      savedPath,
      times,
      cols,
      rows,
      meta,
    };

    emit("render", {
      image: "data:" + imageMime + ";base64," + base64.stdout.replace(/\s+/g, ""),
      times,
      cols,
      rows,
      meta,
      savedPath,
      canSeek,
      saveToVideoDir: state.saveToVideoDir,
      outputWidth: state.outputWidth,
    });

    if (saveFallback) {
      send("toast", {
        text: "视频文件夹不可写，已保存到图片文件夹",
        kind: "error",
      });
    }

    try {
      core.osd("多宫格缩略图：已生成 " + cols + "×" + rows + " 网格");
    } catch (e) {}
    log("生成完成：" + savedPath + "（" + elapsed + "s）");

    if (workDir) {
      utils.exec("/bin/rm", ["-rf", workDir]).catch(function () {});
    }
  } catch (error) {
    if (runId !== state.runId) return;
    if (workDir) {
      utils.exec("/bin/rm", ["-rf", workDir]).catch(function () {});
    }
    const message = (error && error.message) ? error.message : String(error);
    log("生成失败：" + message);
    send("error", { message });
    try {
      core.osd("多宫格缩略图：" + message.split("\n")[0]);
    } catch (e) {}
  }
}

function generateForCurrent() {
  const path = currentVideoPath();
  if (!path) {
    try { core.osd("多宫格缩略图：请先打开一个本地视频"); } catch (e) {}
    return;
  }
  generate({ path, cols: state.cols, rows: state.rows });
}

function chooseFileAndGenerate() {
  let chosen = "";
  try {
    chosen = utils.chooseFile("选择要生成缩略图的视频", {
      allowedFileTypes: VIDEO_EXTS,
    });
  } catch (e) {
    log("选择文件失败：" + e);
  }
  if (chosen) generate({ path: chosen, cols: state.cols, rows: state.rows });
}

/* ------------------------------------------------------------------ */
/* 保存 / 复制 / 跳转                                                   */
/* ------------------------------------------------------------------ */

function appleScriptString(text) {
  return '"' + String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function saveAs() {
  if (!state.last || !state.last.savedPath) {
    send("toast", { text: "还没有可保存的图片", kind: "error" });
    return;
  }
  const source = state.last.savedPath;
  const dir = dirname(source);
  await ensureDir(dir);

  const script = [
    "set f to choose file name with prompt " +
      appleScriptString("保存多宫格缩略图") +
      " default name " + appleScriptString(basename(source)) +
      " default location (POSIX file " + appleScriptString(dir) + ")",
    "return POSIX path of f",
  ].join("\n");

  const result = await utils.exec("/usr/bin/osascript", ["-e", script]);
  if (result.status !== 0) return; // 用户取消

  const destination = result.stdout.trim();
  if (!destination) return;

  const copy = await utils.exec("/bin/cp", ["-f", source, destination]);
  if (copy.status !== 0) {
    throw new Error("写入文件失败。" + tail(copy.stderr));
  }
  state.last.savedPath = destination;
  send("saved", { path: destination });
  send("toast", { text: "已保存" });
}

async function copyImage() {
  if (!state.last || !state.last.savedPath) {
    send("toast", { text: "还没有可复制的图片", kind: "error" });
    return;
  }
  const script = "set the clipboard to (read (POSIX file " +
    appleScriptString(state.last.savedPath) + ") as «class PNGf»)";
  const result = await utils.exec("/usr/bin/osascript", ["-e", script]);
  if (result.status !== 0) {
    throw new Error("复制到剪贴板失败。" + tail(result.stderr));
  }
  send("toast", { text: "图片已复制到剪贴板" });
}

async function setSaveLocation(toVideoDir) {
  const value = !!toVideoDir;
  state.saveToVideoDir = value;
  saveSettings();
  send("toast", {
    text: value ? "以后保存到视频所在文件夹" : "以后保存到图片文件夹",
  });

  if (!state.last || !state.last.savedPath) return;

  const targetDir = value ? dirname(state.last.videoPath) : utils.resolvePath(SAVE_DIR);
  if (!value) await ensureDir(targetDir);
  const name = basename(state.last.savedPath);
  const destination = targetDir + "/" + name;

  if (destination === state.last.savedPath) {
    send("saved", { path: destination, saveToVideoDir: value });
    return;
  }

  const result = await utils.exec("/bin/cp", ["-f", state.last.savedPath, destination]);
  if (result.status !== 0) {
    if (value) {
      // 视频目录不可写：保留设置，但当前图片仍放回图片目录
      const fallbackDir = utils.resolvePath(SAVE_DIR);
      await ensureDir(fallbackDir);
      const fallback = fallbackDir + "/" + name;
      const fallbackResult = await utils.exec(
        "/bin/cp", ["-f", state.last.savedPath, fallback]
      );
      if (fallbackResult.status === 0) {
        state.last.savedPath = fallback;
        send("saved", { path: fallback, saveToVideoDir: value });
        send("toast", {
          text: "视频文件夹不可写，仍保存到图片文件夹",
          kind: "error",
        });
        return;
      }
    }
    throw new Error("无法移动保存位置。" + tail(result.stderr));
  }

  state.last.savedPath = destination;
  send("saved", { path: destination, saveToVideoDir: value });
}

function revealImage() {
  if (!state.last || !state.last.savedPath) return;
  try {
    file.showInFinder(state.last.savedPath);
  } catch (e) {
    send("toast", { text: "无法在访达中显示：" + e, kind: "error" });
  }
}

function seekTo(time) {
  if (!state.last || !state.last.meta.canSeek) {
    send("toast", { text: "该视频未在 IINA 中播放，无法跳转" });
    return;
  }
  try {
    core.seekTo(Number(time) || 0);
    send("toast", { text: "已跳转到 " + formatTime(time, state.last.meta.duration >= 3600) });
  } catch (e) {
    send("toast", { text: "跳转失败：" + e, kind: "error" });
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

function registerWindowHandlers() {

  standaloneWindow.onMessage("ready", function () {
    state.ready = true;
    flushQueue();
  });

  standaloneWindow.onMessage("regenerate", function (data) {
    if (!state.last && !currentVideoPath()) return;
    const path = state.last ? state.last.videoPath : currentVideoPath();
    generate({
      path,
      cols: (data && data.cols) || state.cols,
      rows: (data && data.rows) || state.rows,
    });
  });

  standaloneWindow.onMessage("saveAs", function () {
    saveAs().catch(function (error) {
      send("toast", { text: error.message || String(error), kind: "error" });
    });
  });

  standaloneWindow.onMessage("copy", function () {
    copyImage().catch(function (error) {
      send("toast", { text: error.message || String(error), kind: "error" });
    });
  });

  standaloneWindow.onMessage("reveal", revealImage);

  standaloneWindow.onMessage("setSaveLocation", function (data) {
    setSaveLocation(data && data.toVideoDir).catch(function (error) {
      send("toast", { text: error.message || String(error), kind: "error" });
    });
  });

  standaloneWindow.onMessage("setOutputWidth", function (data) {
    const width = Number(data && data.width);
    if (OUTPUT_WIDTHS.indexOf(width) < 0) return;
    state.outputWidth = width;
    saveSettings();
    const path = state.last ? state.last.videoPath : currentVideoPath();
    if (!path) {
      send("toast", { text: "输出宽度已设为 " + width + " px" });
      return;
    }
    generate({ path, cols: state.cols, rows: state.rows });
  });

  standaloneWindow.onMessage("seek", function (data) {
    seekTo(data && data.time);
  });

  standaloneWindow.onMessage("close", function () {
    try { standaloneWindow.close(); } catch (e) {}
  });

  standaloneWindow.onMessage("chooseFile", chooseFileAndGenerate);
}

function registerMenu() {
  menu.addItem(menu.item(
    "为当前视频生成多宫格缩略图",
    generateForCurrent,
    { keyBinding: "Ctrl+Meta+g" }
  ));
  menu.addItem(menu.item(
    "选择视频文件生成多宫格缩略图…",
    chooseFileAndGenerate
  ));
}

let autoGlobalDone = false;

function maybeAutoGenerateFromGlobal() {
  if (autoGlobalDone) return;
  try {
    if (!global || typeof global.getLabel !== "function") return;
    if (global.getLabel() !== "gridsheet-auto") return;
    if (!core.status || core.status.idle) {
      setTimeout(maybeAutoGenerateFromGlobal, 500);
      return;
    }
    autoGlobalDone = true;
    setTimeout(function () { generate({}); }, 700);
  } catch (e) {
    log("自动生成检查失败：" + e);
  }
}

loadSettings();
registerMenu();
event.on("iina.file-loaded", maybeAutoGenerateFromGlobal);
setTimeout(maybeAutoGenerateFromGlobal, 1200);
log("插件已加载");
