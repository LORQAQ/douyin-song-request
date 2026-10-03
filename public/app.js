/* 点歌控制台前端逻辑 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    ws: null,
    status: null,
    data: null,
    lastLogs: [],
  };

  /* ------------------------------- WebSocket ------------------------------- */

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  function connect() {
    const ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = () => {
      setBadge('badge-server', 'online', '服务：已连接');
      window.__appData = window.__appData || {};
      // 用一份最新配置预填表单
      fetch('/api/status')
        .then((r) => r.json())
        .then((data) => {
          state.status = data;
          renderForm(data);
        })
        .catch(() => {});
    };

    ws.onclose = () => {
      setBadge('badge-server', 'offline', '服务：已断开');
      setTimeout(connect, 2025);
    };

    ws.onerror = () => {};

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(msg);
    };
  }

  function send(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function handle(msg) {
    switch (msg.type) {
      case 'hello':
        if (msg.logs) {
          $('log').innerHTML = '';
          state.lastLogs = [];
          msg.logs.forEach(appendLog);
        }
        if (msg.urls) $('f-port').textContent = msg.urls.base;
        if (msg.status) renderStatus(msg.status);
        if (msg.state) renderState(msg.state);
        break;
      case 'state':
        renderState(msg.state);
        break;
      case 'status':
        if (msg.status) renderStatus(msg.status);
        if (msg.urls) $('f-port').textContent = msg.urls.base;
        break;
      case 'danmakuStatus':
        renderDanmakuStatus(msg.status);
        break;
      case 'log':
        appendLog(msg.line);
        break;
      case 'toast':
        toast(msg.toast);
        break;
      default:
        break;
    }
  }

  /* -------------------------------- 渲染 -------------------------------- */

  function setBadge(id, cls, text) {
    const el = $(id);
    if (!el) return;
    el.className = `badge ${cls}`;
    const span = el.querySelector('span');
    if (span && text) span.textContent = text;
  }

  function renderStatus(status) {
    state.status = status;
    renderDanmakuStatus(status.danmaku);
    const open = Boolean(status.audioPageOpen);
    setBadge('badge-audio', open ? 'online' : 'offline', open ? '播放页：已连接' : '播放页：未打开');
    $('badge-audio').title = open
      ? `${status.audioClients} 个播放页正在接收音乐`
      : '没有播放页在接收音乐，观众听不到声音！点右上角「打开音乐播放页」';
    if (status.biliCookie) {
      const input = $('cfg-bilicookie');
      if (input && !input.value) input.placeholder = '已配置（留空表示不修改）';
    }
    refreshWarnings();
  }

  /** 按重要程度提示：没播放页 > 没直播间号 > 没Cookie */
  function refreshWarnings() {
    const status = state.status || {};
    const cfg = status.config || {};
    const rid = (cfg.danmaku && cfg.danmaku.webRid) || '';
    if (status.audioPageOpen === false) {
      showWarn('⚠️ <b>音乐播放页没有打开</b>，现在点歌观众也听不到声音。请点右上角 <b>🔊 打开音乐播放页</b>，或按向导启动专用播放器。');
      return;
    }
    if (!rid) {
      showWarn('还没有填直播间号：在右边「直播设置」里填 <b>live.douyin.com/</b> 后面的数字，然后点「保存并重连」。');
      return;
    }
    if (!cfg.bilibili || !cfg.bilibili.cookie) {
      showWarn('建议配置 B站 Cookie（高级设置里），可以让搜索更稳、音质更高。不配也能用。');
      return;
    }
    hideWarn();
  }

  function renderDanmakuStatus(danmaku) {
    if (!danmaku) return;
    const map = { online: 'online', connecting: 'connecting', offline: 'offline', error: 'offline', idle: '' };
    const cls = map[danmaku.state] || '';
    const label = { online: '弹幕：已连接', connecting: '弹幕：连接中', offline: '弹幕：已断开', error: '弹幕：出错', idle: '弹幕：未启动' };
    setBadge('badge-danmaku', cls, label[danmaku.state] || '弹幕：未知');
    $('badge-danmaku').title = danmaku.detail || '';
  }

  function imgUrl(pic) {
    if (!pic) return '';
    return `/api/img?u=${encodeURIComponent(pic)}`;
  }

  function renderState(data) {
    if (!data) return;
    state.data = data;
    const cur = data.current;

    if (cur) {
      $('now-empty').style.display = 'none';
      $('now').style.display = 'flex';
      $('now-title').textContent = (cur.pick && (cur.pick.cleanTitle || cur.pick.title)) || cur.song;
      const pick = cur.pick || {};
      $('now-sub').innerHTML =
        `<span class="who">${escapeHtml(cur.nickname)}</span> 点的 · ${escapeHtml(pick.author || '未知UP')} · ` +
        `${formatDur(pick.duration || 0)} · 播放 ${fmtNum(pick.play || 0)} · 匹配分 ${pick.score || 0}`;
      $('now-link').innerHTML = pick.pageUrl
        ? `<a href="${pick.pageUrl}" target="_blank">${pick.bvid} 在B站打开</a> · 状态：${statusText(cur.status)}`
        : `状态：${statusText(cur.status)}`;
      $('now-cover').src = imgUrl(pick.pic) || '';
      $('play-state').textContent = '（音乐模式）';
    } else {
      $('now-empty').style.display = 'block';
      $('now').style.display = 'none';
      $('play-state').textContent = '';
    }

    // 队列
    const queue = data.queue || [];
    $('queue-count').textContent = `${queue.length} 首`;
    $('queue-empty').style.display = queue.length ? 'none' : 'block';
    $('queue').innerHTML = queue
      .map((it, i) => {
        const pick = it.pick || {};
        const sub = pick.bvid
          ? `${escapeHtml(pick.author || '')} · ${formatDur(pick.duration || 0)} · 播放 ${fmtNum(pick.play || 0)} · 匹配分 ${pick.score || 0}`
          : it.status === 'searching'
          ? '正在B站搜索…'
          : escapeHtml(it.failReason || '等待处理');
        return `<li data-id="${it.id}">
          <span class="idx">${i + 1}</span>
          <span class="q-main">
            <span class="q-title">${escapeHtml(it.song)}</span>
            <span class="q-sub">${escapeHtml(it.nickname)} 点的 · ${sub}</span>
          </span>
          <span class="tag ${it.status}">${statusText(it.status)}</span>
          <button class="ghost" data-act="promote" data-id="${it.id}" title="提前播放">↑</button>
          <button class="ghost danger" data-act="remove" data-id="${it.id}" title="移除">✕</button>
        </li>`;
      })
      .join('');

    // 待重试
    const retries = data.pendingRetries || [];
    $('retry-card').style.display = retries.length ? 'block' : 'none';
    $('retry-count').textContent = retries.length ? `${retries.length} 首` : '';
    $('retry-list').innerHTML = retries
      .map(
        (r) => `<li>
          <span class="idx">↻</span>
          <span class="q-main">
            <span class="q-title">${escapeHtml(r.song)}</span>
            <span class="q-sub">${escapeHtml(r.nickname)} 点的 · 第 ${r.attempt} 次重试 · ${Math.round(r.inMs / 1000)} 秒后</span>
          </span>
        </li>`
      )
      .join('');

    // 播放历史
    const history = data.history || [];
    $('history-count').textContent = history.length ? `${history.length} 条` : '';
    $('history-empty').style.display = history.length ? 'none' : 'block';
    $('history').innerHTML = history
      .slice(0, 12)
      .map((it) => {
        const pick = it.pick || {};
        const state = { done: '已播放', failed: '失败', skipped: '跳过' }[it.status] || it.status;
        return `<li>
          <span class="idx">${it.status === 'failed' ? '✕' : '♪'}</span>
          <span class="q-main">
            <span class="q-title">${escapeHtml(it.song)}</span>
            <span class="q-sub">${escapeHtml(it.nickname)} 点的 · ${state}${
          pick.author ? ` · ${escapeHtml(pick.author)}` : ''
        }${it.failReason ? ` · ${escapeHtml(it.failReason).slice(0, 40)}` : ''}</span>
          </span>
          <button class="ghost" data-act="replay" data-song="${escapeHtml(it.song)}" data-nick="${escapeHtml(
          it.nickname
        )}" title="重新点这首">↻</button>
        </li>`;
      })
      .join('');

    // 最近弹幕
    $('chats').innerHTML = (data.recentChats || [])
      .slice(0, 20)
      .map((c) => `<li><span class="nick">${escapeHtml(c.nickname)}</span>：${escapeHtml(c.content)}</li>`)
      .join('');

    // 统计
    const stats = data.stats || {};
    $('st-chat').textContent = stats.chatSeen || 0;
    $('st-req').textContent = stats.requests || 0;
    $('st-play').textContent = stats.played || 0;
    $('st-fail').textContent = stats.failed || 0;
    if (stats.retried) {
      $('st-play').title = `自动重试 ${stats.retried} 次，成功救回 ${stats.recovered || 0} 首`;
    }

    // 模式
    const isQueue = data.mode === 'queue';
    setBadge('badge-mode', 'online', `模式：${isQueue ? '排队播放' : '立即打断'}`);
    $('btn-mode').textContent = isQueue ? '切换为「立即打断」' : '切换为「排队播放」';
    $('btn-play-mode').textContent = data.config && data.config.useDirectStream ? '播放方式：纯音频直链' : '播放方式：内嵌播放器';

    if (data.config && typeof data.config.volume === 'number') {
      const v = Math.round(data.config.volume * 100);
      $('volume').value = v;
      $('vol-label').textContent = `${v}%`;
    }
    if (data.config) {
      state.loudnessAvailable = data.config.loudnessAvailable;
      updateNormalizeButton({
        normalizeVolume: data.config.normalizeVolume,
        loudnessAvailable: data.config.loudnessAvailable,
      });
    }
  }

  function statusText(s) {
    return { searching: '搜索中', queued: '排队中', playing: '播放中', done: '已播放', failed: '失败', skipped: '已跳过' }[s] || s;
  }

  function renderForm(status) {
    if (!status || !status.config) return;
    const cfg = status.config;
    if (cfg.danmaku) {
      $('cfg-rid').value = cfg.danmaku.webRid || '';
      $('cfg-source').value = cfg.danmaku.source || 'native';
    }
    if (cfg.trigger && cfg.trigger.keywords) $('cfg-keywords').value = cfg.trigger.keywords.join(',');
    if (cfg.bilibili) {
      $('cfg-minplay').value = cfg.bilibili.minPlay;
      $('cfg-mindur').value = cfg.bilibili.minDurationSec;
      $('cfg-maxdur').value = cfg.bilibili.maxDurationSec;
      $('cfg-blacklist').value = (cfg.bilibili.blacklistKeywords || []).join(',');
    }
    if (cfg.filter) {
      $('cfg-samewin').value = Math.round((cfg.filter.sameSongWindowMs || 0) / 60000);
      $('cfg-cooldown').value = Math.round((cfg.filter.perUserCooldownMs || 0) / 1000);
    }
    refreshWarnings();
  }

  function showWarn(html) {
    const el = $('warnbox');
    el.innerHTML = html;
    el.style.display = 'block';
  }
  function hideWarn() {
    $('warnbox').style.display = 'none';
  }

  function appendLog(line) {
    const box = $('log');
    const div = document.createElement('div');
    const t = new Date(line.time || Date.now());
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    div.className = `lv-${line.level || 'info'}`;
    div.textContent = `[${hh}:${mm}:${ss}] ${line.text}`;
    box.appendChild(div);
    while (box.childNodes.length > 300) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function toast(t) {
    if (!t) return;
    const div = document.createElement('div');
    div.innerHTML = escapeHtml(t.text || '') + (t.sub ? `<br><span class="muted">${escapeHtml(t.sub)}</span>` : '');
    if (t.kind === 'fail' || t.kind === 'reject') div.style.borderLeftColor = '#f85149';
    if (t.kind === 'play') div.style.borderLeftColor = '#3fb950';
    $('toasts').appendChild(div);
    setTimeout(() => div.remove(), 5200);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDur(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function fmtNum(n) {
    if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return String(n);
  }

  /* -------------------------------- 交互 -------------------------------- */

  $('btn-skip').onclick = () => send({ type: 'skip' });
  $('btn-undo').onclick = () => {
    send({ type: 'undo' });
    toast({ text: '已把上一首放回队列' });
  };
  $('btn-pause').onclick = () => send({ type: 'pause' });
  $('btn-resume').onclick = () => send({ type: 'resume' });
  $('btn-retry-now').onclick = () => {
    send({ type: 'retryNow' });
    toast({ text: '正在立刻重试…' });
  };
  $('btn-clear').onclick = () => {
    if (confirm('确定清空整个点歌队列吗？')) send({ type: 'clearQueue' });
  };
  $('btn-reconnect').onclick = () => {
    toast({ text: '正在重连弹幕…' });
    send({ type: 'restartDanmaku' });
  };

  $('btn-manual').onclick = async () => {
    const song = $('manual-song').value.trim();
    if (!song) return;
    $('btn-manual').disabled = true;
    try {
      const res = await fetch('/api/song', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ song, nickname: '主播手动' }),
      });
      const data = await res.json();
      toast({ text: data.ok ? `已加入：《${song}》` : `失败：${data.reason || data.message || '未知原因'}` });
      $('manual-song').value = '';
    } finally {
      $('btn-manual').disabled = false;
    }
  };

  $('btn-inject').onclick = () => {
    const text = $('manual-chat').value.trim();
    const nickname = $('manual-nick').value.trim() || '测试观众';
    if (!text) return;
    send({ type: 'injectDanmaku', text, nickname });
  };

  $('btn-mode').onclick = () => {
    const next = state.data && state.data.mode === 'queue' ? 'interrupt' : 'queue';
    send({ type: 'setMode', mode: next });
  };

  $('btn-play-mode').onclick = () => {
    const direct = !(state.data && state.data.config && state.data.config.useDirectStream);
    send({ type: 'updateConfig', patch: { playback: { useDirectStream: direct, audioMode: true } } });
    setTimeout(() => send({ type: 'skip' }), 200);
  };

  $('btn-normalize').onclick = () => {
    const on = !(state.data && state.data.config && state.data.config.normalizeVolume);
    send({ type: 'updateConfig', patch: { playback: { normalizeVolume: on } } });
    updateNormalizeButton({ normalizeVolume: on, loudnessAvailable: state.loudnessAvailable });
    toast({ text: on ? '已开启音量自动校准' : '已关闭音量自动校准' });
  };

  function updateNormalizeButton(info = {}) {
    const available = info.loudnessAvailable !== false;
    const on = info.normalizeVolume !== false;
    const btn = $('btn-normalize');
    if (!btn) return;
    if (!available) {
      btn.textContent = '音量自动校准：不可用（未装 ffmpeg）';
      btn.disabled = true;
      $('normalize-hint').innerHTML =
        '需要 ffmpeg 才能量响度。装了以后重启程序即可：把 ffmpeg.exe 放到本项目的 <span class="kbd">tools</span> 目录，' +
        '或在 config.json 里填 <span class="kbd">loudness.ffmpegPath</span>。';
      return;
    }
    btn.disabled = false;
    btn.textContent = `音量自动校准：${on ? '已开启' : '已关闭'}`;
  }

  $('volume').oninput = (e) => {
    const v = Number(e.target.value);
    $('vol-label').textContent = `${v}%`;
  };
  $('volume').onchange = (e) => send({ type: 'volume', value: Number(e.target.value) / 100 });

  $('btn-save-rid').onclick = async () => {
    const rid = $('cfg-rid').value.trim();
    send({ type: 'updateConfig', patch: { danmaku: { webRid: rid, roomId: '' } } });
    toast({ text: `直播间号已保存：${rid}，正在重连…` });
    setTimeout(() => send({ type: 'restartDanmaku' }), 300);
    hideWarn();
  };

  $('btn-save-keywords').onclick = () => {
    const keywords = $('cfg-keywords')
      .value.split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    send({ type: 'updateConfig', patch: { trigger: { keywords } } });
    toast({ text: `触发词已保存（${keywords.length} 个）` });
  };

  $('btn-save-cookie').onclick = () => {
    const cookie = $('cfg-bilicookie').value.trim();
    if (!cookie) return;
    send({ type: 'updateConfig', patch: { bilibili: { cookie } } });
    $('cfg-bilicookie').value = '';
    toast({ text: 'B站 Cookie 已保存' });
  };

  $('btn-save-blacklist').onclick = () => {
    const blacklistKeywords = $('cfg-blacklist')
      .value.split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    send({ type: 'updateConfig', patch: { bilibili: { blacklistKeywords } } });
    toast({ text: '屏蔽词已保存' });
  };

  ['cfg-minplay', 'cfg-mindur', 'cfg-maxdur', 'cfg-samewin', 'cfg-cooldown'].forEach((id) => {
    $(id).onchange = () => {
      send({
        type: 'updateConfig',
        patch: {
          bilibili: { minPlay: Number($('cfg-minplay').value), minDurationSec: Number($('cfg-mindur').value), maxDurationSec: Number($('cfg-maxdur').value) },
          filter: { sameSongWindowMs: Number($('cfg-samewin').value) * 60000, perUserCooldownMs: Number($('cfg-cooldown').value) * 1000 },
        },
      });
      toast({ text: '高级设置已保存' });
    };
  });

  $('cfg-source').onchange = () => {
    send({ type: 'updateConfig', patch: { danmaku: { source: $('cfg-source').value } } });
    toast({ text: '弹幕来源已切换，正在重连…' });
    setTimeout(() => send({ type: 'restartDanmaku' }), 300);
  };

  $('queue').onclick = (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;
    if (act === 'remove') send({ type: 'removeQueueItem', id });
    if (act === 'promote') send({ type: 'promote', id });
  };

  // 历史里点「重新点这首」
  $('history').onclick = (e) => {
    const btn = e.target.closest('button[data-act="replay"]');
    if (!btn) return;
    send({ type: 'manualSong', song: btn.dataset.song, nickname: `${btn.dataset.nick}（重播）`, force: true });
    toast({ text: `重新点《${btn.dataset.song}》` });
  };

  /* ----------------------------- 主播快捷键 ----------------------------- */

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (!e.ctrlKey && !e.metaKey) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        send({ type: 'skip' });
        toast({ text: '已跳过当前歌曲' });
        break;
      case 'z':
      case 'Z':
        e.preventDefault();
        send({ type: 'undo' });
        toast({ text: '已撤销上一步' });
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const input = $('volume');
        const next = Math.min(100, Math.max(0, Number(input.value) + (e.key === 'ArrowUp' ? 5 : -5)));
        input.value = next;
        $('vol-label').textContent = `${next}%`;
        send({ type: 'volume', value: next / 100 });
        break;
      }
      case 'm':
      case 'M':
        e.preventDefault();
        send({ type: 'toggleMute' });
        break;
      default:
        break;
    }
  });

  $('manual-song').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-manual').click();
  });
  $('manual-chat').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-inject').click();
  });

  connect();
  setInterval(() => send({ type: 'ping' }), 25000);
})();
