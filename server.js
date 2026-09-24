const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = 5178;
const BASE_URL = 'https://chat.qwen.ai';
// 数据目录根：由 main.js 传入（打包后=exe 同级，dev=项目根）；node 直跑时=项目根
const ROOT = process.env.APP_DATA_ROOT || __dirname;
const USER_DATA_DIR = path.join(ROOT, 'session');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DEBUG_DIR = path.join(ROOT, 'debug');
// 前端静态目录：打包后取 resources/public，开发时取项目 public
let PUBLIC_DIR = path.join(__dirname, 'public');
const resPublic = process.resourcesPath ? path.join(process.resourcesPath, 'public') : null;
if (resPublic && fs.existsSync(path.join(resPublic, 'index.html'))) {
  PUBLIC_DIR = resPublic;
}
const MAX_CONCURRENT = 3; // 并行任务上限（同一账号多标签页）

for (const d of [USER_DATA_DIR, UPLOAD_DIR, DEBUG_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Chromium 内核目录：默认取项目内 browsers/（打包后由 main.js 指向 resources/browsers）
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(ROOT, 'browsers');
}

const app = express();
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR)); // 视频预览
app.use(express.json());

// 磁盘存储：保留原始扩展名（<video> 预览需要正确 MIME）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.mp4').toLowerCase();
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// ---------------- 浏览器会话管理 ----------------
let ctx = null;
let mainPage = null; // 主标签页：用于状态检测与窗口控制
let launching = null;
let windowHidden = true; // 启动时窗口位于屏幕外
const tabPool = []; // 预热的就绪页签池（Qwen 已加载、输入框可定位），提交任务零等待
let replenishing = false;

// 开一个加载好 Qwen 首页的页签；失败（未登录等）返回 null
async function makeReadyTab() {
  const p = await ctx.newPage();
  try {
    await p.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sel = await findFirstOn(p, SEL.chatInput, 30000);
    if (!sel) { try { await p.close(); } catch (e) { /* ignore */ } return null; }
    p.__inputSel = sel;
    return p;
  } catch (e) {
    try { await p.close(); } catch (e2) { /* ignore */ }
    return null;
  }
}

// 把池子补满（并行开页）
async function replenishPool() {
  if (!ctx || replenishing) return;
  replenishing = true;
  try {
    const need = MAX_CONCURRENT - tabPool.length;
    if (need > 0) {
      const made = await Promise.all(
        Array.from({ length: need }, () => makeReadyTab().catch(() => null))
      );
      for (const p of made) if (p && !p.isClosed()) tabPool.push(p);
    }
  } finally {
    replenishing = false;
  }
}

// 取一个就绪页签；池空则现场补开一个
async function acquireTab() {
  while (tabPool.length) {
    const p = tabPool.shift();
    if (!p.isClosed()) return p;
  }
  await replenishPool();
  while (tabPool.length) {
    const p = tabPool.shift();
    if (!p.isClosed()) return p;
  }
  return null;
}

// 页面元素候选选择器（Qwen 页面改版时可在此调整）
const SEL = {
  chatInput: [
    'textarea#chat-input',
    'textarea[placeholder*="问题"]',
    'textarea[placeholder*="问"]',
    'textarea',
    'div[contenteditable="true"]',
  ],
  fileInput: 'input[type="file"]',
  sendBtn: [
    'button[type="submit"]',
    'button[aria-label*="发送"]',
    'button[data-test-id*="send"]',
    '#send-message-button',
  ],
  markdownBlocks: [
    'div.markdown-body',
    '[class*="markdown-body"]',
    '[class*="answer-content"]',
    '[class*="assistant"] [class*="content"]',
  ],
};

// 并行竞速探测：任一选择器出现即返回（串行逐个等会白等 30s×N）
async function findFirstOn(p, selList, timeout = 8000) {
  try {
    return await Promise.any(selList.map(sel =>
      p.waitForSelector(sel, { timeout, state: 'visible' }).then(() => sel)
    ));
  } catch (e) {
    return null;
  }
}

async function launchBrowser() {
  if (ctx) return;
  if (launching) return launching;
  launching = (async () => {
    // 窗口初始位置移出屏幕，实现"默认不显示"
    ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 860 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        '--start-minimized',
        // 隐藏窗口（屏幕外）防节流/防遮挡休眠，保证后台上传与响应稳定
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    });
    mainPage = ctx.pages()[0] || (await ctx.newPage());
    // 关键顺序：先最小化、再加载页面——此前最小化放在 goto 之后，页面加载的数秒里窗口一直可见
    await setWindowVisible(false).catch(() => {});
    await mainPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    ctx.on('close', () => {
      ctx = null;
      mainPage = null;
      tabPool.length = 0;
    });
  })();
  return launching;
}

// 通过 Win32 切换 Chromium 窗口的 WS_EX_TOOLWINDOW 样式：
// 加上 = 任务栏不显示 Qwen 图标；去掉 = 正常显示（与窗口显隐联动）
function setTaskbarIcon(show) {
  const full = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W32{[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);[DllImport("user32.dll")]public static extern int SetWindowLong(IntPtr h,int i,int v);}' | Out-Null
$udir = $env:QWEN_UDIR
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like ('*' + $udir + '*') }
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $h = $proc.MainWindowHandle
    if ($env:QWEN_TB_SHOW -eq '1') {
      [W32]::SetWindowLong($h, -20, ([W32]::GetWindowLong($h, -20) -band (-bnot 0x80))) | Out-Null
    } else {
      [W32]::SetWindowLong($h, -20, ([W32]::GetWindowLong($h, -20) -bor 0x80)) | Out-Null
    }
  }
}
`;
  try {
    const { spawn } = require('child_process');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', full], {
      windowsHide: true,
      env: { ...process.env, QWEN_UDIR: USER_DATA_DIR, QWEN_TB_SHOW: show ? '1' : '0' },
    }).on('error', () => {});
  } catch (e) { /* 隐藏任务栏图标失败不影响主流程 */ }
}

// 通过 CDP 控制窗口显示/隐藏（最小化 = 隐藏，normal + 定位 = 显示）
async function setWindowVisible(visible) {
  if (!ctx) return;
  if (mainPage && mainPage.isClosed()) mainPage = await ctx.newPage();
  const session = await ctx.newCDPSession(mainPage);
  const { windowId } = await session.send('Browser.getWindowForTarget');
  if (visible) {
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal', left: 100, top: 60 },
    });
  } else {
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'minimized' },
    });
  }
  windowHidden = !visible;
  // 任务栏图标与窗口显隐联动：隐藏窗口时连任务栏图标一并移除
  setTaskbarIcon(visible);
}

async function ensureMainPage() {
  await launchBrowser();
  if (mainPage.isClosed()) {
    mainPage = await ctx.newPage();
    await mainPage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return mainPage;
}

// 游客检测：未登录时页面含"登录注册"入口，上传附件会被拒绝
async function isGuest(p) {
  try {
    return await p.evaluate(() => {
      const t = (document.body.innerText || '').slice(0, 3000);
      return /登录\s*注册|登录注册/.test(t);
    });
  } catch (e) {
    return false;
  }
}

// 浏览器会话是否就绪（已登录且能找到聊天输入框）
async function checkReady() {
  try {
    const p = await ensureMainPage();
    const sel = await findFirstOn(p, SEL.chatInput, 3000);
    const guest = sel ? await isGuest(p) : true;
    const ready = !!sel && !guest;
    // 不自动弹窗：即使检测到未登录也保持隐藏，由用户手动点「显示窗口」处理
    return { ready, needLogin: !ready };
  } catch (e) {
    return { ready: false, needLogin: true };
  }
}

// ---------------- 任务管理（持久化到 data/tasks.json） ----------------
const DATA_DIR = path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let taskSeq = 0;
const tasks = new Map(); // id -> { id, status, step, text, error, prompt, videoName, createdAt }

function loadTasks() {
  try {
    const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    for (const t of arr) {
      // 服务重启后，之前"运行中"的任务实际已中断
      if (t.status === 'running') {
        t.status = 'error';
        t.step = '已中断';
        t.error = '服务重启导致任务中断，请重新提交';
      }
      tasks.set(t.id, t);
    }
    taskSeq = arr.length ? Math.max(...arr.map(t => Number(t.id))) : 0;
  } catch (e) { /* 首次启动无文件 */ }
}

function saveTasks() {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify([...tasks.values()], null, 0));
  } catch (e) { /* ignore */ }
}

loadTasks();
setInterval(saveTasks, 2000);

function createTask(meta = {}) {
  const id = String(++taskSeq);
  const t = {
    id, status: 'running', step: '排队中', text: '', error: '',
    prompt: meta.prompt || '',
    videoName: meta.videoName || '',
    videoFile: meta.videoFile || '',
    createdAt: new Date().toISOString(),
  };
  tasks.set(id, t);
  saveTasks();
  return t;
}

function runningCount() {
  return [...tasks.values()].filter(t => t.status === 'running').length;
}

async function shotOn(p, name) {
  try {
    await p.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: false });
  } catch (e) { /* 窗口在屏幕外时可能失败 */ }
  try {
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.html`), await p.content());
  } catch (e) { /* ignore */ }
  try {
    const text = await p.evaluate(() => document.body ? document.body.textContent.replace(/\s+/g, ' ').slice(0, 6000) : '');
    fs.writeFileSync(path.join(DEBUG_DIR, `${name}.txt`), text);
  } catch (e) { /* ignore */ }
}

function lastMarkdownTextOn(p) {
  return p.evaluate((sels) => {
    const bad = /你更喜欢哪个回复|我更喜欢这个回复|请选择一个以继续|此反馈将帮助我们/;
    for (const s of sels) {
      const nodes = [...document.querySelectorAll(s)];
      for (let i = nodes.length - 1; i >= 0; i--) {
        const t = nodes[i].innerText.trim();
        if (t && !bad.test(t) && t.length > 3) return t;
      }
    }
    return '';
  }, SEL.markdownBlocks);
}

// ---------------- 核心流程（每个任务独立标签页） ----------------
async function runTask(t, videoPath, prompt) {
  await launchBrowser();
  // 优先取预热的就绪页签（Qwen 已加载，跳过打开页面等待）
  let p = await acquireTab();
  if (!p) {
    p = await ctx.newPage();
    await p.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const sel = await findFirstOn(p, SEL.chatInput, 30000);
    if (!sel) throw new Error('未检测到聊天输入框，请点击"显示窗口"登录 Qwen 后重试');
    p.__inputSel = sel;
  }
  p.on('crash', () => console.log('[page-crash] 任务 #' + t.id + ' 页面崩溃'));
  const inputSel = p.__inputSel;
  try {
    if (await isGuest(p)) {
      await shotOn(p, 'need-login');
      throw new Error('当前为游客模式，无法上传视频。请在浏览器窗口中登录 Qwen 后重试');
    }

    // 2. 上传视频 —— 直接注入 React 上传管理器（Sm 实例），绕过 UI 菜单上传的
    //    type 键校验缺陷（菜单路径会静默拒绝文件，input/chooser 均无效，已逆向验证）
    t.step = '上传视频中';    const videoName = path.basename(videoPath);
    const videoB64 = fs.readFileSync(videoPath).toString('base64');
    const injected = await p.evaluate(async ({ b64, name }) => {
      const ta = document.querySelector('textarea');
      if (!ta) return { ok: false, err: '页面上找不到输入框' };
      const fk = Object.keys(ta).find(k => k.startsWith('__reactFiber$'));
      if (!fk) return { ok: false, err: '找不到 React 节点，页面可能未加载完成' };
      let root = ta[fk];
      while (root.return) root = root.return;
      let sm = null;
      const seen = new Set();
      const walk = (f) => {
        if (!f || seen.has(f) || sm) return;
        seen.add(f);
        const pr = f.memoizedProps;
        if (pr && typeof pr === 'object' && pr.filesManager && typeof pr.filesManager.addFiles === 'function') { sm = pr.filesManager; return; }
        walk(f.child); walk(f.sibling);
      };
      walk(root);
      if (!sm) return { ok: false, err: '找不到上传管理器，请刷新后重试' };
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const mimeMap = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/avi', '.mkv': 'video/x-matroska', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv' };
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      const file = new File([buf], name, { type: mimeMap[ext] || 'video/mp4' });
      const r = await sm.addFiles([file]);
      if (!Array.isArray(r) || r.length === 0) {
        return { ok: false, err: '上传被 Qwen 拒绝（格式不支持，建议 mp4/mov/avi/mkv，单视频≤500MB）' };
      }
      // 轮询等待上传完成（item.status: uploading → uploaded/error）
      const itemId = r[0].itemId;
      for (let i = 0; i < 150; i++) { // 最多 5 分钟
        await new Promise(res => setTimeout(res, 2000));
        const it = (sm.fileItems || []).find(x => x.itemId === itemId);
        if (!it) return { ok: false, err: '上传任务丢失' };
        if (it.status === 'uploaded') return { ok: true };
        if (it.status === 'error' || it.error) return { ok: false, err: '上传失败（' + (it.error || '文件过大或网络中断') + '）' };
      }
      return { ok: false, err: '上传超时（5 分钟），视频可能过大，建议压缩后重试' };
    }, { b64: videoB64, name: videoName });
    if (!injected.ok) {
      await shotOn(p, 'upload-failed');
      throw new Error('视频上传失败：' + injected.err);
    }
    await shotOn(p, 'step-after-upload');

    // 3. 填入提示词（fill 秒级完成；type 逐字输入对长文本必超时，禁用）
    t.step = '填入提示词';
    const input = await p.$(inputSel);
    await input.click();
    let filled = false;
    try {
      await input.fill(prompt, { timeout: 10000 });
      // 校验内容确实写入
      const val = await input.evaluate(el => el.value !== undefined ? el.value : el.textContent);
      filled = (val || '').length >= Math.min(prompt.length, 10);
    } catch (e) { /* 走兜底 */ }
    if (!filled) {
      // React 受控组件兜底：原生 setter + input 事件
      await p.evaluate(({ sel, text }) => {
        const el = document.querySelector(sel);
        el.focus();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
        } else {
          el.textContent = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, { sel: inputSel, text: prompt });
    }
    await p.waitForTimeout(500);
    await shotOn(p, 'step-after-fill');

    // 4. 发送
    t.step = '发送中';
    const baseline = await lastMarkdownTextOn(p);
    let sent = false;
    for (const btnSel of SEL.sendBtn) {
      const btn = await p.$(btnSel);
      if (btn && await btn.isEnabled()) {
        await btn.click();
        sent = true;
        break;
      }
    }
    if (!sent) {
      await input.press('Enter');
    }
    await p.waitForTimeout(6000);
    await shotOn(p, 'step-after-send');

    // 5. 轮询等待回复（文本连续 12 秒不变即认为生成完成）
    t.step = '等待反推结果';
    const deadline = Date.now() + 8 * 60 * 1000;
    let lastText = '';
    let stableSince = 0;
    while (Date.now() < deadline) {
      await p.waitForTimeout(3000);
      // 处理 Qwen 双回复对比模式：出现偏好选择时点选「回复 1」以展开正文
      const pageText = await p.evaluate(() => document.body.innerText).catch(() => '');
      if (/你更喜欢哪个回复/.test(pageText)) {
        try {
          await p.locator('text=我更喜欢这个回复').first().click({ timeout: 3000 });
          lastText = ''; stableSince = 0; // 选择后正文重新输出，重置稳定计时
          await p.waitForTimeout(2000);
        } catch (e) { /* 下轮再试 */ }
      }
      const cur = await lastMarkdownTextOn(p);
      if (cur && cur !== baseline) {
        if (cur === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= 12000) {
            t.text = cur;
            t.status = 'done';
            t.step = '完成';
            return;
          }
        } else {
          lastText = cur;
          stableSince = 0;
        }
      }
    }
    await shotOn(p, 'timeout');
    throw new Error('等待回复超时（8 分钟），请显示窗口检查浏览器状态');
  } finally {
    try { await p.close(); } catch (e) { /* ignore */ }
  }
}

// ---------------- API ----------------
app.get('/api/status', async (req, res) => {
  const r = await checkReady();
  res.json({
    ...r,
    hidden: windowHidden,
    running: runningCount(),
    maxConcurrent: MAX_CONCURRENT,
  });
});

app.post('/api/browser/show', async (req, res) => {
  try {
    await launchBrowser();
    await setWindowVisible(true);
    res.json({ ok: true, hidden: windowHidden });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/browser/hide', async (req, res) => {
  try {
    await setWindowVisible(false);
    res.json({ ok: true, hidden: windowHidden });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/run', upload.single('video'), async (req, res) => {
  if (runningCount() >= MAX_CONCURRENT) {
    return res.status(409).json({ error: `并行任务已达上限（${MAX_CONCURRENT} 个），请稍候` });
  }
  if (!req.file) return res.status(400).json({ error: '请上传视频文件' });
  const prompt = (req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: '请填写提示词' });

  const t = createTask({
    prompt,
    videoName: req.file.originalname,
    videoFile: path.basename(req.file.path),
  });
  res.json({ taskId: t.id });

  try {
    try {
      await runTask(t, req.file.path, prompt);
    } catch (e1) {
      // 浏览器进程偶发崩溃时自动重建并重试一次
      const msg = e1.message || String(e1);
      if (/Target page, context or browser has been closed|Session closed|browser has been closed/i.test(msg)) {
        console.log('[retry] 浏览器异常关闭，自动重建后重试任务 #' + t.id + '：' + msg);
        ctx = null; mainPage = null;
        await launchBrowser();
        await runTask(t, req.file.path, prompt);
      } else {
        throw e1;
      }
    }
  } catch (e) {
    t.status = 'error';
    t.error = e.message || String(e);
    t.step = '出错';
    await shotOn(mainPage, 'error').catch(() => {});
  } finally {
    // 视频文件保留（九宫格预览需要），并补充页签池
    saveTasks();
    replenishPool().catch(() => {});
  }
});

app.get('/api/tasks', (req, res) => {
  res.json([...tasks.values()].sort((a, b) => Number(b.id) - Number(a.id)));
});

app.get('/api/task/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: '任务不存在或服务已重启' });
  res.json(t);
});

function start(port = PORT) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const p = server.address().port;
      console.log(`服务已启动: http://localhost:${p}（窗口默认隐藏，并行上限 ${MAX_CONCURRENT}）`);
      launchBrowser()
        .then(() => replenishPool())
        .catch(e => console.error('浏览器启动失败:', e.message));
      resolve(server);
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  start(PORT).catch(e => {
    console.error('服务启动失败(端口被占用?):', e.message);
    process.exit(1);
  });
}

module.exports = { app, start };
