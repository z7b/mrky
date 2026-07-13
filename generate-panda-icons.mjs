import fs from 'fs';
import zlib from 'zlib';
import path from 'path';

// Pure JS CRC32 implementation for PNG chunks
const CRC_TABLE = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function writePNG(filename, width, height, pixels) {
  // pixels is Uint8Array of size width * height * 4 (RGBA)
  const rowSize = width * 4 + 1;
  const rawData = new Uint8Array(height * rowSize);
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0; // Filter type 0 (None)
    for (let x = 0; x < width * 4; x++) {
      rawData[y * rowSize + 1 + x] = pixels[y * width * 4 + x];
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  // PNG header
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // 8 bits per channel
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);

  const ihdrChunk = createChunk('IHDR', ihdrData);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  const pngBuffer = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, pngBuffer);
}

function createChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// Render Panda Face mathematically at any dimension
function renderPandaIcon(size) {
  const pixels = new Uint8Array(size * size * 4);

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    // Alpha blending
    const alpha = a / 255;
    const invAlpha = 1 - alpha;
    pixels[idx] = Math.round(r * alpha + pixels[idx] * invAlpha);
    pixels[idx + 1] = Math.round(g * alpha + pixels[idx + 1] * invAlpha);
    pixels[idx + 2] = Math.round(b * alpha + pixels[idx + 2] * invAlpha);
    pixels[idx + 3] = Math.round(a + pixels[idx + 3] * (1 - alpha));
  }

  function drawCircle(cx, cy, radius, r, g, b, a) {
    for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
      for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist <= radius - 0.5) {
          setPixel(x, y, r, g, b, a);
        } else if (dist <= radius + 0.5) {
          const antialias = (radius + 0.5 - dist) * a;
          setPixel(x, y, r, g, b, antialias);
        }
      }
    }
  }

  function drawOval(cx, cy, rx, ry, angleRad, r, g, b, a) {
    const cos = Math.cos(-angleRad);
    const sin = Math.sin(-angleRad);
    const maxR = Math.max(rx, ry);
    for (let y = Math.floor(cy - maxR - 1); y <= Math.ceil(cy + maxR + 1); y++) {
      for (let x = Math.floor(cx - maxR - 1); x <= Math.ceil(cx + maxR + 1); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const tx = dx * cos - dy * sin;
        const ty = dx * sin + dy * cos;
        const val = (tx * tx) / (rx * rx) + (ty * ty) / (ry * ry);
        if (val <= 0.95) {
          setPixel(x, y, r, g, b, a);
        } else if (val <= 1.05) {
          const aa = Math.max(0, Math.min(1, (1.05 - val) * 10)) * a;
          setPixel(x, y, r, g, b, aa);
        }
      }
    }
  }

  function drawRoundedRect(w, h, rad, r, g, b, a) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let dist = 0;
        if (x < rad && y < rad) {
          dist = Math.hypot(rad - x, rad - y);
        } else if (x > w - 1 - rad && y < rad) {
          dist = Math.hypot(x - (w - 1 - rad), rad - y);
        } else if (x < rad && y > h - 1 - rad) {
          dist = Math.hypot(rad - x, y - (h - 1 - rad));
        } else if (x > w - 1 - rad && y > h - 1 - rad) {
          dist = Math.hypot(x - (w - 1 - rad), y - (h - 1 - rad));
        }

        if (dist <= rad - 0.5) {
          setPixel(x, y, r, g, b, a);
        } else if (dist <= rad + 0.5) {
          const antialias = (rad + 0.5 - dist) * a;
          setPixel(x, y, r, g, b, antialias);
        }
      }
    }
  }

  // 1. Sleek Vibrant Red Rounded Square Background (Smooth App Icon Corners)
  drawRoundedRect(size, size, size * 0.24, 239, 44, 69, 255);

  // 2. Panda Left & Right Black Ears
  drawCircle(size * 0.26, size * 0.24, size * 0.17, 20, 20, 23, 255);
  drawCircle(size * 0.74, size * 0.24, size * 0.17, 20, 20, 23, 255);

  // 3. Panda Crisp White Face Head
  drawCircle(size * 0.5, size * 0.55, size * 0.38, 255, 255, 255, 255);

  // 4. Panda Left & Right Black Eye Patches (slanted ovals)
  drawOval(size * 0.36, size * 0.51, size * 0.10, size * 0.13, 0.25, 20, 20, 23, 255);
  drawOval(size * 0.64, size * 0.51, size * 0.10, size * 0.13, -0.25, 20, 20, 23, 255);

  // 5. Bright White Sparkle Pupils inside Eye Patches
  drawCircle(size * 0.37, size * 0.48, size * 0.04, 255, 255, 255, 255);
  drawCircle(size * 0.63, size * 0.48, size * 0.04, 255, 255, 255, 255);

  // 6. Cute Oval Black Nose
  drawOval(size * 0.5, size * 0.64, size * 0.055, size * 0.038, 0, 20, 20, 23, 255);

  return pixels;
}

const iconDir = path.join(process.cwd(), 'public', 'icons');
[16, 48, 128].forEach((s) => {
  const pixels = renderPandaIcon(s);
  writePNG(path.join(iconDir, `icon${s}.png`), s, s, pixels);
  console.log(`✅ Generated Panda Icon ${s}x${s} -> public/icons/icon${s}.png`);
});
