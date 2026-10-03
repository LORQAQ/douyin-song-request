'use strict';
/**
 * 检查所有 .bat / .cmd 文件里会导致 cmd 解析失败的东西。
 *
 * 踩过的坑（两次）：
 *   1. 批处理里出现中文 —— cmd 读文件用的是**本地代码页**（简中是 GBK），
 *      而文件存成 UTF-8 时，中文字节会被当成非法命令，直接 "xxx 不是内部或外部命令"。
 *      `chcp 65001` 也救不了：cmd 是先按本地代码页解析完文件再执行。
 *   2. echo / rem 行里出现 `>` `|` `&` —— 会被当成重定向或命令分隔符。
 *      `rem` 行相对安全，但 `echo` 行一定会出问题；
 *      而且 `>` 在 echo 里**转义也救不了**（`-^>` 解析成 `-` + 重定向到文件）。
 *
 * 这个脚本把这两类问题都扫出来，防止再犯。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = ['node_modules', '.git'];

const batFiles = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP.some((s) => full.includes(s))) continue;
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/\.(bat|cmd)$/i.test(e.name)) batFiles.push(full);
  }
}
walk(ROOT, 0);

let problems = 0;

console.log('════════ 批处理文件安全检查 ════════');
console.log('  扫描 ' + batFiles.length + ' 个 .bat / .cmd 文件');
console.log('');

for (const full of batFiles) {
  const rel = path.relative(ROOT, full).split(path.sep).join('/');
  const buf = fs.readFileSync(full);
  const text = buf.toString('utf8');
  const issues = [];

  // 1) 非 ASCII 字符（中文最容易出问题）
  const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
  if (nonAscii.length > 0) {
    // 找出所在行号
    const lines = text.split(/\r?\n/);
    const badLines = [];
    lines.forEach((l, i) => {
      if ([...l].some((c) => c.charCodeAt(0) > 127)) badLines.push(i + 1);
    });
    issues.push({
      kind: '非 ASCII 字符 ' + nonAscii.length + ' 个（中文字节会被 cmd 当非法命令）',
      lines: badLines.slice(0, 6),
    });
  }

  // 2) echo 行里的 > | &
  const lines = text.split(/\r?\n/);
  lines.forEach((l, i) => {
    const t = l.trim().toLowerCase();
    if (t.startsWith('echo') && /[>|&]/.test(l)) {
      issues.push({ kind: 'echo 行含 > | &（会被当重定向/分隔符）', lines: [i + 1], sample: l.trim().slice(0, 60) });
    }
  });

  // 3) BOM（cmd 会把它当命令的一部分）
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    issues.push({ kind: 'UTF-8 BOM（cmd 会把它算进第一条命令）', lines: [1] });
  }

  if (issues.length === 0) {
    console.log('  ✅ ' + rel);
  } else {
    problems += issues.length;
    console.log('  ❌ ' + rel);
    for (const it of issues) {
      console.log('       · ' + it.kind + '  行 ' + it.lines.join(','));
      if (it.sample) console.log('         ' + it.sample);
    }
  }
}

console.log('');
console.log('────────────────────────────────────');
console.log(problems === 0 ? '  ✅ 所有批处理都是安全的' : '  ⚠️ 发现 ' + problems + ' 处问题');
process.exitCode = problems ? 1 : 0;
