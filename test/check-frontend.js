'use strict';
/**
 * 检查 public/ 下的页面是否还引用了已删除的元素/路由。
 *
 * 背景：移除了歌单悬浮层（/overlay 浏览器版）之后，
 * 要把所有指向它的按钮、元素引用、路由一并清掉 ——
 * 否则页面上会出现"点了没反应"的按钮，或者 JS 直接抛错。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

let problems = 0;

console.log('════════ 前端页面完整性检查 ════════');
console.log('');

for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith('.html'))) {
  const full = path.join(PUBLIC, f);
  const t = fs.readFileSync(full, 'utf8');

  const ids = new Set([...t.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...new Set([...t.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];

  const missing = refs.filter((r) => !ids.has(r));
  const hasOverlayRoute = /['"(]\/overlay/.test(t);

  console.log(f);
  console.log('  元素引用: ' + refs.length + ' 个' + (missing.length ? '  ❌ 缺失 ' + missing.join(', ') : '  ✅ 全部存在'));
  console.log('  仍引用 /overlay 路由: ' + (hasOverlayRoute ? '⚠️ 是（该路由已移除）' : '✅ 否'));

  // 内联脚本语法
  const blocks = [...t.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let jsOk = true;
  let jsMsg = '';
  for (const b of blocks) {
    try {
      new Function(b);
    } catch (e) {
      jsOk = false;
      jsMsg = e.message;
    }
  }
  console.log('  内联脚本: ' + (jsOk ? '✅ 语法正常' : '❌ ' + jsMsg));
  console.log('');

  problems += missing.length + (hasOverlayRoute ? 1 : 0) + (jsOk ? 0 : 1);
}

// 服务端路由检查
const server = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
const routeGone = !/'\/overlay'\s*\)?\s*rel\s*=\s*'\/overlay\.html'/.test(server) && !server.includes("rel = '/overlay.html'");
console.log('src/server.js');
console.log('  /overlay → overlay.html 路由: ' + (routeGone ? '✅ 已移除' : '❌ 还在'));
console.log('');

console.log('────────────────────────────────');
console.log(problems === 0 ? '  ✅ 全部正常，没有失效引用' : '  ⚠️ 有 ' + problems + ' 处问题');
process.exitCode = problems ? 1 : 0;
