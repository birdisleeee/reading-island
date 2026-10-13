import { detectChapterRanges, detectFormat, MAX_DOCUMENT_BYTES, parseDocumentBytes } from '../src/core/document-formats.mjs';

export const MAX_BYTES = MAX_DOCUMENT_BYTES;
export const id = prefix => prefix + '_' + crypto.randomUUID();
const safeMime = format => format === 'pdf' ? 'application/pdf' : format === 'txt' || format === 'md' ? 'text/plain' : 'application/octet-stream';
export async function sha(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}
export async function makeDocument(file, bookId, version = 1) {
  const format = detectFormat(file.name);
  if (!format) throw new Error('支持 TXT、Markdown、HTML、DOCX、DOC、PDF、EPUB、MOBI、AZW 和 AZW3。');
  if (!file.size || file.size > MAX_BYTES) throw new Error('请选择非空、大小不超过 25 MB 的电子书。');
  const bytes = await file.arrayBuffer();
  let parsed;
  try { parsed = await parseDocumentBytes(bytes, format); }
  catch (error) {
    if (format !== 'docx' && format !== 'epub') throw error;
    parsed = { text: '', parserVersion: `original-only-${format}-v1`, readingStatus: 'original-only', parseError: error.message };
  }
  const text = parsed.text;
  const chapterRanges = parsed.readingStatus === 'ready' ? (parsed.chapterHints?.length ? parsed.chapterHints : detectChapterRanges(text)) : [];
  return { document_id: id('doc'), book_id: bookId, file_name: file.name, filename: file.name, version,
    original: new Blob([bytes], { type: safeMime(format) }), original_sha256: await sha(bytes),
    format, text, text_sha256: await sha(new TextEncoder().encode(text)), parser_version: parsed.parserVersion, parse_error: parsed.parseError || '',
    reading_status: parsed.readingStatus, offset_unit: 'utf16-code-unit',
    chapters: chapterRanges.map((chapter, index) => ({ ...chapter, chapter_id: id('chapter'), order: index })),
    created_at: new Date().toISOString(), source: 'reader-upload' };
}

export const makeAnchor = (text, start, end) => {
  const splits = n => n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || splits(start) || splits(end)) throw new Error('选区无效，请重新选择完整文字。');
  return { start, end, exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 120), start), suffix: text.slice(end, end + 120) };
};

export function createBook(doc, title) {
  return { book_id: doc.book_id, title, current_document_id: doc.document_id, reading_status: '', reading_started_at: '', reading_finished_at: '', created_at: new Date().toISOString() };
}

export function createAnnotation(bookId, doc, range, insight = '') {
  const anchored = anchor(doc, range.start, range.end);
  return { annotation_id: id('note'), book_id: bookId, document_id: doc.document_id, document_version: doc.version || 1, anchor: anchored, insight, created_at: new Date().toISOString() };
}

export function createThreadMessage(author, text) {
  return { message_id: id('msg'), author, text, created_at: new Date().toISOString() };
}

export function resolveAnnotation(note, doc) {
  if (!doc) return { found: false, exact: note.anchor.exact, start: note.anchor.start, end: note.anchor.end };
  try {
    if (!note.anchor.document_id && note.text_sha256) {
      if (note.document_id !== doc.document_id || note.document_version !== doc.version || note.text_sha256 !== doc.text_sha256) throw new Error('版本不符');
      const result = anchor(doc, note.anchor.start, note.anchor.end);
      if (result.exact !== note.anchor.exact) throw new Error('原文不符');
      return {found:true,exact:result.exact,start:result.start,end:result.end};
    }
    const result = verifyAnchor(doc, note.anchor); return { found: true, exact: result.exact, start: result.start, end: result.end }; }
  catch { return { found: false, exact: note.anchor.exact, start: note.anchor.start, end: note.anchor.end }; }
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('reading-local-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}

export async function readSnapshot(db) {
  const raw = await requestResult(db.transaction('state').objectStore('state').get('library'));
  if (!raw || raw.annotations) return raw;
  const threads = [];
  const annotations = (raw.notes || []).map((old) => {
    const annotation = { annotation_id: old.annotation_id, book_id: old.book_id, document_id: old.anchor.document_id, document_version: Math.max(1, raw.documents.filter((doc) => doc.book_id === old.book_id).findIndex((doc) => doc.document_id === old.anchor.document_id) + 1), anchor: old.anchor, insight: old.insight || '', created_at: old.created_at || new Date().toISOString() };
    if ((old.messages || []).length || old.status === 'open') {
      const thread = { thread_id: id('thread'), annotation_id: old.annotation_id, document_id: old.anchor.document_id, status: old.status || 'open', messages: (old.messages || []).map((message) => ({ ...message, message_id: message.message_id || id('msg'), author: message.author || 'me' })) };
      annotation.thread_id = thread.thread_id;
      threads.push(thread);
    }
    return annotation;
  });
  const documents = raw.documents.map((doc) => ({ ...doc, filename: doc.filename || doc.file_name, version: doc.version || Math.max(1, raw.documents.filter((item) => item.book_id === doc.book_id).findIndex((item) => item.document_id === doc.document_id) + 1) }));
  return { revision: raw.revision || 0, books: raw.books, documents, annotations, threads };
}

export async function saveSnapshot(db, next, expectedRevision) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    const store = tx.objectStore('state');
    const get = store.get('library');
    let reason;
    get.onsuccess = () => {
      if ((get.result?.revision || 0) !== expectedRevision) { reason = new Error('另一个页面更新了书架，请刷新后重试。'); tx.abort(); return; }
      store.put(next, 'library');
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(reason || tx.error || new Error('本地保存失败'));
  });
}
function splitsSurrogate(text, n) {
  return n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]);
}
export function anchor(doc, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > doc.text.length || splitsSurrogate(doc.text, start) || splitsSurrogate(doc.text, end)) throw new Error('选区无效，请重新选择完整文字。');
  if (end - start > 12000) throw new Error('一次最多选择 12000 个文本单位，请缩小范围。');
  return { document_id: doc.document_id, text_sha256: doc.text_sha256, parser_version: doc.parser_version,
    offset_unit: doc.offset_unit, start, end, exact: doc.text.slice(start, end),
    prefix: doc.text.slice(Math.max(0, start - 120), start), suffix: doc.text.slice(end, end + 120) };
}
export function verifyAnchor(doc, a) {
  if (doc.document_id !== a.document_id || doc.text_sha256 !== a.text_sha256 || doc.parser_version !== a.parser_version || doc.offset_unit !== a.offset_unit) throw new Error('文档版本不匹配，保留批注并停止定位。');
  const actual = anchor(doc, a.start, a.end);
  if (actual.exact !== a.exact || actual.prefix !== a.prefix || actual.suffix !== a.suffix) throw new Error('原文校验失败，保留批注并停止定位。');
  return actual;
}
export function discussionContext(book, doc, note) {
  if (book.book_id !== doc.book_id || note.book_id !== book.book_id) throw new Error('书籍归属不匹配');
  verifyAnchor(doc, note.anchor);
  return { protocol: 'reading-context-local-v1', delivery: 'local-only-not-sent',
    book: { book_id: book.book_id, title: book.title },
    document: { document_id: doc.document_id, original_sha256: doc.original_sha256, text_sha256: doc.text_sha256, file_name: doc.file_name, parser_version: doc.parser_version, offset_unit: doc.offset_unit },
    annotation_id: note.annotation_id, range: structuredClone(note.anchor),
    context: { before: note.anchor.prefix, quote: note.anchor.exact, after: note.anchor.suffix },
    insight: note.insight, discussion: structuredClone(note.messages), status: note.status };
}
