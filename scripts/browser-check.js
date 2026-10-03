'use strict';

/**
 * 用真实 Chromium 打开音乐播放页，验证：
 *   1) 页面能连上本地 WebSocket
 *   2) 收到 play 指令后 <audio> 真的开始加载音频（currentTime 前进）
 *   3) 控制台页面能正常渲染、没有 JS 报错
 *
 * 用法：node scripts/browser-check.js [baseUrl]
 */

const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';

/** 优先用系统已装的 Chrome/Edge（免去下载 Chromium 的 150MB） */
function detectBrowser() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return { executablePath: process.env.CHROME_PATH };
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { executablePath: p };
  }
  return {};
}

async function main() {
  let playwright;
  for (const name of ['playwright', 'playwright-core']) {
    try {
      // eslint-disable-next-line global-require
      playwright = require(name);
      break;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  if (!playwright) {
    console.error('需要 playwright 或 playwright-core：npm i playwright-core');
    process.exit(2);
  }

  const { chromium } = playwright;
  const browser = await chromium.launch({
    headless: true,
    ...detectBrowser(),
    // 和产品里专用播放器一致的参数：否则 Chrome 会拦自动播放，
    // 检测结果会误报「没出声」
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox',
      '--mute-audio',
      '--use-fake-ui-for-media-stream',
    ],
  });
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`);
  };

  // ---------- 控制台页面 ----------
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  record('控制台页面加载', errors.length === 0, errors.slice(0, 2).join(' | ') || '无 JS 报错');
  const title = await page.textContent('#badge-mode').catch(() => '');
  record('控制台渲染模式徽标', /模式/.test(title || ''), title || '');
  const apiOk = await page.evaluate(async () => {
    const res = await fetch('/api/state');
    return res.ok;
  });
  record('控制台能取到状态', apiOk === true);

  // ---------- 音乐播放页 ----------
  const audioPage = await browser.newPage();
  const audioErrors = [];
  audioPage.on('pageerror', (err) => audioErrors.push(err.message));
  await audioPage.goto(`${BASE}/audio`, { waitUntil: 'domcontentloaded' });
  await audioPage.waitForTimeout(1200);

  const wsConnected = await audioPage.evaluate(() => document.getElementById('conn').textContent);
  record('播放页连上本地服务', /已连接|播放|等待/.test(wsConnected), wsConnected);

  // 触发一次点歌（用 API，避免依赖弹幕源）
  await fetch(`${BASE}/api/song`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ song: '晴天', nickname: '浏览器自检' }),
  });

  // 等音频真正开始播放
  let playing = false;
  let info = '';
  for (let i = 0; i < 40; i += 1) {
    await audioPage.waitForTimeout(1000);
    const snapshot = await audioPage.evaluate(() => {
      const a = document.getElementById('audio');
      const iframe = document.querySelector('#embed-host iframe');
      return {
        src: a.currentSrc || a.src || '',
        time: a.currentTime,
        readyState: a.readyState,
        paused: a.paused,
        err: a.error ? a.error.code : null,
        embed: Boolean(iframe),
        title: document.getElementById('title').textContent,
      };
    });
    info = `${snapshot.title} | src=${snapshot.src.slice(0, 46)} | t=${snapshot.time.toFixed(1)}s | ready=${snapshot.readyState} | paused=${snapshot.paused}${snapshot.embed ? ' | 内嵌播放器' : ''}`;
    if (snapshot.time > 0.2 && snapshot.readyState >= 3) {
      playing = true;
      break;
    }
    if (snapshot.embed) {
      playing = true; // 回退到官方内嵌播放器也算通过
      break;
    }
    if (snapshot.err) break;
  }
  record('播放页开始出声', playing, info);
  record('播放页无 JS 报错', audioErrors.length === 0, audioErrors.slice(0, 2).join(' | ') || '无');

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('浏览器自检失败：', err.message);
  process.exit(1);
});
