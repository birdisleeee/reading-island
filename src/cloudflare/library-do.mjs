import { DurableObject } from 'cloudflare:workers';
import { storeFrozenDocument, readFrozenRange } from './r2-documents.mjs';
import { identity, text, requireValue, ReadingError, digest } from './validation.mjs';
import { coverType } from './covers.mjs';
import { detectChapterRanges, detectFormat, parseDocumentBytes } from '../core/document-formats.mjs';
import { DOMParser } from 'linkedom';
import {normalizeSchedule,nextOccurrence} from '../core/schedule.mjs';
import {dispatchReadingTurn} from './ai.mjs';

class ReadingMarkupParser extends DOMParser {
  parseFromString(markup, mime) {
    if (mime === 'text/html' && !/<html[\s>]/i.test(markup)) markup = `<html><head></head><body>${markup}</body></html>`;
    return super.parseFromString(markup, mime);
  }
}

const now = () => new Date().toISOString();
const kinds = ['group', 'book', 'document', 'annotation', 'thread', 'message'];
const turnStatuses = ['pending', 'dispatching', 'accepted', 'processing', 'delivering', 'completed', 'failed', 'cancelled', 'interrupted', 'unavailable'];

// One independent SQLite-backed object per authenticated owner. The storage object is isolated by authenticated owner.
export class ReadingLibraryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS reading_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, book_id TEXT NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY(kind, id));
      CREATE INDEX IF NOT EXISTS reading_book_records ON reading_records(kind, book_id, id);
      CREATE TABLE IF NOT EXISTS reading_owner (id TEXT PRIMARY KEY);`);
  }

  #get(kind, id, required = true) {
    const row = this.ctx.storage.sql.exec('SELECT value FROM reading_records WHERE kind = ? AND id = ?', kind, identity(id)).toArray()[0];
    if (!row) { requireValue(!required, 'not_found', 404); return null; }
    return JSON.parse(row.value);
  }

  #put(kind, id, value) {
    this.ctx.storage.sql.exec('INSERT INTO reading_records(kind, id, book_id, value) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET value = excluded.value', kind, id, value.book_id || '', JSON.stringify(value));
    return value;
  }

  #create(kind, id, value) {
    const old = this.#get(kind, id, false);
    if (old) {
      requireValue(old.creation_payload === JSON.stringify(value), 'idempotency_conflict', 409);
      return old;
    }
    return this.#put(kind, id, { ...value, revision: 1, created_at: now(), creation_payload: JSON.stringify(value) });
  }

  #bookFields(input) {
    const result = { title: text(input.title, 300), author: text(input.author, 200, true), publisher: text(input.publisher, 200, true), group_id: input.group_id ? identity(input.group_id) : '', reading_status: input.reading_status || '', reading_started_at: input.reading_started_at || '', reading_finished_at: input.reading_finished_at || '' };
    requireValue(['', 'unread', 'reading', 'read'].includes(result.reading_status));
    for (const key of ['reading_started_at', 'reading_finished_at']) {
      const value = result[key];
      requireValue(value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value));
    }
    requireValue(!result.reading_started_at || !result.reading_finished_at || result.reading_started_at <= result.reading_finished_at, 'invalid_date_order');
    if (result.group_id) requireValue(!this.#get('group', result.group_id).archived, 'group_unavailable', 404);
    return result;
  }

  #list(input) {
    requireValue(kinds.includes(input.kind));
    const limit = input.limit ?? 50;
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 100);
    const after = input.after ? identity(input.after) : '';
    const predicates = ['kind = ?', 'id > ?', "COALESCE(json_extract(value, '$.archived'), 0) = 0"];
    const params = [input.kind, after];
    if (input.book_id) { predicates.push('book_id = ?'); params.push(identity(input.book_id)); }
    if (input.thread_id) { requireValue(input.kind === 'message'); this.#get('thread', input.thread_id); predicates.push("json_extract(value, '$.thread_id') = ?"); params.push(identity(input.thread_id)); }
    const rows = this.ctx.storage.sql.exec(`SELECT id, value FROM reading_records WHERE ${predicates.join(' AND ')} ORDER BY id LIMIT ?`, ...params, limit + 1).toArray();
    return { items: rows.slice(0, limit).map(row => JSON.parse(row.value)), next: rows.length > limit ? rows[limit - 1].id : null };
  }

  async #upload(owner, input) {
    const bookId = identity(input.book_id), documentId = identity(input.document_id);
    const filename = text(input.filename, 250);
    requireValue(input.bytes instanceof Uint8Array && input.bytes.byteLength > 0 && input.bytes.byteLength <= 25 * 1024 * 1024, 'invalid_file_size');
    const format = detectFormat(filename);
    requireValue(format, 'unsupported_document_format', 415);
    let parsed;
    try { parsed = await parseDocumentBytes(input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength), format, ReadingMarkupParser); }
    catch {
      if (!['docx', 'epub'].includes(format)) throw new ReadingError(422, 'document_parse_failed');
      parsed = { text: '', parserVersion: `original-only-${format}-v1`, readingStatus: 'original-only' };
    }
    const source = parsed.text;
    requireValue(new TextEncoder().encode(source).byteLength <= 32 * 1024 * 1024, 'parsed_document_too_large', 413);
    const originalSha = await digest(input.bytes), textSha = await digest(new TextEncoder().encode(source));
    const fingerprint = JSON.stringify({ bookId, filename, originalSha });
    const reservation = this.ctx.storage.transactionSync(() => {
      const book = this.#get('book', bookId), previous = this.#get('document', documentId, false);
      requireValue(!book.import_document_id || book.import_document_id === documentId, 'import_document_mismatch', 409);
      if (previous) { requireValue(previous.upload_fingerprint === fingerprint, 'idempotency_conflict', 409); return previous; }
      const version = (book.last_reserved_version || 0) + 1;
      this.#put('book', bookId, { ...book, last_reserved_version: version });
      return this.#put('document', documentId, { document_id: documentId, book_id: bookId, filename, version, text_sha256: textSha, original_sha256: originalSha, parser_version: parsed.parserVersion, parse_status: parsed.readingStatus, format, length: source.length, chapters: (parsed.chapterHints || detectChapterRanges(source)).map((chapter, index) => ({ ...chapter, chapter_id: `${documentId}_${index}`, order: index })), revision: 1, status: 'uploading', upload_fingerprint: fingerprint, created_at: now() });
    });
    if (reservation.status === 'ready') return reservation;
    // External R2 I/O deliberately outside SQL transaction. Retry uses same reservation.
    await storeFrozenDocument(this.env.BOOK_BUCKET, { owner_id: owner, book_id: bookId }, { ...reservation, text: source }, input.bytes);
    return this.ctx.storage.transactionSync(() => {
      const book = this.#get('book', bookId), current = this.#get('document', documentId);
      if (current.status === 'ready') return current;
      const ready = this.#put('document', documentId, { ...current, status: 'ready' });
      // A slower older upload cannot make the latest book version go backwards.
      if ((book.current_version || 0) < ready.version) this.#put('book', bookId, { ...book, ...(book.import_document_id === documentId ? { archived: false, import_document_id: null } : {}), current_document_id: documentId, current_version: ready.version, revision: book.revision + 1 });
      return ready;
    });
  }

  async #annotation(owner, input) {
    const bookId = identity(input.book_id), annotationId = identity(input.annotation_id);
    this.#get('book', bookId);
    const doc = this.#get('document', input.document_id);
    requireValue(doc.book_id === bookId && doc.status === 'ready', 'document_unavailable', 404);
    const start = input.start, end = input.end;
    requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end - start <= 4000 && end <= doc.length, 'invalid_range');
    const range = await readFrozenRange(this.env.BOOK_BUCKET, { owner_id: owner, book_id: bookId }, doc, start, end - start);
    requireValue(range.end === end && range.text === input.exact, 'excerpt_mismatch', 409);
    return this.#create('annotation', annotationId, { annotation_id: annotationId, book_id: bookId, document_id: doc.document_id, document_version: doc.version, text_sha256: doc.text_sha256, anchor: { start, end, exact: range.text }, insight: text(input.insight, 10000, true), purpose: input.purpose === 'discussion' ? 'discussion' : 'excerpt' });
  }

  async #modelAddBook(owner,input){
    const settings=this.#get('settings','ai',false),allowed=settings?settings.public.allow_upload===true:this.env.MODEL_ALLOW_UPLOAD==='true';
    requireValue(allowed,'model_upload_not_allowed',403);
    const turn=this.#get('turn',identity(input.turn_id)),thread=this.#get('thread',turn.thread_id);
    requireValue(turn.status==='dispatching'&&!thread.scheduled,'model_upload_not_allowed',403);
    requireValue(Object.keys(input).every(key=>['turn_id','title','author','content','format'].includes(key)),'invalid_upload_input');
    const title=text(input.title,300),author=text(input.author,200,true),content=text(input.content,100000),format=input.format||'txt';
    requireValue(['txt','md'].includes(format),'unsupported_document_format',415);
    const fingerprint=await digest(new TextEncoder().encode(JSON.stringify({title,author,content,format})));
    const id='model_'+(await digest(new TextEncoder().encode(owner+'\0'+turn.turn_id))).slice(0,40),bookId=id+'_book',documentId=id+'_doc';
    const reservation=this.ctx.storage.transactionSync(()=>{
      const old=this.#get('model_upload',id,false);
      if(old){requireValue(old.fingerprint===fingerprint,'idempotency_conflict',409);return old;}
      this.#create('book',bookId,{book_id:bookId,...this.#bookFields({title,author}),created_by:'assistant',archived:true,current_document_id:null,current_version:0});
      return this.#put('model_upload',id,{book_id:bookId,document_id:documentId,fingerprint,status:'uploading'});
    });
    if(reservation.status==='ready')return reservation.result;
    // Hidden reservation prevents an incomplete R2 upload appearing as an empty book.
    const doc=await this.#upload(owner,{book_id:bookId,document_id:documentId,filename:'text.'+format,bytes:new TextEncoder().encode(content)});
    return this.ctx.storage.transactionSync(()=>{
      const book=this.#get('book',bookId),result={book_id:bookId,document_id:doc.document_id,title,format,created:true};
      this.#put('book',bookId,{...book,archived:false});this.#put('model_upload',id,{...reservation,status:'ready',result});return result;
    });
  }

  #readerProfile(owner) {
    const profile = this.#get('settings', 'profile', false);
    return { user_id: owner, username: profile?.username || owner, revision: profile?.revision || 0 };
  }

  #readerIdentity(owner) {
    const { user_id, username } = this.#readerProfile(owner);
    return { user_id, username };
  }

  async #execute(owner, operation, input) {
    if (operation === 'getProfile') return this.#readerProfile(owner);
    if (operation === 'putProfile') return this.ctx.storage.transactionSync(() => {
      const old = this.#readerProfile(owner);
      requireValue(input.revision === old.revision, 'revision_conflict', 409);
      const username = text(input.username, 60).trim();
      requireValue(!/[\u0000-\u001f\u007f]/.test(username), 'invalid_username');
      this.#put('settings', 'profile', { username, revision: old.revision + 1 });
      return this.#readerProfile(owner);
    });
    if(operation==='getSchedule')return this.#scheduleView();
    if(operation==='putSchedule'){
      let value;try{value=normalizeSchedule(input);}catch(error){throw new ReadingError(400,error.message);}
      const saved=this.ctx.storage.transactionSync(()=>{
        const old=this.#get('settings','schedule',false);requireValue(input.revision===(old?.revision||0),'revision_conflict',409);
        if(value.enabled)requireValue(this.#get('settings','ai',false)||(this.env.AI_MODE==='model'&&this.env.MODEL_API_KEY)||(this.env.AI_MODE==='webhook'&&this.env.AI_WEBHOOK_URL),'ai_not_configured',409);
        if(value.enabled){for(const id of value.book_ids)this.#get('book',id);if(value.scope==='group'&&value.group_id)this.#get('group',value.group_id);}
        return this.#put('settings','schedule',{...value,origin:input.origin,revision:(old?.revision||0)+1,next_run:value.enabled?nextOccurrence(value):null,cursor:old?.cursor||0});
      });
      await this.#armSchedule(saved);return this.#scheduleView();
    }
    if(operation==='getAISettings')return this.#get('settings','ai',false);
    if(operation==='putAISettings')return this.ctx.storage.transactionSync(()=>{
      const old=this.#get('settings','ai',false);requireValue(input.revision===(old?.revision||0),'revision_conflict',409);
      requireValue(typeof input.iv==='string'&&typeof input.cipher==='string'&&input.public&&typeof input.tested_at==='string');
      return this.#put('settings','ai',{iv:input.iv,cipher:input.cipher,public:input.public,revision:(old?.revision||0)+1,tested_at:input.tested_at});
    });
    if (operation === 'unread') {
      const threads = this.ctx.storage.sql.exec(`SELECT json_extract(m.value, '$.thread_id') AS thread_id, m.book_id, COUNT(*) AS count
        FROM reading_records m LEFT JOIN reading_records r
        ON r.kind = 'thread_read' AND r.id = json_extract(m.value, '$.thread_id')
        WHERE m.kind = 'message' AND json_extract(m.value, '$.author') = 'assistant'
        AND json_extract(m.value, '$.sequence') > COALESCE(json_extract(r.value, '$.sequence'), -1)
        GROUP BY json_extract(m.value, '$.thread_id'), m.book_id`).toArray();
      const totals = new Map();
      for (const thread of threads) totals.set(thread.book_id,(totals.get(thread.book_id)||0)+thread.count);
      const items = [...totals].sort(([a],[b])=>a.localeCompare(b)).map(([book_id,count])=>({book_id,count}));
      return {items, threads};
    }
    if (operation === 'readThread') return this.ctx.storage.transactionSync(() => {
      const thread = this.#get('thread', input.thread_id);
      const message = this.#get('message', input.message_id);
      requireValue(message.thread_id === thread.thread_id, 'message_thread_mismatch', 400);
      const previous = this.#get('thread_read', thread.thread_id, false);
      return this.#put('thread_read', thread.thread_id, {book_id:thread.book_id,
        sequence:Math.max(previous?.sequence ?? -1, message.sequence)});
    });
    if (operation === 'list') return this.#list(input);
    if (operation === 'get') { requireValue(kinds.includes(input.kind)); const record = this.#get(input.kind, input.id); if (input.book_id) requireValue(record.book_id === input.book_id, 'not_found', 404); return record; }
    if (operation === 'createGroup') return this.ctx.storage.transactionSync(() => {
      const groupId = identity(input.group_id), name = text(input.name, 100);
      const duplicate = this.ctx.storage.sql.exec("SELECT id FROM reading_records WHERE kind = 'group' AND id != ? AND json_extract(value, '$.name') = ? AND COALESCE(json_extract(value, '$.archived'), 0) = 0 LIMIT 1", groupId, name).toArray()[0];
      requireValue(name !== '堆放' && !duplicate, 'group_name_exists', 409);
      return this.#create('group', groupId, { group_id: groupId, name });
    });
    if (operation === 'createBook') return this.#create('book', identity(input.book_id), { book_id: input.book_id, ...this.#bookFields(input), ...(input.created_by === 'assistant' ? {created_by:'assistant'} : {}), ...(input.import_document_id ? { import_document_id: identity(input.import_document_id), archived: true } : {}), current_document_id: null, current_version: 0 });
    if (operation === 'readingProgress') return this.ctx.storage.transactionSync(() => {
      const doc = this.#get('document', identity(input.document_id));
      requireValue(doc.status === 'ready' && Number.isSafeInteger(input.start) && doc.chapters.some(chapter => chapter.start === input.start), 'invalid_chapter');
      const previous = doc.reading_progress || {visited_starts:[]};
      const progress = {visited_starts:[...new Set([...previous.visited_starts,input.start])].slice(-500),last_start:input.start};
      this.#put('document',doc.document_id,{...doc,reading_progress:progress});
      return progress;
    });
    if (operation === 'updateBook') return this.ctx.storage.transactionSync(() => {
      const book = this.#get('book', input.book_id);
      requireValue(input.revision === book.revision, 'revision_conflict', 409);
      return this.#put('book', input.book_id, { ...book, ...this.#bookFields(input), revision: book.revision + 1 });
    });
    if (operation === 'deleteGroup') return this.ctx.storage.transactionSync(() => {
      const group = this.#get('group', input.group_id);
      if (group.archived) return group;
      requireValue(group.revision === input.revision, 'revision_conflict', 409);
      for (const row of this.ctx.storage.sql.exec("SELECT id, value FROM reading_records WHERE kind = 'book' AND json_extract(value, '$.group_id') = ?", group.group_id).toArray()) {
        const book = JSON.parse(row.value);
        this.#put('book', row.id, { ...book, group_id: '', revision: book.revision + 1 });
      }
      return this.#put('group', group.group_id, { ...group, archived: true, revision: group.revision + 1 });
    });
    if (operation === 'cover') {
      const book = this.#get('book', input.book_id);
      requireValue(book.revision === input.revision, 'revision_conflict', 409);
      const type = coverType(input.bytes), hash = await digest(input.bytes);
      const key = `reading-island/v1/owners/${owner}/books/${book.book_id}/covers/${hash}`;
      const published = await this.env.BOOK_BUCKET.put(key, input.bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: type } });
      if (!published) {
        const existing = await this.env.BOOK_BUCKET.get(key);
        requireValue(existing && existing.size === input.bytes.byteLength && await digest(new Uint8Array(await existing.arrayBuffer())) === hash, 'cover_storage_conflict', 503);
      }
      return this.ctx.storage.transactionSync(() => {
        const latest = this.#get('book', book.book_id);
        requireValue(latest.revision === input.revision, 'revision_conflict', 409);
        return this.#put('book', book.book_id, { ...latest, cover_sha256: hash, cover_type: type, revision: latest.revision + 1 });
      });
    }
    if (operation === 'chapters') {
      const doc = this.#get('document', input.document_id);
      requireValue(doc.status === 'ready' && input.revision === doc.revision, 'revision_conflict', 409);
      requireValue(Array.isArray(input.chapters) && input.chapters.length > 0 && input.chapters.length <= 500, 'invalid_chapters');
      const chapters = input.chapters.map((row, index) => ({ chapter_id: `${doc.document_id}_${index}`, title: text(row.title, 100), start: row.start, end: input.chapters[index + 1]?.start ?? doc.length, order: index, source: 'manual' }));
      requireValue(chapters[0].start === 0 && chapters.every(row => Number.isSafeInteger(row.start) && row.start >= 0 && Number.isSafeInteger(row.end) && row.end > row.start && row.end <= doc.length), 'invalid_chapters');
      for (const row of chapters) {
        try { await readFrozenRange(this.env.BOOK_BUCKET, { owner_id: owner, book_id: doc.book_id }, doc, row.start, Math.min(2, doc.length - row.start)); }
        catch { throw new ReadingError(400, 'invalid_chapter_boundary'); }
      }
      return this.ctx.storage.transactionSync(() => {
        const latest = this.#get('document', doc.document_id);
        requireValue(latest.revision === input.revision, 'revision_conflict', 409);
        return this.#put('document', doc.document_id, { ...latest, chapters, revision: latest.revision + 1 });
      });
    }
    if (operation === 'threadStatus') return this.ctx.storage.transactionSync(() => {
      const thread = this.#get('thread', input.thread_id);
      requireValue(['open', 'closed'].includes(input.status));
      requireValue(thread.revision === input.revision, 'revision_conflict', 409);
      return this.#put('thread', thread.thread_id, { ...thread, status: input.status, revision: thread.revision + 1 });
    });
    if (operation === 'upload') return this.#upload(owner, input);
    if (operation === 'modelAddBook') return this.#modelAddBook(owner,input);
    if (operation === 'source') {
      requireValue(Number.isSafeInteger(input.start) && input.start >= 0 && Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= 4000, 'invalid_range');
      const doc = this.#get('document', input.document_id);
      requireValue(doc.status === 'ready' && doc.book_id === input.book_id, 'document_unavailable', 404);
      requireValue(input.version === doc.version && input.text_sha256 === doc.text_sha256, 'frozen_version_mismatch', 409);
      requireValue(input.start <= doc.length, 'invalid_range');
      return readFrozenRange(this.env.BOOK_BUCKET, { owner_id: owner, book_id: doc.book_id }, doc, input.start, input.limit);
    }
    if (operation === 'createAnnotation') return this.#annotation(owner, input);
    if (operation === 'discussionContext') {
      const thread = this.#get('thread', input.thread_id), book = this.#get('book', thread.book_id);
      requireValue(thread.status === 'open', 'discussion_closed', 409);
      const annotation = thread.annotation_id ? this.#get('annotation', thread.annotation_id) : null;
      const doc = thread.document_id ? this.#get('document', thread.document_id) : null;
      requireValue(!doc || (doc.book_id === book.book_id && doc.status === 'ready'), 'document_unavailable', 404);
      requireValue(!annotation || (annotation.book_id === book.book_id && annotation.document_id === doc?.document_id && annotation.document_version === doc.version), 'source_mismatch', 409);
      return { protocol: 'reading-context-v1', reader: this.#readerIdentity(owner), thread_id: thread.thread_id, session_id: thread.session_id,
        book: { book_id: book.book_id, title: book.title, author: book.author }, discussion: { topic: thread.title, status: thread.status },
        source: annotation ? { annotation_id: annotation.annotation_id, document_id: doc.document_id, document_version: doc.version, ...annotation.anchor, insight: annotation.insight } : null,
        source_link: doc?.parse_status === 'ready' ? `reading://source/${thread.thread_id}/${doc.document_id}?version=${doc.version}&sha=${doc.text_sha256}` : null };
    }
    if (operation === 'createAssistantThread') return this.ctx.storage.transactionSync(() => {
      const book=this.#get('book',identity(input.book_id)), threadId=identity(input.thread_id);
      const annotation=input.annotation_id ? this.#get('annotation',identity(input.annotation_id)) : null;
      requireValue(!annotation || annotation.book_id===book.book_id,'annotation_not_in_book',409);
      const previous=this.#get('thread',threadId,false);
      const documentId=annotation?.document_id || input.document_id || previous?.document_id || book.current_document_id;
      const doc=documentId ? this.#get('document',identity(documentId)) : null;
      requireValue(!doc || (doc.book_id===book.book_id && doc.status==='ready'),'document_unavailable',404);
      const messageId=identity(`message_${threadId}`),turnId=identity(`opening_${threadId}`);
      const thread=this.#create('thread',threadId,{thread_id:threadId,book_id:book.book_id,annotation_id:annotation?.annotation_id || null,document_id:doc?.document_id || null,title:text(input.title,500),opening:text(input.opening,16000),created_by:'assistant',status:'open',session_id:`reading:${owner}:${threadId}`,delivery_status:'completed',opening_turn_id:turnId,message_count:1});
      this.#create('message',messageId,{thread_id:threadId,book_id:book.book_id,message_id:messageId,author:'assistant',text:thread.opening,turn_id:turnId,sequence:0});
      return thread;
    });
    if (operation === 'createThread') return this.ctx.storage.transactionSync(() => {
      const book = this.#get('book', input.book_id), threadId = identity(input.thread_id);
      const openingMessageId = identity(input.opening_message_id), turnId = identity(input.turn_id), deliveryId = identity(input.delivery_id);
      requireValue(turnId.length <= 80, 'invalid_identity');
      const annotation = input.annotation_id ? this.#get('annotation', input.annotation_id) : null;
      requireValue(!annotation || annotation.book_id === book.book_id, 'annotation_not_in_book', 409);
      const previous = this.#get('thread', threadId, false);
      const documentId = annotation?.document_id || input.document_id || previous?.document_id || book.current_document_id;
      const doc = documentId ? this.#get('document', documentId) : null;
      requireValue(!doc || (doc.book_id === book.book_id && doc.status === 'ready'), 'document_unavailable', 404);
      const thread = this.#create('thread', threadId, { thread_id: threadId, book_id: book.book_id, annotation_id: annotation?.annotation_id || null, document_id: doc?.document_id || null, title: text(input.title, 500), opening: text(input.opening, 16000), status: 'open', session_id: `reading:${owner}:${threadId}`, delivery_status: 'pending', opening_turn_id: turnId, message_count: 1 });
      this.#create('message', openingMessageId, { thread_id: threadId, book_id: book.book_id, message_id: openingMessageId, author: 'me', text: thread.opening, turn_id: turnId, sequence: 0 });
      this.#create('turn', turnId, { turn_id: turnId, thread_id: threadId, book_id: book.book_id, user_message_id: openingMessageId, delivery_id: deliveryId, status: 'pending', retryable: true, detail_code: '' });
      return thread;
    });
    if (operation === 'createUserTurn') return this.ctx.storage.transactionSync(() => {
      const thread = this.#get('thread', input.thread_id), messageId = identity(input.message_id), turnId = identity(input.turn_id), deliveryId = identity(input.delivery_id);
      requireValue(turnId.length <= 80, 'invalid_identity');
      requireValue(thread.status === 'open', 'discussion_closed', 409);
      const body = text(input.text, 16000);
      const previous = this.#get('turn', turnId, false);
      if (previous) {
        const message = this.#get('message', previous.user_message_id);
        requireValue(previous.thread_id === thread.thread_id && previous.delivery_id === deliveryId && previous.user_message_id === messageId && message.text === body, 'idempotency_conflict', 409);
        return { message, turn: previous };
      }
      const sequence = Number.isSafeInteger(thread.message_count) ? thread.message_count : Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM reading_records WHERE kind = 'message' AND json_extract(value, '$.thread_id') = ?", thread.thread_id).toArray()[0]?.total || 0);
      const queued=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM reading_records WHERE kind='turn' AND json_extract(value,'$.thread_id')=? AND json_extract(value,'$.status') NOT IN ('completed','failed','cancelled')",thread.thread_id).toArray()[0]?.total||0);
      requireValue(queued<32,'discussion_queue_full',503);
      const turnValue = { turn_id: turnId, thread_id: thread.thread_id, book_id: thread.book_id, user_message_id: messageId, delivery_id: deliveryId, status: 'pending', retryable: true, detail_code: '' };
      const messageValue = { thread_id: thread.thread_id, book_id: thread.book_id, message_id: messageId, author: 'me', text: body, turn_id: turnId, sequence };
      const message = this.#create('message', messageId, messageValue);
      const turn = this.#create('turn', turnId, turnValue);
      this.#put('thread', thread.thread_id, { ...thread, delivery_status: 'pending', latest_turn_id: turnId, message_count: sequence + 1, revision: thread.revision + 1 });
      return { message, turn };
    });
    if (operation === 'prepareDispatch') {
      const turn = this.#get('turn', input.turn_id), thread = this.#get('thread', turn.thread_id), book = this.#get('book', thread.book_id), message = this.#get('message', turn.user_message_id);
      requireValue(thread.status === 'open', 'discussion_closed', 409);
      if (turn.dispatch_payload) return { turn, payload: turn.dispatch_payload };
      const annotation = thread.annotation_id ? this.#get('annotation', thread.annotation_id) : null;
      const doc = thread.document_id ? this.#get('document', thread.document_id) : null;
      requireValue(!doc || (doc.book_id === book.book_id && doc.status === 'ready'), 'document_unavailable', 404);
      const source = annotation ? { annotation_id: annotation.annotation_id, document_id: doc.document_id, document_version: doc.version, exact: annotation.anchor.exact, insight: annotation.insight } : null;
      const sourceLink = doc?.parse_status === 'ready' ? `reading://source/${thread.thread_id}/${doc.document_id}?version=${doc.version}&sha=${doc.text_sha256}` : null;
      const payload = { protocol: 'reading-turn-v1', reader: this.#readerIdentity(owner), thread_id: thread.thread_id, turn_id: turn.turn_id, delivery_id: turn.delivery_id, book: { title: book.title, author: book.author }, discussion: { topic: thread.title, status: thread.status, ...(thread.created_by === 'assistant' ? {assistant_opening:thread.opening} : {}) }, source, source_link: sourceLink, user_message: { message_id: message.message_id, text: message.text } };
      this.#put('turn', turn.turn_id, { ...turn, dispatch_payload: payload });
      return { turn, payload };
    }
    if (operation === 'claimDispatch') return this.ctx.storage.transactionSync(() => {
      const turn = this.#get('turn', input.turn_id);
      if (!['pending', 'unavailable'].includes(turn.status)) return { acquired: false, turn };
      const current=this.#get('message',turn.user_message_id);
      const earlier=this.ctx.storage.sql.exec("SELECT t.id FROM reading_records t JOIN reading_records m ON m.kind='message' AND m.id=json_extract(t.value,'$.user_message_id') WHERE t.kind='turn' AND json_extract(t.value,'$.thread_id')=? AND json_extract(m.value,'$.sequence') < ? AND json_extract(t.value,'$.status') NOT IN ('completed','failed','cancelled') LIMIT 1",turn.thread_id,current.sequence).toArray();
      if(earlier.length)return {acquired:false,turn};
      const updated = this.#put('turn', turn.turn_id, { ...turn, status: 'dispatching', retryable: false });
      return { acquired: true, turn: updated };
    });
    if (operation === 'nextPending') {
      const thread=this.#get('thread',input.thread_id);
      if(thread.status!=='open')return null;
      const rows=this.ctx.storage.sql.exec("SELECT t.value FROM reading_records t JOIN reading_records m ON m.kind='message' AND m.id=json_extract(t.value,'$.user_message_id') WHERE t.kind='turn' AND json_extract(t.value,'$.thread_id')=? AND json_extract(t.value,'$.status')='pending' ORDER BY json_extract(m.value,'$.sequence') LIMIT 1",thread.thread_id).toArray();
      return rows.length?JSON.parse(rows[0].value):null;
    }
    if (operation === 'modelHistory') {
      const turn=this.#get('turn', input.turn_id), current=this.#get('message',turn.user_message_id);
      return this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='message' AND json_extract(value,'$.thread_id')=? AND json_extract(value,'$.sequence') < ? ORDER BY json_extract(value,'$.sequence') DESC LIMIT 20",turn.thread_id,current.sequence).toArray().reverse().map(row=>JSON.parse(row.value));
    }
    if (operation === 'markDispatch') return this.ctx.storage.transactionSync(() => {
      const turn = this.#get('turn', input.turn_id), thread = this.#get('thread', turn.thread_id);
      requireValue(['dispatching', 'accepted', 'unavailable'].includes(input.status), 'invalid_turn_status');
      if (['processing', 'delivering', 'completed', 'cancelled'].includes(turn.status)) return turn;
      const retryable = input.status === 'unavailable';
      const updated = this.#put('turn', turn.turn_id, { ...turn, status: input.status, retryable, detail_code: text(input.detail_code, 100, true), revision: (turn.revision || 1) + 1 });
      if ((thread.latest_turn_id || thread.opening_turn_id) === turn.turn_id) this.#put('thread', thread.thread_id, { ...thread, delivery_status: input.status, latest_turn_id: turn.turn_id, revision: thread.revision + 1 });
      return updated;
    });
    if (operation === 'updateTurnStatus') return this.ctx.storage.transactionSync(() => {
      const turn = this.#get('turn', input.turn_id), thread = this.#get('thread', turn.thread_id);
      requireValue(input.protocol === 'reading-status-v1', 'invalid_status_protocol');
      requireValue(input.thread_id === thread.thread_id, 'thread_mismatch', 409);
      requireValue(turnStatuses.includes(input.status) && input.status !== 'completed', 'invalid_turn_status');
      if (input.session_id) requireValue(input.session_id === thread.session_id, 'session_mismatch', 409);
      if (turn.status === 'completed') return turn;
      const updated = this.#put('turn', turn.turn_id, { ...turn, status: input.status, retryable: Boolean(input.retryable), detail_code: text(input.detail_code, 100, true), revision: (turn.revision || 1) + 1 });
      if ((thread.latest_turn_id || thread.opening_turn_id) === turn.turn_id) this.#put('thread', thread.thread_id, { ...thread, delivery_status: input.status, latest_turn_id: turn.turn_id, revision: thread.revision + 1 });
      return updated;
    });
    if (operation === 'applyReply') return this.ctx.storage.transactionSync(() => {
      const reply = input.reply;
      requireValue(reply && reply.protocol === 'reading-reply-v1', 'invalid_reply_protocol');
      const turn = this.#get('turn', reply.turn_id), thread = this.#get('thread', turn.thread_id);
      requireValue(reply.thread_id === thread.thread_id && reply.delivery_id === turn.delivery_id, 'reply_identity_mismatch', 409);
      const terminal = reply.terminal, actions = reply.actions;
      const newDiscussions = reply.new_discussions == null ? [] : reply.new_discussions;
      requireValue(terminal && ['completed', 'failed', 'cancelled'].includes(terminal.status) && typeof terminal.retryable === 'boolean' && Array.isArray(actions) && actions.length <= 128 && Array.isArray(newDiscussions) && newDiscussions.length <= 2, 'invalid_reply');
      requireValue((terminal.status === 'completed' && actions.length > 0) || (terminal.status !== 'completed' && actions.length === 0), 'invalid_reply');
      const fingerprint = JSON.stringify(reply);
      if (turn.reply_fingerprint) {
        requireValue(turn.reply_fingerprint === fingerprint, 'reply_conflict', 409);
        return { turn, messages: [], duplicate: true };
      }
      const firstSequence = Number.isSafeInteger(thread.message_count) ? thread.message_count : Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS total FROM reading_records WHERE kind = 'message' AND json_extract(value, '$.thread_id') = ?", thread.thread_id).toArray()[0]?.total || 0);
      const messages = actions.map((action, index) => {
        requireValue(action && action.kind === 'text' && action.index === index && action.count === actions.length, 'invalid_reply_action');
        const body = text(action.text, 12000);
        const quote = action.quote == null ? null : action.quote;
        requireValue(quote == null || (quote && typeof quote === 'object' && typeof quote.text === 'string' && quote.text.length <= 4000 && typeof quote.source_link === 'string' && quote.source_link.startsWith(`reading://source/${thread.thread_id}/`)), 'invalid_reply_quote');
        const messageId = identity(`assistant_${turn.turn_id}_${String(index).padStart(2, '0')}`);
        return this.#create('message', messageId, { thread_id: thread.thread_id, book_id: thread.book_id, message_id: messageId, author: 'assistant', text: body, quote, turn_id: turn.turn_id, action_index: index, sequence: firstSequence + index });
      });
      const createdDiscussions = newDiscussions.map((item, index) => {
        requireValue(item && typeof item.title === 'string' && typeof item.opening === 'string' && item.title.length <= 500 && item.opening.length <= 16000, 'invalid_discussion_action');
        const childId = identity(item.discussion_id || `discussion_${turn.turn_id}_${index}`);
        const childTurn = identity(`opening_${childId}`), childDelivery = identity(`delivery_${childId}`), childMessage = identity(`message_${childId}`);
        const sourceLink = item.source_link == null ? null : String(item.source_link);
        requireValue(sourceLink == null || sourceLink.startsWith(`reading://source/${thread.thread_id}/`), 'invalid_discussion_source');
        const child = this.#create('thread', childId, { thread_id: childId, book_id: thread.book_id, annotation_id: null, document_id: thread.document_id, title: item.title, opening: item.opening, created_by: 'assistant', status: 'open', session_id: `reading:${owner}:${childId}`, delivery_status: 'completed', opening_turn_id: childTurn, message_count: 1, parent_thread_id: thread.thread_id, parent_turn_id: turn.turn_id, source_link: sourceLink });
        this.#create('message', childMessage, { thread_id: childId, book_id: thread.book_id, message_id: childMessage, author: 'assistant', text: item.opening, turn_id: childTurn, sequence: 0, source_link: sourceLink });
        return child;
      });
      const updated = this.#put('turn', turn.turn_id, { ...turn, status: terminal.status, retryable: terminal.retryable, detail_code: '', reply_fingerprint: fingerprint, revision: (turn.revision || 1) + 1 });
      const latestStatus = (thread.latest_turn_id || thread.opening_turn_id) === turn.turn_id ? { delivery_status: terminal.status, latest_turn_id: turn.turn_id } : {};
      this.#put('thread', thread.thread_id, { ...thread, ...latestStatus, message_count: firstSequence + actions.length, revision: thread.revision + 1 });
      return { turn: updated, messages, discussions: createdDiscussions, duplicate: false };
    });
    if (operation === 'gatewaySource') {
      const thread = this.#get('thread', input.thread_id), doc = this.#get('document', input.document_id);
      requireValue(thread.status === 'open', 'discussion_closed', 409);
      requireValue(thread.document_id === doc.document_id && doc.book_id === thread.book_id && doc.status === 'ready', 'source_mismatch', 409);
      requireValue(input.version === doc.version && input.text_sha256 === doc.text_sha256, 'frozen_version_mismatch', 409);
      requireValue(Number.isSafeInteger(input.start) && input.start >= 0 && Number.isSafeInteger(input.limit) && input.limit > 0 && input.limit <= 4000 && input.start <= doc.length, 'invalid_range');
      return readFrozenRange(this.env.BOOK_BUCKET, { owner_id: owner, book_id: doc.book_id }, doc, input.start, input.limit);
    }
    throw new ReadingError(404, 'unknown_operation');
  }

  #scheduleView(){
    const saved=this.#get('settings','schedule',false)||{enabled:false,frequency:'weekly',time:'20:00',weekday:0,timezone:'Asia/Shanghai',scope:'all',group_id:'',book_ids:[],instruction:'请先读取原文，主动提出一个值得一起讨论的问题，邀请我回应。',revision:0,next_run:null};
    const {origin,cursor,...publicValue}=saved;
    const runs=this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='schedule_run' ORDER BY id DESC LIMIT 8").toArray().map(row=>JSON.parse(row.value));
    return {...publicValue,runs};
  }
  async #armSchedule(config=this.#get('settings','schedule',false)){
    if(config?.enabled&&config.next_run)await this.ctx.storage.setAlarm(config.next_run);else await this.ctx.storage.deleteAlarm();
  }
  async alarm(){
    const owner=this.ctx.storage.sql.exec('SELECT id FROM reading_owner LIMIT 1').toArray()[0]?.id;if(!owner)return;
    const config=this.#get('settings','schedule',false);if(!config?.enabled)return;
    const time=Date.now();if(config.next_run>time){await this.#armSchedule(config);return;}
    const runId=`run_${config.next_run}`;let run;
    // Atomically consume the occurrence and arm the next. A restarted alarm cannot repeat a paid request.
    this.ctx.storage.transactionSync(()=>{
      if(this.#get('schedule_run',runId,false))return;
      const books=this.ctx.storage.sql.exec("SELECT value FROM reading_records WHERE kind='book' AND COALESCE(json_extract(value,'$.archived'),0)=0 ORDER BY id").toArray().map(row=>JSON.parse(row.value)).filter(book=>{
        const doc=book.current_document_id?this.#get('document',book.current_document_id,false):null;
        return doc?.status==='ready'&&doc.length>0&&(config.scope==='all'||config.scope==='reading'&&book.reading_status==='reading'||config.scope==='group'&&book.group_id===config.group_id||config.scope==='books'&&config.book_ids.includes(book.book_id));
      });
      const book=books[config.cursor%Math.max(1,books.length)],late=time-config.next_run>6*3600000;
      run=this.#put('schedule_run',runId,{run_id:runId,due_at:config.next_run,status:late?'skipped_late':book?'preparing':'skipped_no_book',book_id:book?.book_id||null});
      this.#put('settings','schedule',{...config,next_run:nextOccurrence(config,time),cursor:config.cursor+(book&&!late?1:0)});
    });
    await this.#armSchedule();if(!run||run.status!=='preparing')return;
    const base=`scheduled_${config.next_run}`,threadId=base+'_thread',turnId=base+'_turn';
    try{
      const created=await this.call(owner,'createThread',{book_id:run.book_id,thread_id:threadId,turn_id:turnId,delivery_id:base+'_delivery',opening_message_id:base+'_message',title:'定时共读 · '+new Intl.DateTimeFormat('zh-CN',{timeZone:config.timezone,dateStyle:'short'}).format(new Date(config.next_run)),opening:config.instruction});
      if(!created.ok)throw new Error('topic_create_failed');
      this.#put('schedule_run',runId,{...run,status:'dispatching',thread_id:threadId});
      const thread=this.#get('thread',threadId);this.#put('thread',threadId,{...thread,scheduled:true});
      const stub={call:(...args)=>this.call(...args)};
      const result=await dispatchReadingTurn(this.env,stub,turnId,owner,config.origin);
      this.#put('schedule_run',runId,{...run,status:result.status,thread_id:threadId});
    }catch{this.#put('schedule_run',runId,{...run,status:'failed',thread_id:threadId});}
  }
  async call(owner, operation, input = {}) {
    try {
      identity(owner);
      const stored = this.ctx.storage.sql.exec('SELECT id FROM reading_owner LIMIT 1').toArray()[0];
      requireValue(!stored || stored.id === owner, 'owner_mismatch', 403);
      if (!stored) this.ctx.storage.sql.exec('INSERT INTO reading_owner(id) VALUES (?)', owner);
      const value = await this.#execute(owner, operation, input);
      // Internal fingerprints are for retry checks, not product API fields.
      return { ok: true, value: JSON.parse(JSON.stringify(value, (key, val) => ['creation_payload', 'upload_fingerprint'].includes(key) ? undefined : val)) };
    } catch (error) {
      if (error instanceof ReadingError) return { ok: false, status: error.status, error: error.code };
      // Do not echo source text, credentials, SQL, or R2 object keys into responses/logs.
      return { ok: false, status: 503, error: 'reading_storage_unavailable' };
    }
  }
}
