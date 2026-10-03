'use strict';
/**
 * 实时监控点歌状态（直播调试用）
 * 用法: node scripts/watch.js [秒数]
 */
const SECONDS = Number(process.argv[2]) || 180;

const get = async (p) => {
  try {
    const r = await fetch('http://127.0.0.1:8787' + p);
    return await r.json();
  } catch {
    return null;
  }
};

const t = () => new Date().toTimeString().slice(0, 8);

(async () => {
  console.log('════════ 实时监控（' + SECONDS + ' 秒）════════');
  console.log('现在发弹幕「点歌 xxx」试试，每一步都会显示在这里\n');

  let lastStats = null;
  let lastSong = '';
  let lastStatus = '';
  let lastQueue = -1;
  const end = Date.now() + SECONDS * 1000;

  while (Date.now() < end) {
    const st = await get('/api/state');
    const h = await get('/api/health');
    if (!st || !h) {
      console.log('[' + t() + '] ⚠️ 服务无响应');
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const s = st.stats || {};
    // 弹幕/点歌统计变化
    if (lastStats) {
      if (s.chatSeen > lastStats.chatSeen) {
        console.log('[' + t() + '] 💬 收到弹幕 +' + (s.chatSeen - lastStats.chatSeen) + '（累计 ' + s.chatSeen + '）');
      }
      if (s.requests > lastStats.requests) {
        console.log('[' + t() + '] 🎵 点歌请求 +' + (s.requests - lastStats.requests));
      }
      if (s.rejected > lastStats.rejected) console.log('[' + t() + '] 🚫 被过滤 +' + (s.rejected - lastStats.rejected));
      if (s.failed > lastStats.failed) console.log('[' + t() + '] ❌ 搜歌失败 +' + (s.failed - lastStats.failed));
      if (s.retried > lastStats.retried) console.log('[' + t() + '] 🔄 自动重试 +' + (s.retried - lastStats.retried));
    }
    lastStats = s;

    // 当前歌变化
    const cur = st.current || {};
    const songKey = (cur.song || '') + '|' + (cur.status || '');
    if (songKey !== lastSong + '|' + lastStatus && cur.song) {
      console.log('[' + t() + '] ▶ 当前: ' + cur.song + ' [' + cur.status + ']');
      if (cur.pick && cur.pick.title) {
        console.log('       选中: ' + String(cur.pick.title).slice(0, 46));
        console.log('       UP: ' + (cur.pick.owner || '?') + ' | ' + (cur.pick.duration || '?') + 's | ' +
          (cur.pick.fromCollection ? '📚合集' : '散装'));
      }
      if (cur.failReason) console.log('       失败: ' + cur.failReason);
      if (cur.retryInfo) console.log('       重试: ' + JSON.stringify(cur.retryInfo));
      lastSong = cur.song || '';
      lastStatus = cur.status || '';
    }

    // 队列变化
    const q = (st.queue || []).length;
    if (q !== lastQueue) {
      if (q > 0) console.log('[' + t() + '] 📋 队列 ' + q + ' 首: ' + (st.queue || []).map((x) => x.song).join(', '));
      lastQueue = q;
    }

    // 播放页
    if (!h.ok && h.issues && h.issues.some((x) => /播放页/.test(x))) {
      // 只在第一次提醒
      if (!global.__warned) { global.__warned = true; console.log('[' + t() + '] ⚠️ 没有播放页在接收音乐（打开 http://127.0.0.1:8787/audio ）'); }
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log('\n监控结束');
  const st = await get('/api/state');
  if (st) {
    console.log('最终: ' + (st.current && st.current.song || '(无)') + ' | 弹幕 ' + st.stats.chatSeen + ' | 点歌 ' + st.stats.requests + ' | 已播 ' + st.stats.played);
  }
  process.exit(0);
})().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
