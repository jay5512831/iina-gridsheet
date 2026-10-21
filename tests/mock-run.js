/*
 * 无头测试：用 Node 模拟 IINA 插件 API，跑通「抽帧 → 拼图 → 保存 → 消息」全流程。
 * 用法：node tests/mock-run.js
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PLUGIN = ROOT;
const OUT = path.join(__dirname, "out");
const TMP = path.join(__dirname, "tmp");
const DATA = path.join(__dirname, "data");
const VIDEO = process.env.VIDEO || "/tmp/gridtest/sample.mp4";
const VIDEO_NAME = path.basename(VIDEO, path.extname(VIDEO));
const REAL_HOME = process.env.HOME || "/Users/mc";
const SAVE_DIR = "~/Pictures/多宫格缩略图";

for (const dir of [OUT, TMP, DATA]) fs.mkdirSync(dir, { recursive: true });

const lines = [];
function log(message) {
  const line = "[" + new Date().toISOString().slice(11, 19) + "] " + message;
  lines.push(line);
  console.log(line);
}

function resolvePath(p) {
  if (p === SAVE_DIR) return OUT;
  if (p.indexOf("@data") === 0) return path.join(DATA, p.slice(5));
  if (p.indexOf("@tmp") === 0) return path.join(TMP, p.slice(4));
  if (p.indexOf("~/") === 0) return path.join(REAL_HOME, p.slice(2));
  return p;
}

function run(file, args, cwd) {
  const display = file.split("/").pop() + " " + args.join(" ");
  log("exec " + (display.length > 180 ? display.slice(0, 180) + "…" : display));
  return new Promise(function (resolve) {
    execFile(file, args, { cwd: cwd, maxBuffer: 64 * 1024 * 1024 }, function (err, stdout, stderr) {
      let status = 0;
      if (err) status = typeof err.code === "number" ? err.code : -1;
      resolve({ status: status, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

let renderCount = 0;
let failCount = 0;
let lastRender = null;
const waiters = [];

const win = {
  handlers: {},
  loaded: 0,
  loadFile(file) {
    this.loaded++;
    log("window.loadFile " + file);
    const self = this;
    setTimeout(function () {
      if (self.handlers.ready) self.handlers.ready();
    }, 5);
  },
  setProperty(props) {
    log("window.setProperty " + JSON.stringify(props));
  },
  setFrame(w, h) {
    log("window.setFrame " + w + "x" + h);
  },
  open() {
    log("window.open");
  },
  close() {
    log("window.close");
  },
  postMessage(name, data) {
    if (name === "render") {
      renderCount++;
      lastRender = data;
      log("message render #" + renderCount +
        " image=" + Math.round((data.image || "").length / 1024) + "KB" +
        " saved=" + data.savedPath +
        " times=" + data.times.length);
    } else if (name === "progress") {
      log("message progress " + data.done + "/" + data.total + " " + data.phase);
    } else if (name === "init") {
      log("message init " + JSON.stringify({
        title: data.title, cols: data.cols, rows: data.rows, phase: data.phase,
      }));
    } else if (name === "error") {
      failCount++;
      log("message ERROR " + data.message);
    } else {
      log("message " + name + " " + JSON.stringify(data));
    }
    const pending = waiters.splice(0);
    pending.forEach(function (w) { w(); });
  },
  onMessage(name, callback) {
    this.handlers[name] = callback;
  },
};

const menuItems = [];
const events = {};
const coreCalls = [];

global.iina = {
  core: {
    status: {
      idle: false,
      url: "file://" + VIDEO,
      duration: 90,
      videoWidth: 1280,
      videoHeight: 720,
      isNetworkResource: false,
      position: 0,
    },
    osd(message) {
      log("osd " + message);
    },
    seekTo(time) {
      coreCalls.push(["seekTo", time]);
      log("core.seekTo " + time);
    },
  },
  event: {
    on(name, callback) {
      events[name] = callback;
      log("event.on " + name);
    },
  },
  file: {
    exists(p) {
      return fs.existsSync(resolvePath(p));
    },
    read(p) {
      return fs.readFileSync(resolvePath(p), "utf8");
    },
    write(p, content) {
      const target = resolvePath(p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    showInFinder(p) {
      coreCalls.push(["showInFinder", p]);
      log("file.showInFinder " + p);
    },
  },
  menu: {
    item(title, action, options) {
      return { title: title, action: action, options: options || {} };
    },
    addItem(item) {
      menuItems.push(item);
      log("menu.add " + item.title);
    },
  },
  standaloneWindow: win,
  utils: {
    resolvePath: resolvePath,
    exec: run,
    fileInPath() {
      return false;
    },
    chooseFile() {
      return "";
    },
  },
  console: {
    log(message) { log("plugin " + message); },
    error(message) { log("plugin ERROR " + message); },
    warn(message) { log("plugin WARN " + message); },
  },
};

function waitFor(predicate, timeoutMs, label) {
  return new Promise(function (resolve, reject) {
    const started = Date.now();
    const check = function () {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timeout: " + label));
      setTimeout(check, 100);
    };
    check();
  });
}

(async function main() {
  log("require plugin");
  require(path.join(PLUGIN, "src", "index.js"));
  log("menu items: " + menuItems.map(function (i) { return i.title; }).join(" | "));

  await new Promise(function (r) { setTimeout(r, 100); });

  menuItems[0].action();
  await waitFor(function () { return renderCount >= 1 || failCount > 0; }, 120000, "first render");

  if (failCount > 0) throw new Error("generation failed");

  const saved = lastRender.savedPath;
  if (!fs.existsSync(saved)) throw new Error("missing output " + saved);
  const stat = fs.statSync(saved);
  log("saved file " + saved + " " + Math.round(stat.size / 1024) + "KB");

  win.handlers.seek({ time: 45 });
  win.handlers.reveal();
  win.handlers.copy();
  await new Promise(function (r) { setTimeout(r, 1500); });

  log("regenerate 5x4");
  win.handlers.regenerate({ cols: 5, rows: 4 });
  await waitFor(function () { return renderCount >= 2 || failCount > 0; }, 120000, "second render");
  if (failCount > 0) throw new Error("regeneration failed");
  if (lastRender.cols !== 5 || lastRender.rows !== 4) throw new Error("grid not applied");
  if (!fs.existsSync(lastRender.savedPath)) throw new Error("missing 5x4 output");

  fs.writeFileSync(path.join(__dirname, "run.log"), lines.join("\n") + "\n");
  log("done. renders=" + renderCount + " failures=" + failCount);
  process.exit(0);
})().catch(function (error) {
  log("TEST FAILED: " + (error && error.stack || error));
  fs.writeFileSync(path.join(__dirname, "run.log"), lines.join("\n") + "\n");
  process.exit(1);
});
