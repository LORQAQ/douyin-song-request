'use strict';
/** 实测俄语歌名能不能搜到、能不能匹配 */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');

const SONGS = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const LIST = SONGS.length ? SONGS : ['Катюша', 'Калинка', 'Подмосковные вечера', 'Тёмная ночь'];

(async () => {
  const c = loadConfig([]);
  const b = new BilibiliClient(c.bilibili || {}, new Logger('ru', 'error'));
  const mm = new MusicMeta(c.bilibili || {}, new Logger('ru', 'error'));

  for (const kw of LIST) {
    console.log('════ 「' + kw + '」 ════');

    // 1) B站原始搜索有没有内容
    let items = [];
    try {
      const r = await b._searchVideos(kw, 20);
      items = r.items || [];
    } catch (e) {
      console.log('   搜索失败: ' + e.message);
    }
    console.log('   原始搜索: ' + items.length + ' 条');
    items.slice(0, 3).forEach((x) => {
      console.log('      ' + String(x.duration || '').padStart(7) + '  ' + String(x.author || '').slice(0, 14).padEnd(16) + String(x.title || '').replace(/<[^>]+>/g, '').slice(0, 34));
    });

    // 2) 平台原唱查询
    let meta = null;
    try {
      meta = await mm.lookupOriginal(kw);
    } catch { /* ignore */ }
    console.log('   平台原唱: ' + (meta && meta.artist ? meta.artist + ' · ' + meta.durationSec + 's' : '❌ 查不到'));

    // 3) 本地打分后的候选
    let s = null;
    try {
      s = await b.searchSong(kw, { noCache: true });
    } catch (e) {
      console.log('   searchSong 失败: ' + e.message);
    }
    console.log('   打分后候选: ' + ((s && s.candidates) || []).length + ' 个' + (s && s.error ? '  error=' + s.error : ''));
    ((s && s.candidates) || []).slice(0, 3).forEach((x) => {
      console.log('      [' + String(Math.round(x.score)).padStart(4) + '] ' + String(x.duration || '?').padStart(4) + 's  ' + String(x.title || '').slice(0, 40));
    });

    // 4) 最终选中
    try {
      const r = await b.pickForSong(kw);
      console.log('   → ' + (r.ok ? '✅ ' + String(r.pick.title || '').slice(0, 46) + '  ' + r.pick.duration + 's' : '❌ ' + r.reason));
    } catch (e) {
      console.log('   → ❌ ' + e.message);
    }
    console.log('');
  }
  process.exit(0);
})();
