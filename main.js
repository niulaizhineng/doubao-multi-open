// ============================================================
//  豆包多开管理器 v3.0 · 视图池架构
//  核心思路继承自 doubao-video-multi:
//    单窗口 + WebContentsView 常驻视图池, 切号=显隐切换(毫秒级,不丢状态)
//  在其基础上修复/增强:
//    1. userData 重定向到本目录(E盘), 不再写 C 盘 AppData
//    2. GPU 硬件加速默认开启(兼容模式可选), 不再全局禁用
//    3. 渲染进程崩溃自动重建视图; 加载失败自动重试并标记状态
//    4. 掉线检测改用强凭证 Cookie(不再用 DOM 文本正则, 避免误报)
//    5. 缩放快捷键真正作用于豆包页面(原版只作用于主窗口, 无效)
//    6. 新增下载处理: 生成的视频/图片自动保存并可一键打开
//    7. 权限请求白名单; 关窗最小化到托盘(可关); 单实例锁
//    8. 登录监控防重入、定时器必清; 昵称提取只在登录成功时执行一次
// ============================================================
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, Tray, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- 路径与日志 ----------
const APP_DIR = __dirname;
const USER_DIR = path.join(APP_DIR, 'userdata');
const DOWNLOAD_DIR = path.join(APP_DIR, 'downloads');
const LOG_FILE = path.join(APP_DIR, 'app-run.log');
app.setPath('userData', USER_DIR);
try { app.setPath('crashDumps', path.join(USER_DIR, 'crashes')); } catch (e) {}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}
try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 1024 * 1024) fs.unlinkSync(LOG_FILE); // 超过 1MB 重新开始
} catch (e) {}
log('=== v3 启动 ===');

// ---------- 偏好设置(先于 ready 读取, 因为兼容模式要提前决定) ----------
const PREFS_FILE = path.join(USER_DIR, 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch (e) { return {}; }
}
let prefs = Object.assign({ closeToTray: true, winBounds: null }, loadPrefs());
function savePrefs() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (e) { log('savePrefs 失败: ' + e.message); }
}

if (prefs.compatGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  log('兼容模式: 已禁用 GPU');
}

// ---------- 全局常量 ----------
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const DOUBAO_URL = 'https://www.doubao.com/chat/';
const SIDEBAR_WIDTH = 260;
const PALETTE = ['#4F86F7', '#00B578', '#FF7D00', '#E16531', '#7261A3', '#2BA6A0', '#D22E45', '#5B8C5A'];

// 登录凭证特征: 强凭证(登录后才会出现) 与 匿名/埋点 key
const AUTH_RE = /sessionid|session_tt|uid_tt|user_tt|user_ticket|login_uid|auth_token|user_token|passport_auth|sid_tt|sso_|store-region/i;
const ANON_RE = /ttwid|s_v_web_id|msToken|bd_ticket|__tea|tea_|flow_|logid|ab_|monitor|rum|perf|gid|vid|csrf|publish|i18next/i;

// ---------- 运行状态 ----------
let mainWindow = null;
let tray = null;
let activeAccountId = null;
const viewPool = new Map();          // accountId -> WebContentsView (常驻不销毁)
const badges = new Map();            // accountId -> 'online'|'pending'|'offline'|'loadfail'
const monitors = new Map();          // accountId -> {timer,diag,done}
const nameAttempts = new Map();      // accountId -> 昵称识别已尝试次数
const forceQuitting = { value: false };

// ---------- 账号持久化 ----------
const accountsFile = () => path.join(USER_DIR, 'accounts.json');
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(accountsFile(), 'utf-8') || '[]'); } catch (e) { return []; }
}
function saveAccounts(list) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) { log('saveAccounts 失败: ' + e.message); }
}

// ---------- 视图几何 ----------
function getContentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: SIDEBAR_WIDTH, y: 0, width: 900, height: 600 };
  const b = mainWindow.getContentBounds();
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(400, b.width - SIDEBAR_WIDTH),
    height: Math.max(300, b.height)
  };
}

// ---------- 会话级钩子(下载/权限), 每个分区只挂一次 ----------
function ensureSessionHooks(accountId) {
  const key = 'persist:' + accountId;
  let ses;
  try { ses = session.fromPartition(key); } catch (e) { return; }
  if (!ses || ses.__hooksDone) return;
  ses.__hooksDone = true;

  // 记录本分区内出现过的"用户信息类"接口(含 Worker 发起的请求), 供昵称识别重放
  ses.__apiLog = [];
  try {
    ses.webRequest.onCompleted({ urls: ['*://*.doubao.com/*'] }, (details) => {
      try {
        if (details.method !== 'GET') return;
        const pathOnly = details.url.split('?')[0];
        const low = details.url.toLowerCase();
        const interesting = low.indexOf('/user') >= 0 || low.indexOf('userinfo') >= 0 ||
          low.indexOf('user_info') >= 0 || low.indexOf('/account') >= 0 ||
          low.indexOf('passport') >= 0 && low.indexOf('info') >= 0;
        const junk = ['beat', 'heartbeat', 'track', 'monitor', 'report', '/log'].some(j => low.indexOf(j) >= 0);
        if (interesting && !junk && ses.__apiLog.length < 60) {
          if (ses.__apiLog.indexOf(details.url) < 0) ses.__apiLog.push(details.url);
        }
      } catch (e) {}
    });
  } catch (e) { log('webRequest 钩子失败: ' + e.message); }

  // 下载: 自动存到 程序目录\downloads\账号ID\
  ses.on('will-download', (event, item) => {
    try {
      const dir = path.join(DOWNLOAD_DIR, accountId);
      fs.mkdirSync(dir, { recursive: true });
      const base = item.getFilename() || ('file-' + Date.now());
      let savePath = path.join(dir, base);
      let i = 1;
      while (fs.existsSync(savePath)) {
        const ext = path.extname(base), stem = path.basename(base, ext);
        savePath = path.join(dir, stem + '(' + i + ')' + ext); i++;
      }
      item.setSavePath(savePath);
      log('下载开始: ' + base);
    } catch (e) { log('下载设置失败: ' + e.message); }
    item.once('done', (e2, state) => {
      if (state === 'completed') {
        log('下载完成: ' + item.getSavePath());
        pushToRenderer('download:done', { file: path.basename(item.getSavePath()), dir: path.dirname(item.getSavePath()) });
        if (tray) { tray.displayBalloon && tray.displayBalloon({ title: '下载完成', content: path.basename(item.getSavePath()) }); }
      } else if (state === 'interrupted') {
        log('下载中断: ' + item.getFilename());
      }
    });
  });

  // 权限白名单: 常用放行, 其余拒绝(避免页面权限弹窗卡死)
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allow = ['media', 'clipboard-sanitized-write', 'notification', 'fullscreen', 'pointerLock', 'clipboard-read'];
    callback(allow.indexOf(permission) >= 0);
  });
}

// ---------- 页面内脚本 ----------
const WEBDRIVER_PATCH = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

// 昵称识别: 重放主进程记录到的用户信息接口(cands 由外部传入) + DOM 兜底策略
const DETECT_NAME_SCRIPT = `(async (cands) => {
  try {
  const clean = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
  const bodyTxt = (document.body && document.body.innerText) || '';
  if (/扫码登录|手机号登录|验证码登录|^登录$/.test(bodyTxt)) return {name:'',source:'login-page'};
  const BAD = /(登录|退出|注册|下载|更多|最近|对话|工作|关于|设置|帮助|反馈|搜索|首页|返回|收起|展开|取消|确定|删除|重命名|新建|热门|推荐|免费|会员|升级|签到|消息|通知|历史|收藏|资料|我的|编辑|分享|复制|清空|全部|加载|暂无|PPT|图像|视频|研究|播客|录音|转写|文档|表格|代码|翻译|创作|技能|云盘|项目|置顶|深度思考|联网|豆包|助手|模型|默认)/i;
  const JUNK = /^(success|succeeded|failed|failure|fail|ok|okay|true|false|null|none|unknown|yes|no|0|1)$/i;
  const isName = (t)=>{
    t = clean(t);
    if (!t || t.length<1 || t.length>15) return false;
    if (BAD.test(t)) return false;
    if (JUNK.test(t)) return false;
    if (/^[0-9.-]+$/.test(t)) return false;
    return true;
  };

  // ---- 策略0(最可靠): 重放用户信息接口并深挖昵称字段 ----
  const NAME_KEY_RE = /^(nick|nickname|user_?name|display_?name|screen_?name|platform_screen_?name)$/i;
  function digName(obj, depth){
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    let generic = null;
    for (const k of Object.keys(obj)){
      let v;
      try { v = obj[k]; } catch(e){ continue; }
      if (v == null) continue;
      if (typeof v === 'string'){
        if (NAME_KEY_RE.test(k) && isName(v)) return clean(v);
        if (!generic && /^name$/i.test(k) && isName(v)) generic = clean(v);
      } else if (typeof v === 'object'){
        const r = digName(v, depth+1);
        if (r) return r;
      }
    }
    return generic;
  }
  async function tryUrl(u){
    try {
      const r = await fetch(u, { credentials:'include', headers:{'accept':'application/json'} });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return null;
      const j = await r.json();
      const root = (j && typeof j === 'object') ? (j.data || j.result || j.user || j) : null;
      const n = digName(root, 0);
      if (n) return { name:n, source:'api-replay:' + u.slice(0,90) };
    } catch(e){}
    return null;
  }
  // ---- 策略0a(首选): 豆包已知的用户信息接口, 直接带凭证重放 ----
  try {
    const known = [
      'https://www.doubao.com/passport/account/info/v2/?language=zh_cn',
      'https://www.doubao.com/passport/account/info/v2/'
    ];
    for (const u of known){
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略0b: 主进程记录到的其他候选接口 ----
  try {
    // 候选列表来自主进程 webRequest 记录(能覆盖 Web Worker 内的请求)
    const urls = Array.isArray(cands) ? cands : [];
    const seen = new Set();
    for (const u of urls){
      if (seen.has(u)) continue;
      seen.add(u);
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略1: 退出登录容器 ----
  let logoutEl = null;
  [...document.querySelectorAll('*')].forEach(el=>{
    if (el.children.length===0 && /^退出登录$/.test(clean(el.textContent))) logoutEl = el;
  });
  if (logoutEl) {
    let c = logoutEl;
    for (let i=0;i<4 && c.parentElement;i++) c = c.parentElement;
    const found = [];
    c.querySelectorAll('*').forEach(el=>{
      if (el.children.length>0) return;
      const t = clean(el.textContent || el.getAttribute('alt') || '');
      if (isName(t) && !/^退出登录$|^设置$|^更多$/.test(t)) found.push(t);
    });
    if (found.length) return {name:found[0], source:'logout-container'};
  }
  // ---- 策略2: localStorage 用户信息字段 ----
  try {
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if (!/user|account|profile|passport/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v || v.length>8000) continue;
      try {
        const obj = JSON.parse(v);
        const cand = obj && (obj.nick || obj.nickname || obj.name || obj.user_name || obj.userName || (obj.data && (obj.data.nick||obj.data.name)));
        if (typeof cand === 'string' && isName(cand)) return {name:cand.trim(), source:'localStorage:'+k};
      } catch(e2) {}
    }
  } catch(e) {}
  // ---- 策略3: 左下角头像 alt ----
  const w = window.innerWidth, h = window.innerHeight;
  const imgs = [...document.querySelectorAll('img')]
    .map(i=>({el:i, r:i.getBoundingClientRect()}))
    .filter(a=>a.r.width>20 && a.r.left<w*0.5 && a.r.top>h*0.5);
  for (const a of imgs){
    const t = clean(a.el.alt || a.el.getAttribute('aria-label') || '');
    if (isName(t)) return {name:t, source:'avatar-alt'};
  }
  return {name:'', source:'none'};
  } catch(err){
    return {name:'', source:'exception:' + ((err && err.message) || String(err)).slice(0,120)};
  }
})`;

// 对默认名("账号 N")的账号尝试自动识别昵称并改名; force=true 时无视默认名限制
async function tryAutoRename(accountId, force) {
  const list = loadAccounts();
  const acc = list.find(a => a.id === accountId);
  if (!acc || acc.pending) return;
  if (!force && !/^账号\s*\d+$/.test(acc.label)) return;  const v = viewPool.get(accountId);
  if (!v || v.webContents.isDestroyed()) return;
  await new Promise(r => setTimeout(r, 3000));
  try {
    if (!v || v.webContents.isDestroyed()) return;
    // 候选: 主进程 webRequest 记录到的用户信息类接口(含 Worker 请求)
    let cands = [];
    try {
      const ses = session.fromPartition('persist:' + accountId);
      if (ses && Array.isArray(ses.__apiLog)) cands = ses.__apiLog.slice();
    } catch (e) {}
    const script = '(' + DETECT_NAME_SCRIPT + ')(' + JSON.stringify(cands) + ');';
    const res = await v.webContents.executeJavaScript(script, true).catch((err) => {
      return { __rejected: true, msg: ((err && err.message) || String(err)).slice(0, 200), stack: ((err && err.stack) || '').slice(0, 400) };
    });
    if (res && res.__rejected) {
      log('识别脚本REJECT: ' + res.msg + ' | stack: ' + res.stack);
      return;
    }
    const name = res && res.name ? String(res.name).trim() : '';
    if (!name) {
      const n = (nameAttempts.get(accountId) || 0) + 1;
      nameAttempts.set(accountId, n);
      log('昵称识别为空: ' + accountId + ' source=' + (res && res.source) + ' | 候选数=' + cands.length +
        (cands.length ? ' | 首个=' + String(cands[0]).slice(0, 90) : '') +
        ' | 尝试次数=' + n);
      // 未成功则安排重试(接口数据稍后才完整), 最多 20 次 × 10 秒
      if (n < 20 && !force) {
        setTimeout(() => { tryAutoRename(accountId, false); }, 10000);
      }
      // 首次失败时打印候选数(重试由上方定时器负责)
      if (n === 1 && cands.length === 0) {
        log('提示: ' + accountId + ' 暂无候选接口, 页面可能尚未发起用户信息请求');
      }
      return;
    }
    nameAttempts.delete(accountId);
    const list2 = loadAccounts();
    const acc2 = list2.find(a => a.id === accountId);
    if (!acc2 || acc2.label === name) return;
    const wasDefault = /^账号\s*\d+$/.test(acc2.label);
    acc2.label = name;
    saveAccounts(list2);
    log('昵称识别成功: ' + name + ' (' + accountId + ') source=' + res.source + (wasDefault ? ' [自动]' : ' [手动触发]'));
    pushToRenderer('account:ready', { id: accountId, label: name });
  } catch (e) { log('昵称识别异常: ' + e.message); }
}

// ---------- 视图池 ----------
function markBadge(id, st) {
  badges.set(id, st);
  pushToRenderer('badge:update', { id, status: st });
}

function createViewForAccount(account) {
  ensureSessionHooks(account.id);
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:' + account.id,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  view.__retries = 0;
  const wc = view.webContents;

  wc.setUserAgent(CHROME_UA);

  // webdriver 补丁在 dom-ready 打(比 did-start-loading 更稳)
  wc.on('dom-ready', () => {
    wc.executeJavaScript(WEBDRIVER_PATCH, true).catch(() => {});
  });

  // 崩溃自愈: 渲染进程崩溃后自动重建同分区视图
  wc.on('render-process-gone', (e, detail) => {
    log('渲染进程退出: ' + account.id + ' reason=' + detail.reason);
    setTimeout(() => recreateView(account.id), 800);
  });

  // 加载失败: 自动重试 3 次, 之后标记 loadfail 由用户点击重试
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3=ABORTED(跳转被打断,忽略)
    log('加载失败: ' + account.id + ' code=' + code + ' url=' + url);
    if (view.__retries < 3) {
      view.__retries++;
      setTimeout(() => {
        try { if (!wc.isDestroyed()) wc.loadURL(DOUBAO_URL); } catch (err) {}
      }, 1200 * view.__retries);
    } else {
      markBadge(account.id, 'loadfail');
    }
  });
  wc.on('did-finish-load', () => {
    view.__retries = 0;
    const acc = loadAccounts().find(a => a.id === account.id);
    if (acc && acc.pending) markBadge(account.id, 'pending');
    else if (badges.get(account.id) !== 'offline') markBadge(account.id, 'online');
    // 已登录但仍是默认名的账号: 页面每次加载完自动尝试识别昵称
    if (acc && !acc.pending) setTimeout(() => tryAutoRename(account.id, false), 1000);
  });

  // 弹窗一律交给系统浏览器
  wc.setWindowOpenHandler(({ url }) => {
    log('拦截新窗口: ' + url);
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(DOUBAO_URL).then(() => {
    log('视图加载完成: ' + account.label);
  }).catch((e) => log('视图加载失败: ' + account.label + ' ' + e.message));
  return view;
}

// 崩溃/异常后的重建: 保持分区不变, 若是当前激活视图则重新挂载
function recreateView(accountId) {
  const acc = loadAccounts().find(a => a.id === accountId);
  if (!acc) return;
  const old = viewPool.get(accountId);
  const wasActive = (activeAccountId === accountId);
  if (old) {
    try { mainWindow.contentView.removeChildView(old); } catch (e) {}
    try { if (!old.webContents.isDestroyed()) old.webContents.close(); } catch (e) {}
    viewPool.delete(accountId);
  }
  const nv = createViewForAccount(acc);
  viewPool.set(accountId, nv);
  if (wasActive && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(nv);
    nv.setBounds(getContentBounds());
  }
  log('视图已重建: ' + accountId);
}

// ---------- 切号核心 ----------
function setActiveAccount(id) {
  const account = loadAccounts().find(a => a.id === id);
  if (!account) return false;

  if (activeAccountId && viewPool.has(activeAccountId)) {
    try { mainWindow.contentView.removeChildView(viewPool.get(activeAccountId)); } catch (e) {}
  }
  if (!viewPool.has(id)) {
    viewPool.set(id, createViewForAccount(account));
    log('视图池新建: ' + account.label);
  }
  const view = viewPool.get(id);
  mainWindow.contentView.addChildView(view);
  view.setBounds(getContentBounds());
  activeAccountId = id;
  prefs.lastActiveId = id;
  savePrefs();
  log('切换账号: ' + account.label + ' (池=' + viewPool.size + ')');

  // 兜底: 已登录但仍是默认名的账号, 切过去后给一次识别机会
  if (!account.pending && /^账号\s*\d+$/.test(account.label)) {
    setTimeout(() => tryAutoRename(id, false), 4000);
  }
  return true;
}

function getActiveView() {
  if (!activeAccountId) return null;
  const v = viewPool.get(activeAccountId);
  return (v && !v.webContents.isDestroyed()) ? v : null;
}

// ---------- 登录监控 ----------
function clearMonitor(id) {
  const m = monitors.get(id);
  if (m) {
    if (m.timer) clearInterval(m.timer);
    if (m.diag) clearInterval(m.diag);
    monitors.delete(id);
  }
}

async function checkStrongCookie(accountId) {
  try {
    const cookies = await session.fromPartition('persist:' + accountId).cookies.get({ domain: '.doubao.com' });
    return cookies.some(c => !ANON_RE.test(c.name) && AUTH_RE.test(c.name));
  } catch (e) { return false; }
}

function startLoginMonitor(accountId) {
  if (monitors.has(accountId)) return; // 防重入
  const m = { timer: null, diag: null, done: false };
  monitors.set(accountId, m);

  const getViewWC = () => {
    const v = viewPool.get(accountId);
    return (v && !v.webContents.isDestroyed()) ? v.webContents : null;
  };

  const finish = async (how) => {
    if (m.done) return;
    m.done = true;
    clearMonitor(accountId);
    const list = loadAccounts();
    const acc = list.find(a => a.id === accountId);
    if (!acc) return;

    if (how === 'success') {
      acc.pending = false;
      acc.addedAt = Date.now();
      saveAccounts(list);
      markBadge(accountId, 'online');
      pushToRenderer('account:ready', { id: accountId, label: acc.label });
      // 登录成功后自动识别昵称(走统一的多策略识别)
      setTimeout(() => tryAutoRename(accountId, false), 2000);
    } else {
      markBadge(accountId, 'pending');
      pushToRenderer('account:login-timeout', { id: accountId });
    }
  };

  const pollAll = async () => {
    if (m.done) return;
    const hasAuth = await checkStrongCookie(accountId);
    if (hasAuth) {
      log('登录成功(强凭证cookie): ' + accountId);
      finish('success');
    }
  };

  const wc = getViewWC();
  if (wc) {
    wc.on('did-navigate', pollAll);
    wc.on('did-navigate-in-page', pollAll);
    wc.once('did-finish-load', () => {
      setTimeout(() => {
        if (!m.done) {
          pollAll();
          m.timer = setInterval(pollAll, 2000);
        }
      }, 2500);
    });
    // 诊断日志: 每 10 秒一条, 仅登录期
    m.diag = setInterval(async () => {
      const w2 = getViewWC();
      if (!w2) return;
      try {
        const u = w2.getURL();
        log('[登录诊断] ' + accountId + ' url=' + u.slice(0, 90));
      } catch (e) {}
    }, 10000);
  }
  // 5 分钟超时(保持待登录状态, 用户可继续扫码或删除)
  setTimeout(() => { if (!m.done) finish('timeout'); }, 5 * 60 * 1000);
}

// 点添加账号: 新建视图, 直接在视图里扫码, 检测到凭证自动转正
function startLoginInView() {
  return new Promise((resolve) => {
    const tempId = 'acct-' + Date.now();
    const accounts = loadAccounts();
    // 编号取现有"账号 N"的最大值+1, 避免并发添加时重名
    let maxN = 0;
    accounts.forEach(a => {
      const m = /^账号\s*(\d+)$/.exec(a.label);
      if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
    });
    const account = {
      id: tempId,
      label: '账号 ' + (maxN + 1),
      color: PALETTE[accounts.length % PALETTE.length],
      note: '',
      addedAt: Date.now(),
      pending: true
    };
    accounts.push(account);
    saveAccounts(accounts);
    markBadge(tempId, 'pending');
    setActiveAccount(tempId);
    log('视图内登录开始: ' + tempId);
    startLoginMonitor(tempId);
    resolve({ id: tempId, label: account.label });
  });
}

// ---------- 保活/掉线检测(强凭证版, 每 45 秒) ----------
function startKeepAlive() {
  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const accounts = loadAccounts();
    for (const acc of accounts) {
      if (acc.pending) continue;
      const has = await checkStrongCookie(acc.id);
      const cur = badges.get(acc.id) || 'online';
      if (!has && cur !== 'offline') {
        markBadge(acc.id, 'offline');
        log('检测到掉线(凭证消失): ' + acc.label);
        const list = loadAccounts();
        const a = list.find(x => x.id === acc.id);
        if (a) { a.pending = true; saveAccounts(list); }
        pushToRenderer('account:logout', { id: acc.id, label: acc.label });
      } else if (has && cur === 'offline') {
        // 凭证又回来了(用户在同一视图重新登录)
        const list = loadAccounts();
        const a = list.find(x => x.id === acc.id);
        if (a) { a.pending = false; saveAccounts(list); }
        markBadge(acc.id, 'online');
        pushToRenderer('account:ready', { id: acc.id, label: a ? a.label : acc.label });
      }
    }
  }, 45000);
}

// ---------- 删除账号(含分区清理三连兜底 + 待清扫机制) ----------
async function deleteAccountDeep(id) {
  // 1. 清监控与视图(释放句柄)
  clearMonitor(id);
  if (viewPool.has(id)) {
    try { mainWindow.contentView.removeChildView(viewPool.get(id)); } catch (e) {}
    try { viewPool.get(id).webContents.close(); } catch (e) {}
    viewPool.delete(id);
    if (activeAccountId === id) activeAccountId = null;
  }
  // 2. 清内存态 session 数据
  try {
    const ses = session.fromPartition('persist:' + id);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
    await ses.clearCache();
  } catch (e) { log('session 清理失败: ' + e.message); }
  await new Promise(r => setTimeout(r, 250));

  // 3. 删分区目录: fs.rmSync → PowerShell .NET → cmd rmdir
  const partDir = path.join(USER_DIR, 'Partitions', id);
  if (!fs.existsSync(partDir)) { log('分区目录不存在: ' + id); return; }
  let cleaned = false;
  try {
    fs.rmSync(partDir, { recursive: true, force: true });
    cleaned = !fs.existsSync(partDir);
  } catch (e1) { log('rmSync 失败: ' + e1.message); }
  if (!cleaned) {
    try {
      const psScript = "$t='" + partDir.replace(/\\/g, '\\\\') + "'; if (Test-Path -LiteralPath $t) { [System.IO.Directory]::Delete($t, $true) }";
      require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e2) {}
  }
  if (!cleaned) {
    try {
      require('child_process').execFileSync('cmd.exe', ['/c', 'rmdir', '/S', '/Q', partDir], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e3) {}
  }
  if (!cleaned) {
    log('三种删除均失败, 记入待清扫: ' + id);
    try {
      const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
      let pend = [];
      if (fs.existsSync(pendFile)) pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
      if (pend.indexOf(id) < 0) pend.push(id);
      fs.writeFileSync(pendFile, JSON.stringify(pend, null, 2));
    } catch (e4) {}
  } else {
    log('分区已清除: ' + id);
  }
  // 4. 顺带清掉该账号的下载目录(若有)
  const dlDir = path.join(DOWNLOAD_DIR, id);
  try {
    if (fs.existsSync(dlDir)) {
      const left = fs.readdirSync(dlDir);
      if (left.length === 0) {
        fs.rmdirSync(dlDir);
        log('已清理空下载目录: ' + id);
      } else {
        log('下载目录有文件, 保留待用户处理: ' + dlDir + ' (' + left.length + ' 项)');
      }
    }
  } catch (e5) {}
}

function sweepPendingCleanups() {
  try {
    const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
    if (!fs.existsSync(pendFile)) return;
    const pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
    if (!pend.length) return;
    const remaining = [];
    for (const id of pend) {
      const p = path.join(USER_DIR, 'Partitions', id);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); log('启动清扫分区: ' + id); }
        catch (e) { remaining.push(id); }
      }
    }
    fs.writeFileSync(pendFile, JSON.stringify(remaining, null, 2));
  } catch (e) { log('sweepPendingCleanups 异常: ' + e.message); }
}

// ---------- 推送到渲染层 ----------
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- 主窗口 ----------
function createMainWindow() {
  const b = prefs.winBounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: (typeof b.x === 'number') ? b.x : undefined,
    y: (typeof b.y === 'number') ? b.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5f5f7',
    title: '豆包多开管理器',
    show: false,
    icon: path.join(APP_DIR, 'app.ico'),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // 尺寸变化同步给激活视图
  const syncBounds = () => {
    if (activeAccountId && viewPool.has(activeAccountId)) {
      try { viewPool.get(activeAccountId).setBounds(getContentBounds()); } catch (e) {}
    }
  };
  mainWindow.on('resize', syncBounds);
  mainWindow.on('maximize', syncBounds);
  mainWindow.on('restore', syncBounds);
  mainWindow.on('enter-full-screen', syncBounds);
  mainWindow.on('leave-full-screen', syncBounds);

  // 记录窗口位置
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    prefs.winBounds = mainWindow.getBounds();
    savePrefs();
  };
  mainWindow.on('close', (e) => {
    saveBounds();
    if (prefs.closeToTray && !forceQuitting.value) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        try { tray.displayBalloon({ title: '豆包多开管理器', content: '已最小化到托盘, 双击图标可恢复。' }); } catch (e2) {}
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; activeAccountId = null; });
  mainWindow.loadFile('index.html').catch((e) => log('loadFile 失败: ' + e.message));
}

// ---------- 缩放(作用于豆包页面本身) ----------
function zoomActive(delta) {
  const v = getActiveView();
  if (!v) return;
  let lvl = v.webContents.getZoomLevel();
  let next = delta === 0 ? 0 : Math.max(-4, Math.min(4, lvl + delta));
  v.webContents.setZoomLevel(next);
}

function reloadActiveView() {
  const v = getActiveView();
  if (v) {
    v.__retries = 0;
    v.webContents.loadURL(DOUBAO_URL).catch(() => {});
  }
}

function selectByIndex(i) {
  const accounts = loadAccounts();
  if (i < 0 || i >= accounts.length) return;
  setActiveAccount(accounts[i].id);
  pushToRenderer('active:changed', { id: accounts[i].id });
}

// ---------- 应用菜单 ----------
function buildAppMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '添加豆包账号', accelerator: 'CmdOrCtrl+N', click: () => pushToRenderer('menu:addAccount') },
        { label: '打开下载目录', click: () => { try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); shell.openExternal('file:///' + DOWNLOAD_DIR.replace(/\\/g, '/')); } catch (e) {} } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Shift+Q', click: () => { forceQuitting.value = true; app.quit(); } }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '重新加载当前页', accelerator: 'CmdOrCtrl+R', click: () => reloadActiveView() },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoomActive(+0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '切换(&S)',
      submenu: (() => {
        const arr = [];
        for (let i = 1; i <= 9; i++) {
          arr.push({
            label: '第 ' + i + ' 个账号',
            accelerator: 'CmdOrCtrl+' + i,
            click: () => selectByIndex(i - 1)
          });
        }
        return arr;
      })()
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于', click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '豆包多开管理器 v3.0',
              detail: '视图池架构 · 单窗口毫秒级切号\n数据目录: ' + USER_DIR + '\n\n原理: 使用 Chromium 分区会话隔离各账号,\n不修改豆包官方程序。'
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 托盘 ----------
function buildTray() {
  try {
    const icoPath = path.join(APP_DIR, 'app.ico');
    tray = new Tray(nativeImage.createFromPath(icoPath));
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('豆包多开管理器');
  tray.on('double-click', () => ShowMain());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [];
  const accounts = loadAccounts();
  for (const acc of accounts.slice(0, 15)) {
    items.push({
      label: ((badges.get(acc.id) === 'offline' || acc.pending) ? '○ ' : '● ') + acc.label,
      click: () => {
        setActiveAccount(acc.id);
        ShowMain();
      }
    });
  }
  if (accounts.length) items.push({ type: 'separator' });
  items.push({ label: '显示主窗口', click: () => ShowMain() });
  items.push({
    label: '退出',
    click: () => { forceQuitting.value = true; app.quit(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function ShowMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// ---------- IPC ----------
ipcMain.handle('accounts:list', () => {
  const accounts = loadAccounts();
  return accounts.map(a => Object.assign({}, a, {
    badge: a.pending ? 'pending' : (badges.get(a.id) || 'online')
  }));
});
ipcMain.handle('accounts:add', async () => await startLoginInView());
ipcMain.handle('accounts:select', (e, id) => { setActiveAccount(id); return true; });
ipcMain.handle('accounts:rename', (e, payload) => {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === payload.id);
  if (acc) { acc.label = String(payload.label).trim().slice(0, 20); saveAccounts(accounts); }
  return accounts;
});
ipcMain.handle('accounts:delete', async (e, id) => {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  badges.delete(id);
  await deleteAccountDeep(id);
  rebuildTrayMenu();
  return accounts;
});
ipcMain.handle('accounts:detectName', async (e, id) => {
  const list = loadAccounts();
  const acc = list.find(a => a.id === id);
  if (!acc || acc.pending) return { ok: false, msg: '账号待登录' };
  const v = viewPool.get(id);
  if (!v || v.webContents.isDestroyed()) return { ok: false, msg: '请先切换到该账号(视图未加载)' };
  try {
    const res = await v.webContents.executeJavaScript(DETECT_NAME_SCRIPT, true);
    const name = res && res.name ? String(res.name).trim() : '';
    if (name) {
      acc.label = name;
      saveAccounts(list);
      pushToRenderer('account:ready', { id, label: name });
      return { ok: true, name };
    }
    return { ok: false, msg: '未能从页面识别到昵称(' + (res ? res.source : '?') + ')' };
  } catch (err) { return { ok: false, msg: err.message }; }
});
ipcMain.handle('prefs:get', () => prefs);
ipcMain.handle('prefs:set', (e, patch) => {
  prefs = Object.assign(prefs, patch || {});
  savePrefs();
  return prefs;
});
ipcMain.handle('downloads:openFolder', () => {
  try {
    fs.mkdirSync(path.join(DOWNLOAD_DIR, activeAccountId || '_通用'), { recursive: true });
    shell.openExternal('file:///' + DOWNLOAD_DIR.replace(/\\/g, '/'));
  } catch (e) {}
  return true;
});

// 支持作者: 独立子窗口(原生窗口才能覆盖 WebContentsView)
let supportWin = null;
function openSupportWindow() {
  supTipStop(); // 打开大窗口时收起迷你预览
  if (supportWin && !supportWin.isDestroyed()) { supportWin.focus(); return; }
  supportWin = new BrowserWindow({
    width: 680,
    height: 720,
    resizable: true,
    backgroundColor: '#ffffff',
    title: '支持作者',
    icon: path.join(APP_DIR, 'app.ico'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  supportWin.loadFile('support.html');
  supportWin.on('closed', () => { supportWin = null; });
}
ipcMain.handle('support:open', () => { openSupportWindow(); return true; });

// 悬停迷你预览卡: 无边框/不抢焦点/置顶原生小窗
// 显示策略: 窗口底部锚定在鼠标位置向上延展; 轮询光标位置——
//   光标位于 [窗口区域 ∪ 锚点元素] 内则保持, 都离开才隐藏(挪走后消失, 不来回弹)
let supTipWin = null;
let supTipPoll = null;
let supTipZone = null; // { win:{x,y,w,h}, anchor:{x,y,w,h} }
const SUP_TIP_W = 440, SUP_TIP_H = 500;
function supTipStop() {
  if (supTipPoll) { clearInterval(supTipPoll); supTipPoll = null; }
  supTipZone = null;
  if (supTipWin && !supTipWin.isDestroyed()) supTipWin.hide();
}
function supTipInside(p, r, margin) {
  const m = margin || 0;
  return p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;
}
function showSupTipWindow(ax, ay, aw, ah) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const b = mainWindow.getContentBounds();
  const elX = b.x + (typeof ax === 'number' ? ax : 8);
  const elY = b.y + (typeof ay === 'number' ? ay : 0);
  const elW = (typeof aw === 'number' && aw > 0) ? aw : 120;
  const elH = (typeof ah === 'number' && ah > 0) ? ah : 30;

  let wa;
  const cur = screen.getCursorScreenPoint();
  try { wa = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y }).workArea; }
  catch (e) { wa = { x: 0, y: 0, width: 1920, height: 1040 }; }

  if (!supTipWin || supTipWin.isDestroyed()) {
    supTipWin = new BrowserWindow({
      width: SUP_TIP_W, height: SUP_TIP_H,
      frame: false, resizable: false, movable: false,
      minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true,
      focusable: false, show: false,
      backgroundColor: '#ffffff',
      title: '支持作者',
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        preload: path.join(APP_DIR, 'preload.js')
      }
    });
    supTipWin.loadFile('support.html');
    supTipWin.webContents.once('did-finish-load', () => {
      try { supTipWin.webContents.executeJavaScript("document.body.classList.add('mini');"); } catch (e) {}
    });
  }

  // 底部锚定鼠标, 向上延展; 水平从锚点元素左缘向右
  let ty = cur.y - SUP_TIP_H - 6;
  if (ty < wa.y + 8) ty = wa.y + 8;
  let tx = Math.min(Math.max(wa.x + 8, elX), wa.x + wa.width - SUP_TIP_W - 8);
  supTipWin.setPosition(tx, ty);
  supTipWin.showInactive();

  supTipZone = {
    win: { x: tx, y: ty, w: SUP_TIP_W, h: SUP_TIP_H },
    anchor: { x: elX, y: elY, w: elW, h: elH }
  };
  if (!supTipPoll) {
    supTipPoll = setInterval(() => {
      if (!supTipZone) return;
      let p;
      try { p = screen.getCursorScreenPoint(); } catch (e) { return; }
      const inWin = supTipInside(p, supTipZone.win, 8);
      const inAnchor = supTipInside(p, supTipZone.anchor, 4);
      if (!inWin && !inAnchor) supTipStop();
    }, 150);
  }
}
ipcMain.on('support:tipShow', (e, pos) => {
  showSupTipWindow(pos && pos.ax, pos && pos.ay, pos && pos.aw, pos && pos.ah);
});
ipcMain.on('support:tipHide', () => supTipStop());

// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => ShowMain());
}

// ---------- 启动流程 ----------
app.whenReady().then(() => {
  log('app ready, userData=' + app.getPath('userData'));
  sweepPendingCleanups();
  buildAppMenu();
  buildTray();
  createMainWindow();
  startKeepAlive();
  setTimeout(bootWarmup, 800);
  setInterval(rebuildTrayMenu, 15000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((e) => log('whenReady 失败: ' + e.message));

// 启动预热: 恢复上次激活账号; 其余已登录账号后台建视图(全部在线+触发昵称识别)
function bootWarmup() {
  const accounts = loadAccounts();
  if (!accounts.length) return;
  let target = accounts.find(a => a.id === prefs.lastActiveId && !a.pending);
  if (!target) target = accounts.find(a => !a.pending);
  if (!target) target = accounts[0];
  try { setActiveAccount(target.id); } catch (e) { log('warmup 激活失败: ' + e.message); }

  const others = accounts.filter(a => a.id !== target.id && !a.pending);
  others.forEach((acc, i) => {
    setTimeout(() => {
      if (!viewPool.has(acc.id)) {
        viewPool.set(acc.id, createViewForAccount(acc));
        log('后台预热视图: ' + acc.label);
      }
    }, 2500 + i * 1500);
  });
}

app.on('window-all-closed', () => {
  log('所有窗口关闭, 退出');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  log(forceQuitting.value ? '正常退出流程' : '收到退出请求(来源未标记)');
});

// 子进程(GPU/渲染器等)异常退出追踪
app.on('child-process-gone', (e, details) => {
  log('child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode);
});

process.on('uncaughtException', (err) => log('uncaughtException: ' + err.message + '\n' + (err.stack || '')));
process.on('unhandledRejection', (err) => log('unhandledRejection: ' + String(err)));
