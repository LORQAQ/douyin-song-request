'use strict';
/**
 * 配置官方唱片公司 / 歌手本人号 白名单。
 *
 * 数据来源：实测（2026-10-03）B站 `search/all/v2` 的 bili_user 段 +
 * 逐个核对认证状态与粉丝数。这些号发的基本都是官方授权版本。
 *
 * 用法: node scripts/setup-official-uploaders.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');

/** 官方唱片公司 / 厂牌 / 歌手本人号（实测 mid） */
const OFFICIAL = [
  { mid: 486906719, name: '索尼音乐中国', note: '95.0万粉 / 25.9万投稿' },
  { mid: 669334488, name: '环球音乐中国', note: '43.8万粉 / 20合集' },
  { mid: 37791459, name: '太合音乐', note: '8111 投稿 / 12合集' },
  { mid: 2046693818, name: '华纳音乐中国', note: '1730 投稿' },
  { mid: 1736485735, name: '相信音乐', note: '五月天/告五人厂牌' },
  { mid: 1503606217, name: '滚石唱片', note: '经典MV 4K修复' },
  { mid: 58722507, name: '摩登天空', note: '独立音乐厂牌' },
  { mid: 1745584728, name: '杰威尔音乐', note: '周杰伦厂牌 / 112万粉' },
  { mid: 522608013, name: '咪咕音乐官方', note: '' },
  { mid: 3670216, name: 'TF家族', note: '959万粉' },
  // 歌手本人号（有认证的）
  { mid: 1142317983, name: '薛之谦', note: '112.6万粉 / 机构认证' },
  { mid: 1889545341, name: 'GEM鄧紫棋', note: '233.8万粉' },
  { mid: 3404595, name: '卡布叻_周深', note: '331.7万粉' },
  { mid: 3494362025560552, name: '林俊杰_重拾快乐', note: '56.7万粉' },
  { mid: 3546929849961165, name: '陳奕迅所長', note: '86.5万粉' },
  { mid: 352091301, name: '陶喆的音乐产房', note: '106.7万粉' },
  { mid: 1875245620, name: '汪苏泷', note: '172.4万粉' },
  { mid: 20713882, name: '单依纯', note: '130.2万粉' },
  { mid: 647208864, name: '许嵩', note: '128.8万粉' },
  { mid: 1646036311, name: '凤凰传奇', note: '284.3万粉' },
  { mid: 1862400654, name: '周传雄', note: '112.0万粉' },
  { mid: 501005668, name: '黄霄雲', note: '98.2万粉' },
  { mid: 1842080828, name: '张杰', note: '92.5万粉' },
];

/** 已知的整活/改编 UP 主（用户明确要优先的）
 *
 * ⚠️ 重要性：**priority 越小越优先**。
 * 实测教训：蔚蓝边际的《大家一起创羊羊》和官方唱片公司的一些歌同名时，
 * 如果官方公司的合排列在前面，会盖掉本人投稿（而本人投稿才是我们要的）。
 * 所以用户指定的人排最前（priority 1），唱片公司排后面（priority 3~4）。
 */
const USER_PICKED = [
  { mid: 18026414, name: '蔚蓝边际', note: 'LPL 改编曲（用户指定优先）', priority: 1 },
];

/** 歌手本人号 / 大厂牌（优先于普通唱片公司） */
const ARTIST_ACCOUNTS = [
  { mid: 1142317983, name: '薛之谦', priority: 2 },
  { mid: 1889545341, name: 'GEM鄧紫棋', priority: 2 },
  { mid: 3404595, name: '卡布叻_周深', priority: 2 },
  { mid: 3494362025560552, name: '林俊杰_重拾快乐', priority: 2 },
  { mid: 3546929849961165, name: '陳奕迅所長', priority: 2 },
  { mid: 352091301, name: '陶喆的音乐产房', priority: 2 },
  { mid: 1875245620, name: '汪苏泷', priority: 2 },
  { mid: 20713882, name: '单依纯', priority: 2 },
  { mid: 647208864, name: '许嵩', priority: 2 },
  { mid: 1646036311, name: '凤凰传奇', priority: 2 },
  { mid: 1862400654, name: '周传雄', priority: 2 },
  { mid: 501005668, name: '黄霄雲', priority: 2 },
  { mid: 1842080828, name: '张杰', priority: 2 },
];

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.bilibili = cfg.bilibili || {};

  // 可信 UP 主（按 owner 名字匹配）：只放官方唱片公司 + 认证歌手，
  // 它们发的确实是授权版本，不会误伤。
  const labels = OFFICIAL.filter((x) => !ARTIST_ACCOUNTS.some((a) => a.mid === x.mid));
  cfg.bilibili.trustedUploaders = [...new Set([...labels, ...ARTIST_ACCOUNTS].map((x) => x.name))];

  // 白名单合集（mid + name + priority），按优先级排序（小的在前）
  const all = [...USER_PICKED, ...ARTIST_ACCOUNTS, ...labels];
  all.sort((a, b) => (a.priority || 9) - (b.priority || 9));
  cfg.bilibili.trustedCollections = all.map((x) => ({
    mid: x.mid,
    name: x.name,
    priority: x.priority || 9,
  }));

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');

  console.log('已写入 config.json');
  console.log('');
  console.log('白名单合集（' + cfg.bilibili.trustedCollections.length + ' 个，按优先级）:');
  cfg.bilibili.trustedCollections.forEach((x) => {
    const star = x.priority === 1 ? '⭐⭐⭐' : x.priority === 2 ? '⭐⭐' : '⭐';
    console.log('  ' + star + ' p' + x.priority + '  ' + String(x.name).padEnd(16) + ' mid=' + x.mid);
  });
  console.log('');
  console.log('可信 UP 主（' + cfg.bilibili.trustedUploaders.length + ' 个）');
}

main();
