'use strict';

// Tiny PNG writer — placeholder Hero icons (navy field, green disc, H).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([t, data]));
  return Buffer.concat([u32(data.length), t, data, u32(crc)]);
}

function setPixel(px, w, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= w || y >= w) return;
  const i = (y * w + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function fillRect(px, w, x0, y0, x1, y1, r, g, b, a) {
  const xa = Math.max(0, Math.floor(x0));
  const ya = Math.max(0, Math.floor(y0));
  const xb = Math.min(w - 1, Math.floor(x1));
  const yb = Math.min(w - 1, Math.floor(y1));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) setPixel(px, w, x, y, r, g, b, a);
  }
}

function fillCircle(px, w, cx, cy, radius, r, g, b, a) {
  const r2 = radius * radius;
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(w - 1, Math.ceil(cy + radius));
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) setPixel(px, w, x, y, r, g, b, a);
    }
  }
}

function drawIcon(size, padded) {
  const px = Buffer.alloc(size * size * 4, 0);
  const bg = padded ? [8, 15, 30, 255] : [8, 15, 30, 255];
  fillRect(px, size, 0, 0, size, size, bg[0], bg[1], bg[2], bg[3]);
  const inset = padded ? size * 0.18 : size * 0.08;
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size / 2) - inset;
  fillCircle(px, size, cx, cy, radius, 61, 220, 132, 255);
  // Letter H
  const stemW = size * (padded ? 0.08 : 0.10);
  const gap = size * (padded ? 0.16 : 0.18);
  const top = cy - radius * 0.45;
  const bot = cy + radius * 0.45;
  const left = cx - gap;
  const right = cx + gap;
  fillRect(px, size, left - stemW / 2, top, left + stemW / 2, bot, 8, 15, 30, 255);
  fillRect(px, size, right - stemW / 2, top, right + stemW / 2, bot, 8, 15, 30, 255);
  fillRect(px, size, left, cy - stemW / 2, right, cy + stemW / 2, 8, 15, 30, 255);
  return px;
}

function encodePng(size, px) {
  const ihdr = Buffer.concat([
    u32(size), u32(size),
    Buffer.from([8, 6, 0, 0, 0]) // 8-bit RGBA
  ]);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[(size * 4 + 1) * y] = 0;
    px.copy(raw, (size * 4 + 1) * y + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function write(name, size, padded) {
  const out = path.join(__dirname, '..', 'icons', name);
  fs.writeFileSync(out, encodePng(size, drawIcon(size, padded)));
  console.log('wrote', out);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
write('icon-192.png', 192, false);
write('icon-512.png', 512, false);
write('icon-512-maskable.png', 512, true);
write('apple-touch-icon.png', 180, false);
