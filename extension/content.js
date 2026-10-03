/**
 * 抖音点歌助手 · 面板脚本（隔离环境）
 *
 * 只负责两件事：
 *   1) 连本机点歌服务的 WebSocket，显示当前歌曲 / 队列 / 连接状态
 *   2) 提供「下一首」「打开控制台」按钮
 *
 * 真正的弹幕转发在 inject.js（world: MAIN）里，两者通过 DOM dataset 交换状态。
 */
(function () {
  'use strict';

  const DEFAULT_SERVER = 'http://127.0.0.1:8787';
  let server = DEFAULT_SERVER;
  try {
    server = (localStorage.getItem('dsr_server') || DEFAULT_SERVER).replace(/\/$/, '');
  } catch {
    /* ignore */
  }
  const wsUrl = server.replace(/^http/, 'ws') + '/ws/audio';

  let ws = null;
  let reconnectTimer = null;
  let lastFrameSeen = 0;

  /* ------------------------------ 小窗 ------------------------------ */

  function buildPanel() {
    if (document.getElementById('dsr-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'dsr-panel';
    panel.innerHTML = `
      <div class="dsr-head">
        <i class="dsr-dot" id="dsr-dot"></i>
        <span id="dsr-status">连接中…</span>
        <span style="flex:1"></span>
        <button class="dsr-min" id="dsr-min" title="收起/展开">–</button>
      </div>
      <div class="dsr-body">
        <div class="dsr-title" id="dsr-title">等待点歌…</div>
        <div class="dsr-sub" id="dsr-sub">弹幕发「点歌 歌名」即可</div>
        <div class="dsr-next" id="dsr-next">队列为空</div>
        <div class="dsr-row">
          <button id="dsr-skip">⏭ 下一首</button>
          <button id="dsr-console">控制台</button>
        </div>
      </div>`;
    document.body.appendChild(panel);

    const toast = document.createElement('div');
    toast.id = 'dsr-toast';
    document.body.appendChild(toast);

    document.getElementById('dsr-min').onclick = () => panel.classList.toggle('dsr-collapsed');
    document.getElementById('dsr-skip').onclick = () => send({ type: 'skip' });
    document.getElementById('dsr-console').onclick = () => window.open(server + '/', '_blank');

    // 拖动
    const head = panel.querySelector('.dsr-head');
    let dragging = false;
    let sx = 0;
    let sy = 0;
    let ox = 0;
    let oy = 0;
    head.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      const rect = panel.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function setStatus(text, on) {
    const dot = document.getElementById('dsr-dot');
    const label = document.getElementById('dsr-status');
    if (!dot || !label) return;
    dot.className = 'dsr-dot' + (on ? ' on' : '');
    label.textContent = text;
  }

  let toastTimer = null;
  function showToast(title, sub) {
    const el = document.getElementById('dsr-toast');
    if (!el) return;
    el.innerHTML = `<b>${escapeHtml(title)}</b>${sub ? `<br><span style="color:#8b98a9">${escapeHtml(sub)}</span>` : ''}`;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 6000);
  }

  function renderState(state) {
    if (!state) return;
    const cur = state.current;
    const titleEl = document.getElementById('dsr-title');
    const subEl = document.getElementById('dsr-sub');
    if (!titleEl) return;
    if (cur) {
      const pick = cur.pick || {};
      titleEl.textContent = (pick.cleanTitle || pick.title || cur.song || '').slice(0, 60);
      subEl.innerHTML = `<span class="dsr-who">${escapeHtml(cur.nickname)}</span> 点的 · ${escapeHtml(pick.author || '')}`;
    } else {
      titleEl.textContent = '等待点歌…';
      subEl.textContent = '弹幕发「点歌 歌名」即可';
    }
    const queue = (state.queue || []).filter((q) => q.status === 'queued' || q.status === 'searching');
    const nextEl = document.getElementById('dsr-next');
    if (nextEl) {
      nextEl.textContent = queue.length
        ? `队列 ${queue.length} 首：${queue.slice(0, 3).map((q) => q.song).join(' / ')}${queue.length > 3 ? ' …' : ''}`
        : '队列为空';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ---------------------------- 连接与心跳 ---------------------------- */

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => setStatus('已连接本机服务', true);
    ws.onclose = () => {
      setStatus('本机服务未连接', false);
      scheduleReconnect();
    };
    ws.onerror = () => setStatus('本机服务未连接', false);
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'state' || msg.type === 'hello') renderState(msg.state);
      if (msg.type === 'toast' && msg.toast) showToast(msg.toast.text, msg.toast.sub);
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 4000);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /** 读取主世界注入脚本写在 DOM 上的转发状态 */
  function readInjectStatus() {
    const root = document.documentElement;
    const frames = Number(root.dataset.dsrFrames || 0);
    const lastAt = Number(root.dataset.dsrLastAt || 0);
    const found = root.dataset.dsrFound === 'true';
    const error = root.dataset.dsrError || '';
    return { frames, lastAt, found, error };
  }

  function boot() {
    buildPanel();
    connect();
    setInterval(() => {
      const st = readInjectStatus();
      if (st.frames > 0 && Date.now() - st.lastAt < 30000) {
        if (st.frames !== lastFrameSeen) {
          lastFrameSeen = st.frames;
        }
        setStatus(`弹幕转发中（${st.frames} 帧）`, true);
      } else if (ws && ws.readyState === 1) {
        setStatus(st.found ? '已连上抖音弹幕，等待数据…' : '已连接本机服务', true);
      }
      if (st.error) showToast('转发失败', st.error);
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
