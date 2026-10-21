/*
 * 全局入口：即使 IINA 还没有打开任何视频，也能在「插件」菜单里看到入口。
 * 选择一个视频后创建一个新的播放器实例，并交给主入口自动生成缩略图。
 */

const { global, menu, utils, console: logger } = iina;

const VIDEO_EXTS = [
  "mp4", "mkv", "mov", "avi", "webm", "flv", "ts", "m4v", "mpg", "mpeg",
  "wmv", "rmvb", "rm", "3gp", "m2ts", "mts", "vob", "ogv", "divx", "asf",
];

function chooseVideoAndGenerate() {
  let path = "";
  try {
    path = utils.chooseFile("选择要生成缩略图的视频", {
      allowedFileTypes: VIDEO_EXTS,
    });
  } catch (e) {
    log("选择文件失败：" + e);
    return;
  }
  if (!path) return;

  try {
    global.createPlayerInstance({
      url: path,
      label: "gridsheet-auto",
      enablePlugins: true,
    });
  } catch (e) {
    log("创建播放器失败：" + e);
  }
}

function log(message) {
  try {
    logger.log("[gridsheet/global] " + message);
  } catch (e) {
    // ignore
  }
}

menu.addItem(menu.item("多宫格缩略图：选择视频并生成…", chooseVideoAndGenerate));
