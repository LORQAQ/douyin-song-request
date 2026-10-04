'use strict';
/**
 * 实测：Chrome 到底认不认 --autoplay-policy=no-user-gesture-required
 *
 * 背景：新版 Chrome 把自动播放策略改成了"只认企业策略，
 * 忽略命令行参数"（大约 2023 年起）。如果真是这样，
 * 光靠启动参数解决不了，得改用注册表策略或其他办法。
 *
 * 做法：起一个本地测试页（不放音频文件，只检测 play() 是否被拦），
 * 用带参数的 Chrome 打开，页面把结果发回本地服务器。
 */
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { detectChromePath } = require('../src/lib/launcher');

const PORT = 8799;
const RESULT = path.join(os.tmpdir(), 'autoplay-test-result.txt');
try { fs.unlinkSync(RESULT); } catch {}

const PAGE = `<!doctype html><html><body>
<script>
(async () => {
  // 生成一段极短的静音 wav（不需要外部文件）
  const sr = 8000, len = sr * 0.2;
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); ws(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, len * 2, true);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const a = new Audio(url);
  let result;
  try { await a.play(); result = 'OK'; }
  catch (e) { result = 'BLOCKED:' + (e.name || e.message); }
  // 顺便报告策略里看到的值
  let policy = '';
  try {
    const m = navigator.userActivation;
    policy = 'activation=' + (m ? (m.hasBeenActive ? 'yes' : 'no') : 'n/a');
  } catch (e) {}
  fetch('/report?r=' + encodeURIComponent(result + ' | ' + policy));
  document.title = result;
})();
</script>
</body></html>`;

(async () => {
  const exe = detectChromePath();
  if (!exe) {
    console.log('❌ 没找到 Chrome');
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/report')) {
      const r = decodeURIComponent(req.url.split('r=')[1] || '');
      fs.writeFileSync(RESULT, r, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log('测试页已起：http://127.0.0.1:' + PORT);

  const profile = path.join(os.tmpdir(), 'autoplay-test-profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    `--app=http://127.0.0.1:${PORT}`,
  ];
  console.log('启动 Chrome：' + exe);
  console.log('参数包含 --autoplay-policy=no-user-gesture-required');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  // 等结果
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (fs.existsSync(RESULT)) break;
  }

  console.log('');
  if (fs.existsSync(RESULT)) {
    const r = fs.readFileSync(RESULT, 'utf8');
    console.log('结果: ' + r);
    console.log('');
    if (r.startsWith('OK')) {
      console.log('✅ Chrome 尊重 --autoplay-policy 参数 → 自动播放可行！');
    } else {
      console.log('❌ Chrome 忽略了该参数（新版限制）→ 需要改用企业策略');
    }
  } else {
    console.log('⚠️ 30 秒内没收到结果（Chrome 可能没起来或被拦）');
  }

  // 清理：杀掉测试用的 Chrome 实例
  try { spawn('taskkill', ['/F', '/IM', 'chrome.exe', '/FI', `WINDOWTITLE eq *${PORT}*`], { stdio: 'ignore' }); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
})();
