'use strict';

/**
 * 生成快捷方式用的图标（纯代码绘制，不依赖任何素材）。
 *
 *   node scripts/make-icon.js [输出路径]
 *
 * 做法：用系统 Chrome 跑一个 64x64 的 canvas 画出音符，
 * 然后按 **经典 BMP 格式** 打包成 .ico（16/32/48/64）。
 *
 * 为什么不用 PNG 压缩的 ico：
 *   虽然 Vista 以后支持，但资源管理器/某些老接口对 PNG 条目偶发不认（显示成白纸）。
 *   BMP 格式是所有 Windows 版本都铁定认的，体积大一点无所谓。
 */

const fs = require('fs');
const path = require('path');

const OUTPUT = process.argv[2] || path.resolve(__dirname, '..', 'public', 'app.ico');
const SIZES = [64, 48, 32, 16];

function detectChrome() {
  const list = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return list.find((p) => p && fs.existsSync(p)) || '';
}

/** RGBA 像素 -> ICO 里的 BMP 条目（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码） */
function rgbaToBmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // header size
  header.writeInt32LE(size, 4); // width
  header.writeInt32LE(size * 2, 8); // height（XOR + AND 两张图，所以是两倍）
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // compression: BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // image size

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4; // BMP 自下而上
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND 掩码：32bpp 下基本没用，但格式要求存在，按 4 字节对齐
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const andMask = Buffer.alloc(maskRowBytes * size, 0);

  return Buffer.concat([header, xor, andMask]);
}

/** 把若干 { size, data } 打成 ICO */
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const PAGE = `<!DOCTYPE html>
<html><body style="margin:0"><canvas id="c" width="64" height="64"></canvas>
<script>
const c = document.getElementById('c');
const x = c.getContext('2d');

function roundRect(ctx, rx, ry, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(rx + r, ry);
  ctx.arcTo(rx + w, ry, rx + w, ry + h, r);
  ctx.arcTo(rx + w, ry + h, rx, ry + h, r);
  ctx.arcTo(rx, ry + h, rx, ry, r);
  ctx.arcTo(rx, ry, rx + w, ry, r);
  ctx.closePath();
}

// 圆角底：青蓝渐变（和程序主题色一致）
const g = x.createLinearGradient(0, 0, 64, 64);
g.addColorStop(0, '#00c2ff');
g.addColorStop(1, '#0068d8');
x.fillStyle = g;
roundRect(x, 1, 1, 62, 62, 14);
x.fill();

// 顶部高光
const sh = x.createLinearGradient(0, 0, 0, 34);
sh.addColorStop(0, 'rgba(255,255,255,0.32)');
sh.addColorStop(1, 'rgba(255,255,255,0)');
x.fillStyle = sh;
roundRect(x, 1, 1, 62, 32, 14);
x.fill();

// 白色八分音符
x.fillStyle = '#ffffff';
x.beginPath();
x.ellipse(24, 45, 9.5, 7.6, -0.32, 0, Math.PI * 2);
x.fill();
x.beginPath();
x.ellipse(45, 39, 9.5, 7.6, -0.32, 0, Math.PI * 2);
x.fill();
x.beginPath();
x.moveTo(31.5, 45);
x.lineTo(31.5, 17);
x.lineTo(52.5, 11);
x.lineTo(52.5, 39);
x.lineTo(47.5, 40.5);
x.lineTo(47.5, 18.5);
x.lineTo(36.5, 21.8);
x.lineTo(36.5, 45);
x.closePath();
x.fill();
x.fillRect(31.5, 15, 21, 5.2);

window.__ICON_READY__ = true;
</script></body></html>`;

(async () => {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath: detectChrome(),
    args: ['--no-sandbox', '--hide-scrollbars'],
  });
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  await page.setContent(PAGE);
  await page.waitForFunction('window.__ICON_READY__ === true');

  const images = [];
  for (const size of SIZES) {
    const pixels = await page.evaluate((s) => {
      const src = document.getElementById('c');
      const dst = document.createElement('canvas');
      dst.width = s;
      dst.height = s;
      const ctx = dst.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0, s, s);
      return Array.from(ctx.getImageData(0, 0, s, s).data);
    }, size);
    images.push({ size, data: rgbaToBmpEntry(size, Buffer.from(pixels)) });
  }
  await browser.close();

  const ico = buildIco(images);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, ico);
  console.log(`图标已生成：${OUTPUT}`);
  console.log(`  尺寸：${SIZES.join('/')} px（经典 BMP 格式，兼容性最好）`);
  console.log(`  大小：${ico.length} 字节`);
})().catch((err) => {
  console.error('生成图标失败：', err.message);
  process.exit(1);
});
