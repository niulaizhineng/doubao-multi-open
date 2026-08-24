// 支持作者窗口: 收款码缺图占位 + Esc 关闭 + QQ群号一键复制
document.querySelectorAll('.card img').forEach(img => {
  img.addEventListener('error', () => {
    img.style.display = 'none';
    const ph = img.parentElement.querySelector('.ph');
    if (ph) ph.style.display = 'flex';
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

// QQ群号复制
const btnCopyQq = document.getElementById('btnCopyQq');
btnCopyQq.addEventListener('click', async (e) => {
  e.stopPropagation(); // 复制时不要触发"打开大窗口"
  const text = document.getElementById('qqNum').textContent.trim();
  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // 兜底: 老式 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    ta.remove();
  }
  const tip = document.getElementById('copyTip');
  tip.textContent = ok ? '已复制 ✓' : '复制失败';
  tip.classList.add('show');
  setTimeout(() => tip.classList.remove('show'), 1500);
});

// 迷你预览模式下: 点击任意处 → 打开完整支持窗口
document.addEventListener('click', () => {
  if (document.body.classList.contains('mini') && window.api && window.api.openSupport) {
    window.api.openSupport();
  }
});
