// 渲染进程: 侧栏账号列表 + 状态徽标 + 双击就地改名 + 偏好
const listEl = document.getElementById('accountList');
const btnAdd = document.getElementById('btnAdd');
const mainTip = document.getElementById('mainTip');
const chkTray = document.getElementById('chkTray');
const toastWrap = document.getElementById('toastWrap');

let accounts = [];
let currentId = null;

const BADGE_TEXT = {
  online: '在线',
  pending: '待登录',
  offline: '掉线',
  loadfail: '加载失败'
};

async function refresh() {
  accounts = await window.api.accountsList();
  if (!editing) render(); // 就地编辑期间冻结重建, 防止输入框被冲掉
}

function render() {
  if (editing) return;
  if (accounts.length === 0) {
    listEl.innerHTML = '<div class="empty-tip">还没有账号<br>点上方按钮新建一个豆包页面,<br>直接扫码登录即可</div>';
    return;
  }
  // 保持激活态在刷新后不丢
  const activeStillExists = accounts.some(a => a.id === currentId);
  if (!activeStillExists && accounts.length > 0 && currentId !== null) {
    currentId = null;
  }
  listEl.innerHTML = '';
  accounts.forEach((acc, idx) => {
    const item = document.createElement('div');
    item.className = 'account-item' + (acc.id === currentId ? ' active' : '');
    item.dataset.badge = acc.badge || 'online';
    item.title = 'Ctrl+' + (idx + 1) + ' 可快速切换 · 双击名称改名';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = acc.color || '#4F86F7';

    const span = document.createElement('span');
    span.className = 'acc-name';
    span.textContent = (idx + 1) + '. ' + acc.label;
    span.title = '双击可就地编辑名称';
    span.ondblclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      startInlineEdit(span, acc);
    };
    span.addEventListener('mousedown', e => {
      // 双击时阻止浏览器默认文本选中, 避免视觉抖动
      if (e.detail > 1) e.preventDefault();
    });

    const badge = document.createElement('span');
    badge.className = 'badge ' + (acc.badge || 'online');
    badge.textContent = BADGE_TEXT[acc.badge] || acc.badge;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = '删除此账号(含其全部本地数据)';
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('删除账号「' + acc.label + '」?\n该账号的登录态与页面数据会一并清理。')) return;
      await window.api.accountsDelete(acc.id);
      if (currentId === acc.id) currentId = null;
      refresh();
    };

    item.appendChild(avatar);
    item.appendChild(span);
    item.appendChild(badge);
    item.appendChild(del);
    item.onclick = () => {
      if (editing) return;
      if (currentId === acc.id) return; // 重复点同一个账号不重绘(双击改名的前提)
      selectAccount(acc.id);
    };
    listEl.appendChild(item);
  });
}

async function selectAccount(id) {
  currentId = id;
  await window.api.accountsSelect(id);
  mainTip.style.display = 'none';
  render();
}

btnAdd.onclick = async () => {
  btnAdd.disabled = true;
  try {
    const acc = await window.api.accountsAdd();
    if (acc) { currentId = acc.id; mainTip.style.display = 'none'; }
  } finally {
    btnAdd.disabled = false;
    await refresh();
  }
};

// ---- 双击就地编辑改名(无弹窗) ----
let editing = false;
function startInlineEdit(spanEl, acc) {
  if (editing) return;
  editing = true;
  const original = acc.label;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = original;
  input.maxLength = 20;
  spanEl.textContent = '';
  spanEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    editing = false;
    const val = input.value.trim();
    if (save && val && val !== original) {
      window.api.accountsRename(acc.id, val).then(() => refresh());
    } else {
      refresh(); // 还原显示
    }
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---- 推送事件 ----
window.api.onAccountReady(() => refresh());
window.api.onAccountLogout(() => refresh());
window.api.onLoginTimeout((d) => {
  toast('「' + (d.label || d.id) + '」5 分钟内未检测到登录，可继续扫码或删除重加。');
});
window.api.onBadgeUpdate(() => {
  refreshSoon(); // 徽标由主进程合并进列表, 局部节流刷新
});
window.api.onActiveChanged((d) => {
  currentId = d.id;
  mainTip.style.display = 'none';
  render();
});
window.api.onDownloadDone((d) => {
  toast('📥 下载完成: ' + d.file, d.dir);
});

// ---- 菜单事件 ----
window.api.onMenuAdd(() => btnAdd.onclick());

// ---- 偏好 ----
(async () => {
  const prefs = await window.api.prefsGet();
  chkTray.checked = prefs.closeToTray !== false;
})();
chkTray.onchange = async () => {
  await window.api.prefsSet({ closeToTray: chkTray.checked });
};
document.getElementById('lnkDl').onclick = (e) => {
  e.preventDefault();
  window.api.openDownloads();
};

// ---- 作者爱心 / 支持作者(独立子窗口, 原生窗口可覆盖豆包视图) ----
const btnHeart = document.getElementById('btnHeart');
const supAuthor = document.getElementById('supAuthor');
btnHeart.addEventListener('click', () => {
  const path = document.getElementById('heartPath');
  path.setAttribute('fill', '#ff2d55');
  window.api.openSupport();
});
supAuthor.addEventListener('click', () => window.api.openSupport());

// ---- 悬停迷你预览卡(原生小窗, 底部锚定鼠标向上延展, 挪走后消失) ----
function showSupTip(anchor) {
  const r = anchor.getBoundingClientRect();
  window.api.supportTipShow({ ax: r.left, ay: r.top, aw: r.width, ah: r.height });
}
function bindSupTip(el) {
  el.addEventListener('mouseenter', () => showSupTip(el));
  // 隐藏由主进程轮询光标位置决定: 离开[窗口∪锚点]才消失
}
bindSupTip(btnHeart);
bindSupTip(supAuthor);

// ---- 工具 ----
function toast(text, openDir) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text + ' ';
  if (openDir) {
    const b = document.createElement('b');
    b.textContent = '[打开目录]';
    b.onclick = () => window.api.openDownloads();
    t.appendChild(b);
  }
  toastWrap.appendChild(t);
  setTimeout(() => { t.remove(); }, 6000);
}

let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 300);
}

refresh();
