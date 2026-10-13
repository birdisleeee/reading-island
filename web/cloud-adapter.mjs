import { organizeEpubChapters } from '../src/core/document-formats.mjs';
import { readingConfig } from './badge-appearance.mjs';
import { createReadingClient } from '../src/cloudflare/client.mjs';

// Only enabled by the Cloudflare candidate page. Preview IndexedDB is never imported.
export function createCloudLibrary() {
  const api = createReadingClient({ origin: readingConfig.apiOrigin });
  const textCache = new Map(), coverCache = new Map(), coverJobs = new Map(), groupIds = new Map();
  const fields = book => ({ book_id: book.book_id, title: book.title, author: book.author || '', publisher: book.publisher || '', reading_status: book.reading_status === 'finished' ? 'read' : book.reading_status || '', reading_started_at: book.reading_started_at || '', reading_finished_at: book.reading_finished_at || '' });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function all(kind, query = {}) {
    const result = []; let after = '';
    do { const page = await api.list(kind, { ...query, limit: 100, ...(after ? { after } : {}) }); result.push(...page.items); after = page.next; } while (after);
    return result;
  }
  async function loadThread(threadId) {
    const thread = await api.get('threads', threadId);
    thread.topic = thread.title;
    thread.messages = (await all('messages', { thread_id: thread.thread_id })).sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
    return thread;
  }
  async function load({ shelfOnly = false } = {}) {
    const [groups, books, documents, annotations, threads, messages] = await Promise.all(['groups', 'books', 'documents', 'annotations', 'threads', 'messages'].map(kind => shelfOnly && !['groups','books'].includes(kind) ? [] : all(kind)));
    for (const book of books) {
      if (book.reading_status === 'read') book.reading_status = 'finished';
      book.category = groups.find(group => group.group_id === book.group_id)?.name || '堆放';
      if (book.cover_sha256) {
        book.cover_data = coverCache.get(book.cover_sha256);
      }
    }
    for (const doc of documents) { doc.reading_status = doc.status === 'ready' ? doc.parse_status || 'ready' : 'uploading'; doc.text = textCache.get(doc.document_id) || ''; if (doc.format === 'epub') doc.chapters = organizeEpubChapters(doc.chapters); }
    for (const thread of threads) {
      thread.topic = thread.title;
      thread.messages = messages.filter(message => message.thread_id === thread.thread_id).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.created_at.localeCompare(b.created_at));
      const note = annotations.find(note => note.annotation_id === thread.annotation_id);
      if (note) { note.thread_id = thread.thread_id; if (!note.purpose && thread.thread_id === note.annotation_id.replace(/^note_/, 'thread_')) note.purpose = 'discussion'; }
    }
    return { revision: 0, groups: ['堆放', ...groups.map(group => group.name)], group_records: groups, books, documents, annotations, threads };
  }
  async function ensureBook(state, bookId) {
    for (const doc of state.documents.filter(doc => doc.book_id === bookId && doc.status === 'ready' && doc.reading_status === 'ready')) {
      if (!textCache.has(doc.document_id)) {
        const source = await (await api.readText(doc)).text();
        const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)))].map(n => n.toString(16).padStart(2, '0')).join('');
        if (sha !== doc.text_sha256) throw new Error('原文校验失败，请重新载入。');
        textCache.set(doc.document_id, source);
      }
      doc.text = textCache.get(doc.document_id);
    }
  }
  let saving = false;
  async function commit(before, next) {
    if (saving) throw new Error('正在保存，请稍候。');
    saving = true;
    try {
      const groups = [...before.group_records];
      for (const name of next.groups.filter(name => name !== '堆放' && !before.groups.includes(name))) {
        if (!groupIds.has(name)) groupIds.set(name, `group_${crypto.randomUUID()}`);
        groups.push(await api.createGroup({ group_id: groupIds.get(name), name }));
      }
      const groupId = book => groups.find(group => group.name === book.category)?.group_id || '';
      for (const book of next.books) {
        const old = before.books.find(item => item.book_id === book.book_id);
        const payload = { ...fields(book), group_id: groupId(book) };
        let saved = old;
        if (!old) saved = await api.createBook(payload);
        else if (!same({ ...fields(old), group_id: old.group_id }, payload)) saved = await api.updateBook({ ...payload, revision: old.revision });
        if (book.cover_data?.startsWith('data:') && book.cover_data !== old?.cover_data) await api.uploadCover(saved, await (await fetch(book.cover_data)).blob());
      }
      for (const group of groups.filter(group => !next.groups.includes(group.name))) { await api.deleteGroup(group); groupIds.delete(group.name); }
      for (const doc of next.documents) {
        const old = before.documents.find(item => item.document_id === doc.document_id);
        if (!old) {
          const saved = await api.uploadDocument({ book_id: doc.book_id, document_id: doc.document_id, file: new File([doc.original], doc.filename) });
          if (saved.text_sha256 === doc.text_sha256) textCache.set(doc.document_id, doc.text);
        } else if (!same(old.chapters, doc.chapters)) await api.updateChapters({ document_id: doc.document_id, revision: old.revision, chapters: doc.chapters });
      }
      for (const note of next.annotations.filter(note => !before.annotations.some(old => old.annotation_id === note.annotation_id))) await api.createAnnotation({ annotation_id: note.annotation_id, book_id: note.book_id, document_id: note.document_id, ...note.anchor, insight: note.insight, purpose: note.purpose || 'excerpt' });
      for (const thread of next.threads) {
        const old = before.threads.find(item => item.thread_id === thread.thread_id);
        if (!old) {
          const suffix = thread.thread_id.replace(/^thread_/, '');
          await api.createThread({ thread_id: thread.thread_id, book_id: thread.book_id, annotation_id: thread.annotation_id || null, document_id: thread.document_id || null, title: thread.topic, opening: thread.messages[0]?.text || '', opening_message_id: `msg_${suffix}`, turn_id: `turn_${suffix}`, delivery_id: `delivery_${suffix}` });
        } else {
          if (old.status !== thread.status) await api.updateThread({ thread_id: thread.thread_id, revision: old.revision, status: thread.status });
          const oldIds = new Set(old.messages.map(message => message.message_id));
          for (const message of thread.messages.filter(message => message.author === 'me' && !oldIds.has(message.message_id))) {
            const suffix = message.message_id.replace(/^msg_/, '');
            await api.sendMessage({ thread_id: thread.thread_id, message_id: message.message_id, turn_id: `turn_${suffix}`, delivery_id: `delivery_${suffix}`, text: message.text });
          }
        }
      }
      return await load();
    } finally { saving = false; }
  }
  return {
    unread: api.unread,
    readThread: api.readThread,
    load,
    async loadCovers(state, ready) {
      await Promise.all(state.books.filter(book => book.cover_sha256 && !book.cover_data).map(async book => {
        try {
          if (!coverCache.has(book.cover_sha256)) {
            if (!coverJobs.has(book.cover_sha256)) coverJobs.set(book.cover_sha256, api.readCover(book).then(blob=>URL.createObjectURL(blob)).finally(()=>coverJobs.delete(book.cover_sha256)));
            coverCache.set(book.cover_sha256, await coverJobs.get(book.cover_sha256));
          }
          book.cover_data = coverCache.get(book.cover_sha256);
          ready(book);
        } catch { /* A missing cover must not block the library. */ }
      }));
    },
    commit,
    ensureBook,
    visitChapter: api.visitChapter,
    refreshThread: loadThread,
    retryTurn: async (threadId, turnId) => {
      await api.retryTurn({ thread_id: threadId, turn_id: turnId });
      return loadThread(threadId);
    },
    original: doc => api.readOriginal(doc),
  };
}
