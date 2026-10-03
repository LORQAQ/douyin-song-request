'use strict';
/**
 * 合集索引自检 + 补漏。
 *
 * 用法:
 *   node scripts/fix-index.js            # 检查索引，补上缺失/失败的歌手
 *   node scripts/fix-index.js --check    # 只检查不修复
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX_FILE = path.join(ROOT, 'collections-index.json');
const CHECK_ONLY = process.argv.includes('--check');

/** 必须索引到的关键 UP 主（缺了就补） */
const MUST_HAVE = [
  { name: '蔚蓝边际', mid: 18026414, note: '用户指定最优先' },
];

async function main() {
  const { BilibiliClient } = require(path.join(ROOT, 'src', 'bilibili', 'bili-api'));
  const { Logger } = require(path.join(ROOT, 'src', 'lib', 'logger'));
  const cfg = require(path.join(ROOT, 'src', 'config')).loadConfig([]);
  const bili = new BilibiliClient({ ...cfg.bilibili, __root: ROOT }, new Logger('fix', 'warn'));

  if (!fs.existsSync(INDEX_FILE)) {
    console.log('❌ 索引文件不存在，先跑: node scripts/index-collections.js');
    process.exit(1);
  }
  const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const artists = idx.artists || {};

  let songs = 0;
  let ok = 0;
  const broken = [];
  for (const [name, info] of Object.entries(artists)) {
    const n = (info.videos || []).length;
    songs += n;
    if (n > 0) ok += 1;
    else broken.push(name);
  }

  console.log('════ 合集索引自检 ════');
  console.log('歌手数    : ' + Object.keys(artists).length + '（有效 ' + ok + '）');
  console.log('曲目总数  : ' + songs);
  console.log('文件大小  : ' + Math.round(fs.statSync(INDEX_FILE).size / 1024) + ' KB');
  console.log('索引时间  : ' + new Date(idx.at).toLocaleString('zh-CN'));
  if (broken.length) console.log('空索引的  : ' + broken.join(', '));
  console.log('');

  // 检查必须有的
  const missing = MUST_HAVE.filter((m) => !artists[m.name] || !(artists[m.name].videos || []).length);
  if (!missing.length) {
    console.log('✅ 关键 UP 主都在索引里');
    process.exit(0);
  }

  console.log('⚠️ 缺失关键 UP 主: ' + missing.map((m) => m.name).join(', '));
  if (CHECK_ONLY) process.exit(1);

  console.log('');
  console.log('尝试补索引…（B站风控 -352 是间歇的，隔几秒再试往往就通）');
  let fixed = 0;
  for (const m of missing) {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const v = await bili._collectionVideos(Number(m.mid)).catch((e) => {
        console.log('  第 ' + attempt + ' 次失败: ' + e.message.slice(0, 40));
        return [];
      });
      if (v.length) {
        artists[m.name] = {
          at: Date.now(),
          songs: v.length,
          mid: m.mid,
          collections: new Set(v.map((x) => x.bvid)).size,
          videos: v.map((x) => ({
            bvid: x.bvid,
            cid: x.cid,
            page: x.page,
            title: x.title,
            duration: x.duration,
            mid: m.mid,
            source: 'collection',
          })),
        };
        idx.artists = artists;
        fs.writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8');
        console.log('  ✅ ' + m.name + ' 补上了 ' + v.length + ' 首');
        fixed += 1;
        break;
      }
      console.log('  第 ' + attempt + ' 次拿到 0 首（风控中），等 8 秒…');
      await new Promise((r) => setTimeout(r, 8000));
    }
    if (!fixed) console.log('  ❌ ' + m.name + ' 补不上（可能一直风控，稍后再试）');
  }
  console.log('');
  console.log(fixed ? '已补 ' + fixed + ' 位，重启程序生效' : '没补上，稍后再跑一次这个脚本');
}

main().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
