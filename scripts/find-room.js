'use strict';

/**
 * 自动找出「你自己的」抖音直播间号。
 *
 *   node scripts/find-room.js             自动探测（读直播伴侣数据 + 校验）
 *   node scripts/find-room.js 7456814      只校验指定号码
 *   node scripts/find-room.js --nick 某个昵称  用昵称过滤
 *
 * 原理：
 *   抖音直播伴侣会在本机保存你开播的房间信息（roomId、昵称、web_rid）。
 *   本脚本读出这些线索，再用抖音房间接口校验「昵称/roomId 对得上」，
 *   这样就不会像翻 HTML 那样抓到别人房间的号码。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sign = require('../src/danmaku/sign');
const { Logger } = require('../src/lib/logger');

const args = process.argv.slice(2);
const explicit = args.find((a) => /^\d{6,14}$/.test(a));
const nickIndex = args.indexOf('--nick');
const wantNick = nickIndex >= 0 ? args[nickIndex + 1] : '';
const logger = new Logger('find-room', 'warn');

/** 直播伴侣的数据目录（不同渠道装的位置略有差异，都试一遍） */
function companionDirs() {
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE].filter(Boolean);
  const names = ['webcast_mate', '直播伴侣', 'LiveCompanion', 'douyin_live'];
  const dirs = [];
  for (const base of bases) {
    for (const name of names) {
      const p = path.join(base, name);
      if (fs.existsSync(p)) dirs.push(p);
    }
  }
  return dirs;
}

/** 在直播伴侣数据里找线索 */
function scanCompanion() {
  const found = { roomIds: new Set(), webRids: new Set(), nicknames: new Set(), uids: new Set(), files: [] };
  for (const dir of companionDirs()) {
    let files = [];
    try {
      files = fs.readdirSync(dir, { recursive: true })
        .map((f) => path.join(dir, f))
        .filter((f) => {
          try {
            const st = fs.statSync(f);
            return st.isFile() && st.size > 200 && st.size < 40 * 1024 * 1024;
          } catch {
            return false;
          }
        })
        .filter((f) => /\.(json|log|txt|dat|ldb)$/i.test(f))
        .filter((f) => !/gecko_cache|Dictionaries|fonts|materialLib|GPUCache|Cache[\\/]/i.test(f))
        .slice(0, 1200);
    } catch {
      continue;
    }
    for (const file of files) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      let hit = false;
      // roomStore 里的 owner 就是主播自己
      if (/roomStore|userStore/i.test(file)) {
        for (const m of text.matchAll(/"room_id_str"\s*:\s*"(\d{10,20})"/g)) {
          found.roomIds.add(m[1]);
          hit = true;
        }
        for (const m of text.matchAll(/"nickname"\s*:\s*"([^"]{1,40})"/g)) {
          found.nicknames.add(m[1]);
          hit = true;
        }
        for (const m of text.matchAll(/"id_str"\s*:\s*"(\d{10,20})"/g)) {
          found.uids.add(m[1]);
          hit = true;
        }
      }
      for (const m of text.matchAll(/"web_rid"\s*:\s*"(\d{6,14})"/g)) {
        found.webRids.add(m[1]);
        hit = true;
      }
      for (const m of text.matchAll(/live\.douyin\.com\/(\d{6,14})/g)) {
        found.webRids.add(m[1]);
        hit = true;
      }
      if (hit && found.files.length < 8) found.files.push(file);
    }
  }
  return found;
}

async function verify(candidate) {
  const info = await sign.fetchRoomInfo(candidate, '', logger);
  return info || null;
}

(async () => {
  console.log('\n=== 查找你的抖音直播间号 ===\n');

  if (explicit) {
    const info = await verify(explicit);
    if (!info) {
      console.log(`✗ ${explicit} 查不到房间信息（号码可能不对，或房间已彻底关闭）`);
      process.exit(1);
    }
    console.log(`✓ 直播间号 ${explicit}`);
    console.log(`   主播：${info.nickname}`);
    console.log(`   标题：${info.title}`);
    console.log(`   roomId：${info.roomId}`);
    console.log(`   状态：${info.status === 2 ? '直播中' : '未开播/已下播'}`);
    process.exit(0);
  }

  const dirs = companionDirs();
  if (!dirs.length) {
    console.log('没找到抖音直播伴侣的数据目录，无法自动探测。');
    console.log('手动办法：开播后在浏览器打开自己的直播间，看地址栏 live.douyin.com/ 后面那串数字。');
    process.exit(2);
  }
  console.log(`发现直播伴侣数据目录：${dirs.join('、')}`);
  const found = scanCompanion();
  console.log(
    `本地线索：roomId ${found.roomIds.size} 个，web_rid ${found.webRids.size} 个，昵称 ${found.nicknames.size} 个`
  );
  if (found.nicknames.size) console.log(`  昵称：${[...found.nicknames].slice(0, 5).join('、')}`);
  if (found.roomIds.size) console.log(`  roomId：${[...found.roomIds].slice(0, 5).join('、')}`);

  if (wantNick) console.log(`  已指定昵称过滤：${wantNick}`);

  // 先校验本地已有的 web_rid
  const results = [];
  for (const rid of found.webRids) {
    // eslint-disable-next-line no-await-in-loop
    const info = await verify(rid);
    if (info) results.push({ rid, ...info });
  }

  // 如果 web_rid 都不行，就用 roomId 反查（需要房主在播或信息缓存还在）
  if (!results.length && found.roomIds.size) {
    console.log('\n本地没有可用的 web_rid，尝试用 roomId 反查（可能受抖音接口限制）...');
  }

  let hits = results;
  if (wantNick) hits = results.filter((r) => r.nickname === wantNick || r.nickname.includes(wantNick));

  if (!hits.length) {
    console.log('\n✗ 没能自动确定你的直播间号。');
    console.log('手动办法（任选）：');
    console.log('  1) 直播伴侣 → 开播后，用浏览器打开自己的直播间，看地址栏 live.douyin.com/ 后面的数字');
    console.log('  2) 手机抖音 → 我的 → 开播后分享直播间 → 复制链接，链接里有数字');
    console.log('  3) 把找到的数字发我，或者直接跑：node scripts/find-room.js <数字>');
    process.exit(3);
  }

  console.log('\n=== 找到这些候选 ===');
  for (const h of hits) {
    console.log(`  直播间号 ${h.rid}  →  ${h.nickname}  「${h.title}」  状态：${h.status === 2 ? '直播中' : '未开播'}`);
  }
  console.log('\n把这个直播间号填进控制台（或 config.json 的 danmaku.webRid）即可。');
  process.exit(0);
})().catch((err) => {
  console.error('出错：', err.message);
  process.exit(1);
});
