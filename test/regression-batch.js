'use strict';
/**
 * 回归测试：所有 .bat / .cmd 必须是"cmd 能吃"的。
 *
 * 【为什么值得测】这个坑踩了三次：
 *   cmd 解析批处理文件用的是**本地代码页**（简中 Windows 是 GBK），
 *   而我们的文件都存成 UTF-8。所以只要批处理里出现一个中文，
 *   那几行就会被当成非法命令 —— 表现是"双击打不开 / 闪一下就没了"，
 *   而且报错信息是乱码，非常难查。
 *   `chcp 65001` 救不了（cmd 是先按本地代码页解析完文件再执行）。
 *
 *   另外 echo 行里出现 > | & 会被当成重定向/命令分隔符，
 *   且 > 在 echo 里**转义也救不了**（`-^>` 会生成一个名为 not 的垃圾文件）。
 */
const fs = require('fs');
const path = require('path');

module.exports = function registerBatchSafetyTests({ test, assert }) {
  const ROOT = path.resolve(__dirname, '..');
  const SKIP = ['node_modules', `${path.sep}.git`];

  const batFiles = [];
  (function walk(dir, depth) {
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
  })(ROOT, 0);

  test('批处理文件里没有中文（cmd 按本地编码解析会崩）', () => {
    assert.ok(batFiles.length > 0, '一个 .bat 都没扫到？');
    const bad = [];
    for (const full of batFiles) {
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split(/\r?\n/);
      const hits = [];
      lines.forEach((l, i) => {
        if ([...l].some((c) => c.charCodeAt(0) > 127)) hits.push(i + 1);
      });
      if (hits.length) bad.push(path.relative(ROOT, full) + ' 行 ' + hits.join(','));
    }
    assert.deepStrictEqual(bad, [], '这些批处理含非 ASCII 字符，双击会打不开：\n        ' + bad.join('\n        '));
    console.log(`      → ${batFiles.length} 个批处理全部纯 ASCII`);
  });

  test('批处理的 echo 行里没有 > | &', () => {
    const bad = [];
    for (const full of batFiles) {
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        const t = l.trim().toLowerCase();
        if (t.startsWith('echo') && /[>|&]/.test(l)) {
          bad.push(path.relative(ROOT, full) + ':' + (i + 1) + '  ' + l.trim().slice(0, 50));
        }
      });
    }
    assert.deepStrictEqual(bad, [], 'echo 行里的这些符号会被当成重定向/分隔符：\n        ' + bad.join('\n        '));
    console.log('      → echo 行干净');
  });

  test('批处理没有 UTF-8 BOM', () => {
    const bad = [];
    for (const full of batFiles) {
      const buf = fs.readFileSync(full);
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bad.push(path.relative(ROOT, full));
    }
    assert.deepStrictEqual(bad, [], '这些批处理带 BOM，cmd 会把 BOM 算进第一条命令：\n        ' + bad.join('\n        '));
    console.log('      → 无 BOM');
  });
};
