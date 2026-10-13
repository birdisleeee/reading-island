import { requireValue } from './validation.mjs';
export function coverType(bytes) {
  requireValue(bytes instanceof Uint8Array && bytes.length > 24 && bytes.length <= 8 * 1024 * 1024, 'invalid_cover_size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, type;
  if ([137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n) && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20); type = 'image/png';
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let at = 2;
    while (at + 4 < bytes.length) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); type = 'image/jpeg'; break;
      }
      at += length;
    }
  }
  requireValue(type && width > 0 && height > 0 && width <= 4096 && height <= 4096, 'invalid_cover_image', 415);
  return type;
}
