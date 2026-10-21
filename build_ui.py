#!/usr/bin/env python3
"""Inline CSS/JS into a single window.html so the IINA webview loads it reliably."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
ui = ROOT / "ui"
template = (ui / "window.template.html").read_text(encoding="utf-8")
css = (ui / "window.css").read_text(encoding="utf-8")
js = (ui / "window.js").read_text(encoding="utf-8")
html = template.replace("/*__CSS__*/", css).replace("/*__JS__*/", js)
(ui / "window.html").write_text(html, encoding="utf-8")
print(ui / "window.html", len(html))
