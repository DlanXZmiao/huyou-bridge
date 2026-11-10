// image-size.js — 读图片宽高（不依赖任何库），发帖上传时要用。
//
// 支持 png / jpeg / gif / webp。

export function imageSize(buf) {
  if (!buf || buf.length < 12) throw new Error('图片太小');

  // PNG: \x89PNG，宽高在 IHDR（偏移 16/20）
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png', ext: 'png' };
  }

  // GIF: GIF87a / GIF89a
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif', ext: 'gif' };
  }

  // WebP: RIFF....WEBP（VP8/VP8L/VP8X 三种）
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, mime: 'image/webp', ext: 'webp' };
    }
    if (fmt === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        mime: 'image/webp', ext: 'webp'
      };
    }
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: 'image/webp', ext: 'webp' };
    }
    throw new Error('不认识的 WebP 变体');
  }

  // JPEG: 扫描 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0..SOF15，排除 C4(DHT)/C8(JPG)/CC(DAC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
          mime: 'image/jpeg',
          ext: 'jpg'
        };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    throw new Error('JPEG 里没找到 SOF 段');
  }

  throw new Error('不支持的图片格式（只支持 png/jpeg/gif/webp）');
}
