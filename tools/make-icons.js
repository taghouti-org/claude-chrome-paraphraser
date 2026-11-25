// Generates the extension icons (no dependencies): node tools/make-icons.js
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1): rounded square + four-point sparkle.
function inRoundedSquare(u, v) {
  const r = 0.23, dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0), dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function inSparkle(u, v, cx, cy, R) {
  const x = Math.abs(u - cx) / R, y = Math.abs(v - cy) / R;
  return Math.pow(x, 0.55) + Math.pow(y, 0.55) <= 1;
}
function render(size) {
  const SS = 6;
  return png(size, (px, py) => {
    let bg = 0, fg = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
      if (!inRoundedSquare(u, v)) continue;
      bg++;
      const white = inSparkle(u, v, 0.46, 0.54, 0.34) || inSparkle(u, v, 0.76, 0.25, 0.14);
      if (white) { fg++; rSum += 255; gSum += 255; bSum += 255; }
      else { const t = (u + v) / 2; rSum += 104 - 34 * t; gSum += 92 - 30 * t; bSum += 240 - 22 * t; }
    }
    if (!bg) return [0, 0, 0, 0];
    return [Math.round(rSum / bg), Math.round(gSum / bg), Math.round(bSum / bg), Math.round((255 * bg) / (SS * SS))];
  });
}
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(__dirname, '..', 'icons', `icon${size}.png`), render(size));
}
console.log('icons written');
