'use strict';
/**
 * 把蔚蓝边际的全部投稿写进固定答案表（pins.json）。
 *
 * 为什么用固定答案而不是合集索引：
 *   他的合集接口被B站单独 -352 风控（重试多次都不通），
 *   而固定答案是纯本地的、100% 可靠，不受风控影响。
 *
 * 用法: node scripts/pin-artist.js [mid] [name]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PIN_FILE = path.join(ROOT, 'pins.json');

const MID = Number(process.argv[2]) || 18026414; // 蔚蓝边际
const NAME = process.argv[3] || '蔚蓝边际';

/** 从标题里抽歌名：优先 《xxx》，否则取最后一段 */
function extractSong(title) {
  const t = String(title || '').trim();
  const bracket = t.match(/《(.+?)》/);
  if (bracket) return bracket[1].trim();
  // 「XXX单曲风格名」这类没有《》的，去掉赛事前缀
  const cleaned = t
    .replace(/^[A-Za-z0-9\s]+(vs|VS)[A-Za-z0-9\s]+/g, '')
    .replace(/^(单曲|新歌|小曲|应援曲|个人曲|赞歌|总结曲|主题曲)/, '')
    .trim();
  return cleaned || t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { BilibiliClient } = require(path.join(ROOT, 'src', 'bilibili', 'bili-api'));
  const { Logger } = require(path.join(ROOT, 'src', 'lib', 'logger'));
  const cfg = require(path.join(ROOT, 'src', 'config')).loadConfig([]);
  const bili = new BilibiliClient({ ...cfg.bilibili, __root: ROOT }, new Logger('pin', 'warn'));

  console.log('════ 抓取 ' + NAME + ' 的全部投稿 ════');

  // ① 列出他的所有合集
  let seasons = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const json = await bili._get(
      'https://api.bilibili.com/x/polymer/web-space/seasons_series_list',
      { mid: MID, page_num: 1, page_size: 20 }
    ).catch(() => null);
    if (json && json.code === 0) {
      const lists = (json.data && json.data.items_lists) || {};
      seasons = (lists.seasons_list || []).concat(lists.series_list || []);
      break;
    }
    console.log('  列合集第 ' + attempt + ' 次失败，等 6 秒…');
    await sleep(6000);
  }
  if (!seasons.length) {
    console.log('❌ 拿不到合集列表（风控）');
    process.exit(1);
  }
  console.log('  找到 ' + seasons.length + ' 个合集');

  // ② 逐个合集分页拉全（每个都重试）
  const videos = [];
  const seen = new Set();
  for (const s of seasons) {
    const meta = s.meta || {};
    const seasonId = meta.season_id || meta.series_id;
    const isSeries = Boolean(meta.series_id && !meta.season_id);
    const total = Number(meta.total) || 0;
    if (!seasonId || !total) continue;
    const pages = Math.ceil(total / 30);

    for (let p = 1; p <= pages; p += 1) {
      let arch = [];
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const json = await bili._get(
          isSeries
            ? 'https://api.bilibili.com/x/series/archives'
            : 'https://api.bilibili.com/x/polymer/web-space/seasons_archives_list',
          isSeries
            ? { mid: MID, series_id: seasonId, page_num: p, page_size: 30 }
            : { mid: MID, season_id: seasonId, sort_reverse: false, page_num: p, page_size: 30 }
        ).catch(() => null);
        if (json && json.code === 0) {
          arch = (json.data && json.data.archives) || [];
          break;
        }
        const code = json ? json.code : 'err';
        process.stdout.write('  [' + meta.name + ' P' + p + '] ' + code + ' 重试' + attempt + '…\r');
        await sleep(5000);
      }
      for (const a of arch) {
        if (a.bvid && !seen.has(a.bvid)) {
          seen.add(a.bvid);
          videos.push({ bvid: a.bvid, title: String(a.title || ''), duration: Number(a.duration) || 0 });
        }
      }
      await sleep(1200);
    }
    console.log('  ' + String(meta.name || seasonId).padEnd(22) + ' → 累计 ' + videos.length + ' 个视频');
  }

  if (!videos.length) {
    console.log('❌ 一个视频都没拿到（风控）');
    process.exit(1);
  }

  // ③ 转成固定答案
  const pins = {};
  const skipped = [];
  for (const v of videos) {
    const song = extractSong(v.title);
    // 歌名太短/太长/像杂项的跳过
    if (!song || song.length < 2 || song.length > 24) {
      skipped.push(v.title.slice(0, 30));
      continue;
    }
    if (/盘点|合集|观看|谢谢|预告|花絮|回放/.test(song)) {
      skipped.push(song);
      continue;
    }
    // 已有同名的保留先出现的（合集里顺序靠前的通常更正式）
    if (!pins[song]) pins[song] = v.bvid;
  }

  // ④ 合并进现有 pins.json（不覆盖已有的手写条目）
  const doc = fs.existsSync(PIN_FILE) ? JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')) : {};
  let added = 0;
  for (const [song, bvid] of Object.entries(pins)) {
    if (!doc[song]) {
      doc[song] = bvid;
      added += 1;
    }
  }
  doc._说明 = '点歌固定答案表。键=点歌文本（繁简自动归一），值=BV号 或 {bvid,page}。删掉某行就恢复自动搜索。';
  doc._为什么需要 = 'B站每次搜索返回的结果集都不一样。这些是' + NAME + '的投稿（他的合集接口被风控，所以直接固定）。';

  fs.writeFileSync(PIN_FILE, JSON.stringify(doc, null, 2), 'utf8');

  const total = Object.keys(doc).filter((k) => !k.startsWith('_')).length;
  console.log('');
  console.log('════ 完成 ════');
  console.log('抓到视频   : ' + videos.length);
  console.log('新增固定答案: ' + added);
  console.log('固定答案总计: ' + total);
  if (skipped.length) console.log('跳过的杂项 : ' + skipped.length + ' 个（' + skipped.slice(0, 5).join(' / ') + '）');
  console.log('');
  console.log('示例:');
  Object.entries(pins).slice(0, 10).forEach(([k, v]) => console.log('  ' + k.padEnd(16) + ' → ' + v));
}

main().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
