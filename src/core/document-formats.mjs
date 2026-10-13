export const FORMAT_ACCEPT = '.txt,.md,.markdown,.html,.htm,.docx,.doc,.pdf,.epub,.mobi,.azw,.azw3';
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const readableFormats = new Set(['txt', 'md', 'html', 'docx', 'epub']);

export function detectFormat(filename = '') {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'markdown') return 'md';
  if (ext === 'htm') return 'html';
  return ['txt', 'md', 'html', 'docx', 'doc', 'pdf', 'epub', 'mobi', 'azw', 'azw3'].includes(ext) ? ext : '';
}

export function formatLabel(format) {
  return ({ txt: 'TXT', md: 'Markdown', html: 'HTML', docx: 'Word DOCX', doc: 'Word DOC', pdf: 'PDF', epub: 'EPUB', mobi: 'MOBI', azw: 'Kindle AZW', azw3: 'Kindle AZW3' })[format] || '未知格式';
}

export function supportsPreciseReading(format) { return readableFormats.has(format); }

export function detectChapterRanges(text) {
  if (!text) return [];
  const markers = [];
  const heading = /^(?:#{1,6}\s+.+|第[〇零一二三四五六七八九十百千万两\d]+[章节卷部篇回](?:\s+.*)?|(?:序章|楔子|前言|引言|后记|尾声)(?:\s+.*)?|(?:chapter|part|book)\s+[\divxlcdm]+(?:\s*[:：.-]?\s*.*)?)$/i;
  const lines = text.matchAll(/^.*$/gm);
  for (const match of lines) {
    const title = match[0].trim().replace(/^#{1,6}\s+/, '');
    if (title && title.length <= 100 && heading.test(match[0].trim())) markers.push({ title, start: match.index });
  }
  if (!markers.length) return [{ title: '全文', start: 0, end: text.length, source: 'fallback' }];
  if (markers[0].start > 0) markers.unshift({ title: '开篇', start: 0 });
  return markers.map((marker, index) => ({ ...marker, end: markers[index + 1]?.start ?? text.length, source: 'auto' }));
}

export function normalizeChapterRanges(text, rows) {
  const cleaned = rows.map((row) => ({ title: String(row.title || '').trim(), start: Number(row.start) })).filter((row) => row.title);
  cleaned.sort((a, b) => a.start - b.start);
  if (!cleaned.length || cleaned[0].start !== 0) throw new Error('第一章必须从位置 0 开始。');
  for (let index = 0; index < cleaned.length; index++) {
    if (!Number.isSafeInteger(cleaned[index].start) || cleaned[index].start < 0 || cleaned[index].start >= text.length) throw new Error('章节起始位置超出原文范围。');
    if (index && cleaned[index].start === cleaned[index - 1].start) throw new Error('两个章节不能从同一个位置开始。');
  }
  return cleaned.map((row, index) => ({ ...row, end: cleaned[index + 1]?.start ?? text.length, source: 'manual' }));
}

export async function parseDocumentBytes(bytes, format, markupParser) {
  if (format === 'txt' || format === 'md') return canonicalText(decodeUtf8(bytes), `${format}-utf8-lf-v1`);
  if (format === 'html') return canonicalText(htmlToText(decodeUtf8(bytes), markupParser), 'html-dom-text-v1');
  if (format === 'docx') return canonicalText(await docxToText(bytes, markupParser), 'docx-wordml-v1');
  if (format === 'epub') {
    const epub = await epubToText(bytes, markupParser);
    return { ...canonicalText(epub.text, 'epub-spine-text-v1'), chapterHints: epub.chapterHints };
  }
  return { text: '', parserVersion: `original-only-${format}-v1`, readingStatus: 'original-only' };
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('文本编码不是 UTF-8，请转换编码后再导入。原文件不会被修改。'); }
}

function canonicalText(text, parserVersion) {
  text = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('没有提取到可阅读的正文。原文件不会被修改。');
  return { text, parserVersion, readingStatus: 'ready' };
}

function parseMarkup(markup, mime, markupParser = globalThis.DOMParser) {
  if (!markupParser) throw new Error('当前环境不支持文档解析。');
  if (markup.length > 5 * 1024 * 1024) throw new Error('单个文档片段过大，已停止解析。');
  const doc = new markupParser().parseFromString(markup, mime);
  if (doc.querySelector('parsererror')) throw new Error('文档结构无法解析。');
  return doc;
}

function htmlToText(markup, markupParser, headings = null) {
  const doc = parseMarkup(markup, 'text/html', markupParser);
  doc.querySelectorAll('script,style,noscript,svg').forEach((node) => node.remove());
  const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'TR', 'BR']);
  let text = '';
  const walk = (node) => {
    if (node.nodeType === 3) { text += node.nodeValue; return; }
    const block = blocks.has(node.nodeName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    if (headings && /^H[1-6]$/.test(node.nodeName)) headings.push({id:node.id || node.querySelector('[id]')?.id || '',title:node.textContent.trim().replace(/\s+/g,' ').slice(0,100),start:text.length});
    node.childNodes.forEach(walk);
    if (block && !text.endsWith('\n')) text += '\n';
  };
  walk(doc.body);
  const normalize = value => value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  if (headings) for (const heading of headings) heading.start = normalize(text.slice(0,heading.start)).length;
  return normalize(text);
}

async function unzip(bytes, include = () => true) {
  const data = new Uint8Array(bytes);
  const view = new DataView(bytes);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('压缩文档结构不完整。');
  const count = view.getUint16(eocd + 10, true);
  if (count > 5000) throw new Error('文档内部文件过多，已停止解析。');
  let cursor = view.getUint32(eocd + 16, true);
  const files = new Map();
  let totalPlainSize = 0;
  let selectedSize = 0;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('压缩文档目录损坏。');
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const plainSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(data.slice(cursor + 46, cursor + 46 + nameLength)).replaceAll('\\', '/');
    totalPlainSize += plainSize;
    if (name.includes('../') || name.startsWith('/') || plainSize > 50 * 1024 * 1024 || totalPlainSize > 75 * 1024 * 1024) throw new Error('文档包含不安全路径或过大的内部文件。');
    if (!include(name)) { cursor += 46 + nameLength + extraLength + commentLength; continue; }
    selectedSize += plainSize;
    if (plainSize > 5 * 1024 * 1024 || selectedSize > 16 * 1024 * 1024) throw new Error('正文片段过大，已停止解析。');
    if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('压缩文档条目损坏。');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > data.length) throw new Error('压缩文档数据不完整。');
    const compressed = data.slice(start, start + compressedSize);
    let plain;
    if (method === 0) plain = compressed;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      plain = new Uint8Array(plainSize); let written = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        if (written + value.byteLength > plainSize) { await reader.cancel(); throw new Error('文档解压超出声明大小。'); }
        plain.set(value, written); written += value.byteLength;
      }
      if (written !== plainSize) throw new Error('文档解压校验失败。');
    }
    else throw new Error('当前浏览器无法解压这种电子书。');
    if (plain.length !== plainSize) throw new Error('文档解压校验失败。');
    files.set(name, plain);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function docxToText(bytes, markupParser) {
  const files = await unzip(bytes, name => name === 'word/document.xml');
  const body = files.get('word/document.xml');
  if (!body) throw new Error('DOCX 中没有找到正文。');
  const doc = parseMarkup(decodeUtf8(body), 'application/xml', markupParser);
  const byLocalName = (root, name) => Array.from(root.querySelectorAll('*')).filter(node => node.localName.split(':').at(-1) === name);
  const paragraphs = byLocalName(doc, 'p').map(paragraph => byLocalName(paragraph, 't').map(node => node.textContent).join(''));
  return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n');
}

function resolveZipPath(base, href) {
  const parts = `${base}/${href.split('#')[0]}`.split('/');
  const resolved = [];
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') resolved.pop(); else resolved.push(decodeURIComponent(part)); }
  return resolved.join('/');
}

async function epubToText(bytes, markupParser) {
  const files = await unzip(bytes, name => /\.(xml|opf|html?|xhtml)$/i.test(name));
  const container = files.get('META-INF/container.xml');
  if (!container) throw new Error('EPUB 中没有找到目录文件。');
  const containerDoc = parseMarkup(decodeUtf8(container), 'application/xml', markupParser);
  const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath || !files.has(opfPath)) throw new Error('EPUB 阅读顺序无法确定。');
  const opf = parseMarkup(decodeUtf8(files.get(opfPath)), 'application/xml', markupParser);
  const manifest = new Map(Array.from(opf.querySelectorAll('manifest item')).map((item) => [item.getAttribute('id'), item.getAttribute('href')]));
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
  const navItem = [...opf.querySelectorAll('manifest item')].find(item => (item.getAttribute('properties') || '').split(/\s+/).includes('nav'));
  const navPath = navItem && resolveZipPath(base, navItem.getAttribute('href'));
  const tocTargets = new Set();
  if (navPath && files.has(navPath)) {
    const navDoc = parseMarkup(decodeUtf8(files.get(navPath)), 'text/html', markupParser);
    const toc = [...navDoc.querySelectorAll('nav')].find(node => (node.getAttribute('epub:type') || '').split(/\s+/).includes('toc'));
    for (const link of toc?.querySelectorAll('a[href]') || []) {
      const href = link.getAttribute('href');
      tocTargets.add(resolveZipPath(navPath.slice(0, navPath.lastIndexOf('/')), href) + '#' + (href.split('#')[1] || ''));
    }
  }
  const chapters = [];
  for (const itemref of opf.querySelectorAll('spine itemref')) {
    const href = manifest.get(itemref.getAttribute('idref'));
    const chapter = href && files.get(resolveZipPath(base, href));
    if (chapter) {
      const markup = decodeUtf8(chapter);
      const chapterDoc = parseMarkup(markup, 'text/html', markupParser);
      const title = chapterDoc.querySelector('h1,h2,h3,h4,h5,h6,title')?.textContent?.trim();
      const headings = [];
      const raw = htmlToText(markup, markupParser, headings);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const markers = headings.filter(item => !tocTargets.size || tocTargets.has(resolveZipPath(base, href) + '#' + item.id)).map(item=>({...item,start:Math.max(0,item.start-leading)})).filter(item=>item.title && item.start<text.length);
      if (text) chapters.push({ title: title || `第 ${chapters.length + 1} 章`, text, markers });
    }
  }
  if (!chapters.length) throw new Error('EPUB 中没有找到可阅读章节，可能受 DRM 保护。');
  const chapterHints = [];
  let text = '';
  chapters.forEach((chapter, index) => {
    if (index) text += '\n\n';
    if (!chapter.markers.length || chapter.markers[0].start > 0) chapterHints.push({ title: chapter.title.slice(0, 100), start: text.length, source: 'epub-spine' });
    for (const marker of chapter.markers) {
      const start = text.length + marker.start;
      if (chapterHints.at(-1)?.start !== start) chapterHints.push({...marker,start,source:'epub-heading'});
    }
    text += chapter.text;
  });
  return { text, chapterHints: organizeEpubChapters(chapterHints.map((chapter, index) => ({ ...chapter, end: chapterHints[index + 1]?.start ?? text.length }))) };
}

export function organizeEpubChapters(chapters = []) {
  if (!chapters.length || chapters.some(c => !String(c.source || '').startsWith('epub-'))) return chapters;
  const first = chapters.findIndex(c => /^i$/i.test(c.title.trim()));
  if (first < 0 || !/^ii$/i.test(chapters[first + 1]?.title?.trim() || '')) return chapters;
  const front = chapters.slice(0, first);
  const preface = front.findIndex(c => /^(preface|foreword|introduction)$/i.test(c.title.trim()));
  const result = [];
  if (first > 0) {
    result.push({ ...front[0], title: '扉页与出版信息', end: preface > 0 ? front[preface].start : chapters[first].start });
    if (preface > 0) result.push({ ...front[preface], title: 'Preface', end: chapters[first].start });
  }
  const body = chapters.slice(first);
  const license = body.findIndex(c => /THE FULL PROJECT GUTENBERG.*LICENSE/i.test(c.title));
  const tail = license < 0 ? body : body.slice(0, license);
  for (const [index, chapter] of tail.entries()) {
    if ((/^THE END$/i.test(chapter.title.trim()) || (chapter.source === 'epub-spine' && chapter.title === tail[index + 1]?.title && tail[index + 1]?.source === 'epub-heading')) && result.length) result[result.length - 1].end = chapter.end;
    else result.push({ ...chapter });
  }
  if (license >= 0) result.push({ ...body[license], title: '版权与许可', end: body.at(-1).end });
  return result.map((c, order) => ({ ...c, order }));
}
