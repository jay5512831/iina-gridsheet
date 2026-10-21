(function () {
  "use strict";

  const api = window.iina;
  const GRID_OPTIONS = [
    [3, 3],
    [4, 3],
    [4, 4],
    [5, 4],
    [6, 4],
  ];

  const el = function (id) {
    return document.getElementById(id);
  };

  let current = { cols: 4, rows: 3 };
  let times = [];
  let canSeek = false;
  let savedPath = "";
  let busy = false;
  let toastTimer = null;

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatTime(seconds, withHours) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0 || withHours) return pad2(h) + ":" + pad2(m) + ":" + pad2(s);
    return pad2(m) + ":" + pad2(s);
  }

  function showToast(text, kind) {
    const toast = el("toast");
    toast.textContent = text;
    toast.className = "toast show" + (kind === "error" ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.className = "toast";
    }, 2400);
  }

  function setStatus(text) {
    el("status").textContent = text;
  }

  function setProgress(done, total) {
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    el("progressBar").style.width = pct + "%";
  }

  function setActionsEnabled(enabled) {
    el("reveal").disabled = !enabled;
    el("copy").disabled = !enabled;
    el("saveAs").disabled = !enabled;
  }

  function updateSavedPath(path) {
    savedPath = path || "";
    const node = el("savedPath");
    node.textContent = savedPath.replace(/^\/Users\/[^/]+\//, "~/");
    node.title = savedPath;
  }

  function setActiveGrid(cols, rows) {
    const buttons = el("gridPicker").querySelectorAll(".seg");
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      button.classList.toggle(
        "active",
        Number(button.dataset.cols) === cols && Number(button.dataset.rows) === rows
      );
    }
  }

  function buildGridPicker() {
    const picker = el("gridPicker");
    picker.innerHTML = "";
    GRID_OPTIONS.forEach(function (option) {
      const cols = option[0];
      const rows = option[1];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "seg";
      button.dataset.cols = String(cols);
      button.dataset.rows = String(rows);
      button.textContent = cols + "×" + rows;
      button.addEventListener("click", function () {
        if (busy) return;
        if (cols === current.cols && rows === current.rows) return;
        current = { cols: cols, rows: rows };
        setActiveGrid(cols, rows);
        showLoading("正在重新生成…", "");
        api.postMessage("regenerate", { cols: cols, rows: rows });
      });
      picker.appendChild(button);
    });
    setActiveGrid(current.cols, current.rows);
  }

  function showLoading(title, detail) {
    const placeholder = el("placeholder");
    placeholder.hidden = false;
    placeholder.classList.remove("error");
    el("loadingTitle").textContent = title || "正在生成…";
    el("loadingDetail").textContent = detail || "";
    el("sheetWrap").hidden = true;
    el("regenerate").disabled = true;
    el("saveToVideoDir").disabled = true;
    el("outputWidth").disabled = true;
    setActionsEnabled(false);
    setProgress(0, 1);
    busy = true;
  }

  function showError(message) {
    const placeholder = el("placeholder");
    placeholder.hidden = false;
    placeholder.classList.add("error");
    el("loadingTitle").textContent = "生成失败";
    el("loadingDetail").textContent = message || "未知错误";
    el("sheetWrap").hidden = true;
    el("regenerate").disabled = false;
    el("saveToVideoDir").disabled = false;
    el("outputWidth").disabled = false;
    setActionsEnabled(false);
    setStatus("生成失败，可调整网格后重试");
    busy = false;
  }

  function setSaveToggle(value) {
    el("saveToVideoDir").checked = value !== false;
  }

  function setOutputWidth(value) {
    if (value) el("outputWidth").value = String(value);
  }

  function renderMeta(meta) {
    const box = el("meta");
    box.innerHTML = "";
    if (!meta) return;
    const values = [];
    if (meta.duration > 0) {
      values.push(formatTime(meta.duration, meta.duration >= 3600));
    }
    if (meta.sheetWidth > 0 && meta.sheetHeight > 0) {
      values.push("输出 " + meta.sheetWidth + "×" + meta.sheetHeight);
    } else if (meta.width > 0 && meta.height > 0) {
      values.push(meta.width + "×" + meta.height);
    }
    if (meta.cols && meta.rows) {
      values.push(meta.cols + "×" + meta.rows + " 网格");
    }
    if (meta.elapsed) {
      values.push("耗时 " + meta.elapsed + " 秒");
    }
    values.forEach(function (value) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = value;
      box.appendChild(chip);
    });
  }

  function buildCells(cols, rows) {
    const layer = el("cells");
    layer.innerHTML = "";
    layer.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    layer.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
    layer.classList.toggle("no-seek", !canSeek);
    const withHours = times.length > 0 && times[times.length - 1] >= 3600;
    for (let i = 0; i < times.length; i++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      if (canSeek) {
        const time = times[i];
        cell.title = "跳转到 " + formatTime(time, withHours);
        cell.addEventListener("click", function () {
          api.postMessage("seek", { time: time });
        });
      }
      layer.appendChild(cell);
    }
  }

  /* ---------------- 消息 ---------------- */

  api.onMessage("init", function (data) {
    current = { cols: data.cols, rows: data.rows };
    setActiveGrid(data.cols, data.rows);
    el("filename").textContent = data.title || "视频";
    el("filename").title = data.filePath || data.title || "";
    if (data.duration) {
      renderMeta({
        duration: data.duration,
        width: data.width,
        height: data.height,
        cols: data.cols,
        rows: data.rows,
      });
    } else {
      el("meta").innerHTML = "";
    }
    showLoading(data.phase || "正在准备…", "");
    setSaveToggle(data.saveToVideoDir);
    setOutputWidth(data.outputWidth);
    setStatus("正在生成 " + data.cols + "×" + data.rows + " 缩略图…");
    updateSavedPath("");
  });

  api.onMessage("progress", function (data) {
    el("placeholder").hidden = false;
    el("loadingTitle").textContent = data.phase || "正在生成…";
    el("loadingDetail").textContent =
      data.total > 0 ? data.done + " / " + data.total + " 帧" : "";
    setProgress(data.done || 0, data.total || 1);
  });

  api.onMessage("render", function (data) {
    current = { cols: data.cols, rows: data.rows };
    setActiveGrid(data.cols, data.rows);
    times = Array.isArray(data.times) ? data.times : [];
    canSeek = !!data.canSeek;
    setSaveToggle(data.saveToVideoDir);
    setOutputWidth(data.outputWidth);
    renderMeta(data.meta);
    buildCells(data.cols, data.rows);
    updateSavedPath(data.savedPath);
    el("filename").textContent = (data.meta && data.meta.title) || "视频";

    const image = el("sheet");
    image.onload = function () {
      el("sheetWrap").hidden = false;
      el("placeholder").hidden = true;
      el("regenerate").disabled = false;
      el("saveToVideoDir").disabled = false;
      el("outputWidth").disabled = false;
      setActionsEnabled(true);
      busy = false;
      setStatus(
        canSeek
          ? "点击任意画面跳转到对应时间"
          : "该视频未在 IINA 中播放，点击跳转不可用"
      );
      showToast("已生成 " + data.cols + "×" + data.rows + " 缩略图");
    };
    image.onerror = function () {
      showError("图片加载失败。");
    };
    image.src = data.image;
  });

  api.onMessage("error", function (data) {
    showError(data && data.message);
    showToast("生成失败", "error");
  });

  api.onMessage("saved", function (data) {
    if (!data) return;
    if (data.path) updateSavedPath(data.path);
    if (typeof data.saveToVideoDir === "boolean") {
      setSaveToggle(data.saveToVideoDir);
    }
  });

  api.onMessage("toast", function (data) {
    if (data && data.text) showToast(data.text, data.kind);
  });

  /* ---------------- 交互 ---------------- */

  el("regenerate").addEventListener("click", function () {
    if (busy) return;
    showLoading("正在重新生成…", "");
    api.postMessage("regenerate", { cols: current.cols, rows: current.rows });
  });

  el("reveal").addEventListener("click", function () {
    api.postMessage("reveal");
  });

  el("copy").addEventListener("click", function () {
    api.postMessage("copy");
  });

  el("saveAs").addEventListener("click", function () {
    api.postMessage("saveAs");
  });

  el("savedPath").addEventListener("click", function () {
    if (savedPath) api.postMessage("reveal");
  });

  el("saveToVideoDir").addEventListener("change", function () {
    api.postMessage("setSaveLocation", { toVideoDir: this.checked });
  });

  el("outputWidth").addEventListener("change", function () {
    if (busy) return;
    showLoading("正在按 " + this.value + " px 重新生成…", "");
    api.postMessage("setOutputWidth", { width: Number(this.value) });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      api.postMessage("close");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === "s") {
      event.preventDefault();
      api.postMessage("saveAs");
    }
  });

  buildGridPicker();
  api.postMessage("ready");
})();
