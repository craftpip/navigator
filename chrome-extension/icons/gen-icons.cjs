const zlib = require('zlib');
const fs = require('fs');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function writePng(path, size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(path, png);
}

// Navigator icon: blue rounded square with a white compass-style ring + needle
function draw(size) {
  writePng(__dirname + '/icon' + size + '.png', size, (x, y) => {
    const cx = size / 2, cy = size / 2;
    const r = size / 2;
    // Rounded-corner background: blue gradient
    const corner = size * 0.18;
    const dxb = Math.max(0, Math.abs(x - cx) - (r - corner));
    const dyb = Math.max(0, Math.abs(y - cy) - (r - corner));
    const inBg = Math.sqrt(dxb * dxb + dyb * dyb) <= corner;
    const inSquare = x >= 0 && y >= 0 && x < size && y < size;
    if (!inSquare || !inBg) return [0, 0, 0, 0];

    const t = y / size;
    const br = Math.round(64 + t * 40);
    const bg = Math.round(120 + t * 60);
    const bb = Math.round(225 + t * 20);

    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ringOuter = r * 0.44;
    const ringInner = r * 0.30;

    // Compass ring (white)
    if (dist >= ringInner && dist <= ringOuter) return [255, 255, 255, 255];

    // Cross needle (north-south, red on top, white bottom)
    const needleW = size * 0.07;
    const needleLen = r * 0.26;
    const inNeedle = Math.abs(dx) <= needleW / 2 && Math.abs(dy) <= needleLen;
    if (inNeedle) {
      return dy < 0 ? [244, 67, 54, 255] : [255, 255, 255, 255];
    }
    return [br, bg, bb, 255];
  });
}

[16, 48, 128].forEach(draw);
console.log('icons written');