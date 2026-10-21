#!/usr/bin/env python3
"""Build a static preview of the IINA plugin window with a generated sample sheet."""
import base64
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN = ROOT
TESTS = ROOT / "tests"

html = (PLUGIN / "ui" / "window.template.html").read_text(encoding="utf-8")
css = (PLUGIN / "ui" / "window.css").read_text(encoding="utf-8")
js = (PLUGIN / "ui" / "window.js").read_text(encoding="utf-8")

sheet = (TESTS / "out" / "sample_4x3.png").read_bytes()
image = "data:image/png;base64," + base64.b64encode(sheet).decode("ascii")

times = [round(1.8 + i * (86.4 / 11), 2) for i in range(12)]

mock = """
window.iina = {
  _h: {},
  onMessage: function (name, cb) { this._h[name] = cb; },
  postMessage: function (name, data) {
    if (window.console) console.log("window ->", name, data);
    var el = document.getElementById("status");
    if (el && name === "toast") el.textContent = data && data.text;
  }
};
"""

demo = """
setTimeout(function () {
  var h = window.iina._h;
  var data = %s;
  h.init({
    filePath: "/Users/mc/Movies/Demo.Movie.2026.2160p.mkv",
    title: "Demo.Movie.2026.2160p",
    cols: 4,
    rows: 3,
    phase: "正在抽取 12 帧画面…",
    duration: 125.0,
    width: 3840,
    height: 2160
  });
  h.progress({ done: 12, total: 12, phase: "正在拼接网格…" });
  h.render(data);
}, 60);
""" % json.dumps({
    "image": image,
    "times": times,
    "cols": 4,
    "rows": 3,
    "canSeek": True,
    "saveToVideoDir": True,
    "outputWidth": 2560,
    "sheetWidth": 2556,
    "sheetHeight": 1098,
    "savedPath": "/Users/mc/Movies/Demo.Movie.2026.2160p_grid_4x3.png",
    "meta": {
        "title": "Demo.Movie.2026.2160p",
        "duration": 125.0,
        "width": 3840,
        "height": 2160,
        "outputWidth": 2560,
        "sheetWidth": 2556,
        "sheetHeight": 1098,
        "cols": 4,
        "rows": 3,
        "count": 12,
        "elapsed": 1.4,
        "canSeek": True,
        "saveToVideoDir": True,
    },
}, ensure_ascii=False)

html = html.replace("/*__CSS__*/", css)
html = html.replace(
    "/*__JS__*/",
    mock + "\n" + js + "\n" + demo,
)

target = TESTS / "preview.html"
target.write_text(html, encoding="utf-8")
print(target)
print("size", target.stat().st_size)
