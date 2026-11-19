// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) + frame diff analyzer.
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('bit depth ' + bitDepth + ' unsupported');
  if (interlace !== 0) throw new Error('interlaced unsupported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : -1;
  if (channels < 0) throw new Error('color type ' + colorType + ' unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x];
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= channels && y > 0 ? out[prev + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('filter ' + filter);
      }
      out[row + x] = v & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort();
console.log('frames:', files.length, 'dir:', dir);

const frames = files.map((f) => decodePNG(dir + '\\' + f));
const { width: W, height: H, channels: C } = frames[0];
console.log('size:', W + 'x' + H, 'channels:', C);

const base = frames[0].data;
for (let i = 1; i < frames.length; i++) {
  const cur = frames[i].data;
  let changed = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * C;
    for (let x = 0; x < W; x++) {
      const p = row + x * C;
      const d = Math.abs(cur[p] - base[p]) + Math.abs(cur[p + 1] - base[p + 1]) + Math.abs(cur[p + 2] - base[p + 2]);
      if (d > 24) {
        changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  console.log(files[i], 'changed=' + changed, 'bbox=' + minX + ',' + minY + '-' + maxX + ',' + maxY);
}
