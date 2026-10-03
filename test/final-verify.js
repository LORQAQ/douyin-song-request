'use strict';
/**
 * 最终验证：服务能起来，各页面正常，被移除的路由返回 404 而不是 500。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const LOG = path.join(process.env.TEMP, 'final-verify.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const PORT = 18798;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        req.destroy();
        resolve({ code: res.statusCode, body });
      });
    });
    req.on('error', (e) => resolve({ code: 0, err: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ code: -1 });
    });
  });
}

(async () => {
  // 服务得由外部起好；这里只做请求验证
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    const r = await get('/api/health');
    if (r.code === 200) {
      up = true;
      break;
    }
    await sleep(300);
  }

  log('════════ 最终验证 ════════');
  log('');
  if (!up) {
    log('  ❌ 服务没起来（端口 ' + PORT + '）');
    process.exitCode = 1;
    return;
  }
  log('  ✅ 服务已就绪');

  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) {
      pass += 1;
      log('  ✅ ' + name + (detail ? '  ' + detail : ''));
    } else {
      fail += 1;
      log('  ❌ ' + name + (detail ? '  ' + detail : ''));
    }
  };

  // 正常页面
  const pages = [
    ['/', 'index.html', '控制台'],
    ['/audio', 'audio.html', '播放页'],
    ['/launcher', 'launcher.html', '启动向导'],
  ];
  for (const [p, marker, name] of pages) {
    const r = await get(p);
    check(name + '页面 ' + p, r.code === 200 && r.body.includes('<'), 'HTTP ' + r.code + '  ' + r.body.length + ' 字符');
  }

  // 已移除的路由：404 才是对的，500 说明有 bug
  const r1 = await get('/overlay');
  check('已移除的 /overlay 返回 404', r1.code === 404, 'HTTP ' + r1.code);

  // 接口
  for (const p of ['/api/health', '/api/state', '/api/status', '/api/diagnostics']) {
    const r = await get(p);
    check(p, r.code === 200, 'HTTP ' + r.code);
  }

  // 畸形 URL 不能打挂
  for (const p of ['/%', '/%E4%BD']) {
    await get(p);
  }
  const h = await get('/api/health');
  check('畸形 URL 后服务存活', h.code === 200);

  // 前端页面不能引用已删的东西
  const launcher = (await get('/launcher')).body;
  check('启动向导不再引用 /overlay', !/["'(]\/overlay/.test(launcher));

  const indexHtml = (await get('/')).body;
  check('控制台不再有悬浮层入口', !indexHtml.includes('/overlay"'));

  log('');
  log('────────────────────────────');
  log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  log('────────────────────────────');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
