const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

// 主进程异常兜底（必须在加载业务模块之前注册）
process.on('uncaughtException', (e) => {
  try {
    const logPath = path.join(path.dirname(process.execPath), 'main-error.log');
    fs.appendFileSync(logPath, new Date().toISOString() + '\n' + (e.stack || e.message) + '\n\n');
  } catch (_) { /* ignore */ }
});

// Playwright 浏览器内核目录：打包后取 resources/browsers，开发时取项目 browsers/
const resBrowsers = process.resourcesPath
  ? path.join(process.resourcesPath, 'browsers')
  : path.join(__dirname, 'browsers');
if (fs.existsSync(resBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = resBrowsers;
} else if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'browsers');
}

// 启动探针：标记启动进度，写 exe 旁 boot.log
const BOOTLOG = path.join(path.dirname(process.execPath), 'boot.log');
function bootLog(msg) {
  try { fs.appendFileSync(BOOTLOG, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) {}
}
bootLog('main.js loaded, execPath=' + process.execPath);

// 数据根目录：打包后=exe 同级（可写），dev=项目目录
process.env.APP_DATA_ROOT = app.isPackaged ? path.dirname(process.execPath) : __dirname;

const { start } = require('./server.js');
bootLog('server.js required OK');

function createWindow(port) {
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    autoHideMenuBar: true,
    backgroundColor: '#eef1fb',
    title: '视频反推提示词',
    icon: fs.existsSync(icoPath) ? icoPath : undefined, // 打包后 exe 自带图标，开发态用 ico
    webPreferences: { contextIsolation: true },
  });
  win.loadURL('http://localhost:' + port);
}

app.whenReady().then(async () => {
  bootLog('app ready');
  // 默认 5178，被占用则自动换随机端口
  let server;
  try {
    server = await start(5178);
  } catch (e) {
    server = await start(0);
  }
  bootLog('server listening on ' + server.address().port);
  createWindow(server.address().port);
  bootLog('window created, loadURL done');
});

app.on('window-all-closed', () => app.quit());
