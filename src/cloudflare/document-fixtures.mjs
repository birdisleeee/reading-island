// Fictional ZIP fixtures for DOCX/EPUB parser tests; no user files.
import { deflateRawSync } from 'node:zlib';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipFixture(files) {
  const locals = [], directory = []; let offset = 0;
  for (const [filename, text] of Object.entries(files)) {
    const name = Buffer.from(filename), plain = Buffer.from(text), compressed = deflateRawSync(plain), crc = crc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(plain.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(plain.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); directory.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, central, end]));
}
export const docxFixture = () => zipFixture({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章 海边</w:t></w:r></w:p><w:p><w:r><w:t>风吹过来。</w:t></w:r></w:p></w:body></w:document>', 'word/media/ignored.png': 'not needed for text parsing' });
export const epubFixture = () => zipFixture({
  'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
  'OEBPS/content.opf': '<package><manifest><item id="second" href="b.xhtml"/><item id="first" href="a.xhtml"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>',
  'OEBPS/a.xhtml': '<html><head><title>第一章</title></head><body><h1>第一章</h1><p>先看海。</p></body></html>',
  'OEBPS/b.xhtml': '<html><head><title>第二章</title></head><body><h1>第二章</h1><p>再回家。</p></body></html>',
});
