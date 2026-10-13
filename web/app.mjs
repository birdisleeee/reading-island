import { syncIslandBadgeAppearance, readingConfig } from './badge-appearance.mjs';
import { ensureSession } from './session.mjs';
await ensureSession();
import { groupDiscussionMessages } from './discussion-messages.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createAnnotation, createBook, createThreadMessage, makeAnchor, makeDocument, openDatabase, readSnapshot, resolveAnnotation, saveSnapshot } from './model.mjs';
import { btn, drawNote, groupView, icon, journalView, shelfView } from './visual.mjs';
import { detectChapterRanges, detectFormat, FORMAT_ACCEPT, formatLabel, normalizeChapterRanges } from '../src/core/document-formats.mjs';

void syncIslandBadgeAppearance();
window.addEventListener('pageshow', syncIslandBadgeAppearance);
window.addEventListener('focus', syncIslandBadgeAppearance);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncIslandBadgeAppearance(); });

const cloud = (await import('./cloud-adapter.mjs')).createCloudLibrary();
const db = null;
let state;
let cloudDetailsLoaded = !cloud;
let cloudDetailsJob = null;
async function ensureLibraryDetails() {
  if (cloudDetailsLoaded) return;
  if (!cloudDetailsJob) cloudDetailsJob = cloud.load().then(value => { state = value; cloudDetailsLoaded = true; }).finally(() => { cloudDetailsJob = null; });
  await cloudDetailsJob;
}

while (true) {
  try {
    state = cloud ? await cloud.load({ shelfOnly: true }) : await readSnapshot(db);
    break;
  }
  catch (error) {
    // Do not turn a failed read into an empty, writable library or demo data.
    const root = document.querySelector('#app');
    root.innerHTML = '<section class="shelf-screen"><header class="shelf-top"><a href="/" aria-label="返回首页">‹</a><h1>共读岛</h1></header><section class="empty"><p role="status"></p><button class="primary" type="button">重新加载</button></section></section>';
    root.querySelector('[role="status"]').textContent = error.message || '书库暂时无法读取，请稍后重试。';
    await new Promise(resolve => root.querySelector('button').addEventListener('click', resolve, { once: true }));
    root.querySelector('button').disabled = true;
    root.querySelector('[role="status"]').textContent = '正在读取书库…';
  }
}
let view = 'shelf';
let bookId = null;
let activeDocumentId = null;
let readerSearch = '';
let shelfSearch = '';
let selection = null;
let filter = 'all';
let share = null;
let menuOpen = false;
let chapterIndex = 0;
let journalTab = 'original';
let groupName = '';
const navigationStack = [];
let threadPollGeneration = 0;
let unreadCounts = new Map();
let unreadThreads = new Map();
let unreadJob = null;
const acknowledgedMessages = new Map();
const activeDeliveryStatuses = new Set(['pending', 'dispatching', 'accepted', 'processing', 'delivering']);
let bookDrag = null;
let suppressBookClick = false;
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const sheet = $('#sheet');
const shellReturn = readingConfig.returnUrl;

if (cloud && (location.hash.includes('thread=') || (history.state?.readingNav && !['shelf','group'].includes(history.state.readingNav.view)))) await ensureLibraryDetails();
const restoredThread = state.threads.find(thread => thread.thread_id === new URLSearchParams(location.hash.slice(1)).get('thread'));
if (history.state?.readingNav) {
  navigationStack.push(...(history.state.readingStack || []));
  restoreNav(history.state.readingNav);
  if (cloud && bookId && view === 'reader') await cloud.ensureBook(state, bookId);
} else if (restoredThread) {
  navigate('journal', { bookId: restoredThread.book_id, journalTab: 'discussion', activeDocumentId: restoredThread.document_id });
  navigate('thread', {}, restoredThread.thread_id);
}
history.replaceState({ readingNav: navState(), readingStack: navigationStack }, '', location.href);
render();
if (restoredThread) pollThread(restoredThread.thread_id);

async function commit(next) {
  if (cloud) { state = await cloud.commit(state, next); cloudDetailsLoaded = true; render(); return; }
  const expected = state.revision;
  next.revision = expected + 1;
  await saveSnapshot(db, next, expected);
  state = next;
  render();
}

async function pollThread(threadId) {
  if (!cloud) return;
  const generation = ++threadPollGeneration;
  for (let attempt = 0; ; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 500 : Math.min(10000, 1500 + attempt * 250)));
    if (generation !== threadPollGeneration || view !== 'thread' || new URLSearchParams(location.hash.slice(1)).get('thread') !== threadId) return;
    if (document.hidden) continue;
    try {
      const thread = await cloud.refreshThread(threadId);
      if (generation !== threadPollGeneration || view !== 'thread' || new URLSearchParams(location.hash.slice(1)).get('thread') !== threadId) return;
      const index = state.threads.findIndex(item => item.thread_id === threadId);
      if (index < 0) return;
      state.threads[index] = thread;
      // Refresh only the received content; keep the live composer and its draft.
      const template = document.createElement('template');
      template.innerHTML = threadView();
      const messages = app.querySelector('.messages');
      const scroller = app.querySelector('.thread-scroll');
      const followLatest = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      const updated = template.content.querySelector('.messages');
      if (messages && updated && messages.innerHTML !== updated.innerHTML) messages.replaceChildren(...updated.childNodes);
      app.querySelector('.thread-delivery-status')?.remove();
      const status = template.content.querySelector('.thread-delivery-status');
      if (status) app.querySelector('.messages')?.after(status);
      if (followLatest) scroller.scrollTop = scroller.scrollHeight;
      void acknowledgeDiscussion();
      if (!activeDeliveryStatuses.has(thread.delivery_status)) return;
    } catch {
      if (attempt === 39) toast('回复状态暂时无法刷新，可以稍后重新打开讨论。');
    }
  }
}

function currentBook() { return state.books.find((book) => book.book_id === bookId); }
function currentDoc(book = currentBook()) { return state.documents.find((doc) => doc.document_id === (activeDocumentId || book?.current_document_id)); }
function currentChapter(doc = currentDoc()) { return doc?.chapters?.[chapterIndex] || (doc?.text ? { title: '全文', start: 0, end: doc.text.length } : null); }
function bookNotes(id = bookId) { return state.annotations.filter((note) => note.book_id === id); }
function noteKey(note) { return `${note.document_id}:${note.annotation_id}`; }
function findNote(key) { return state.annotations.find((note) => noteKey(note) === key); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
function navState() { return { view, bookId, activeDocumentId, chapterIndex, journalTab, filter, groupName }; }
function restoreNav(snapshot) { ({ view, bookId, activeDocumentId, chapterIndex, journalTab, filter, groupName } = snapshot); }
function navigate(nextView, patch = {}, threadId = '') {
  history.replaceState({ readingNav: navState(), readingStack: [...navigationStack] }, '', location.href);
  navigationStack.push(navState()); view = nextView;
  for (const [key, value] of Object.entries(patch)) { if (key === 'bookId') bookId = value; if (key === 'activeDocumentId') activeDocumentId = value; if (key === 'chapterIndex') chapterIndex = value; if (key === 'journalTab') journalTab = value; if (key === 'filter') filter = value; if (key === 'groupName') groupName = value; }
  history.pushState({ readingNav: navState(), readingStack: [...navigationStack] }, '', location.pathname + location.search + (threadId ? '#' + new URLSearchParams({ thread: threadId }) : ''));
}
function goBack() { if (navigationStack.length) history.back(); else location.href = shellReturn; }
window.addEventListener('popstate', () => {
  if (!history.state?.readingNav) return;
  threadPollGeneration++; menuOpen = false;
  navigationStack.splice(0, navigationStack.length, ...(history.state.readingStack || []));
  restoreNav(history.state.readingNav); render();
  const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
  if (view === 'thread' && threadId) pollThread(threadId);
});
function returnToBookTab(tab) {
  if (navigationStack.at(-1)?.view === 'journal') {
    window.addEventListener('popstate', () => { journalTab = tab; history.replaceState({readingNav:navState(),readingStack:[...navigationStack]}, '', location.href); render(); }, {once:true});
    history.back();
  } else { view = 'journal'; journalTab = tab; history.replaceState({readingNav:navState(),readingStack:[...navigationStack]}, '', location.pathname + location.search); render(); }
}

function render() {
  const previousView = app.dataset.view;
  const previousScroll = app.querySelector('.thread-scroll')?.scrollTop;
  if (view === 'shelf') app.innerHTML = shelfView(state.books, state.groups, shelfSearch, menuOpen);
  if (view === 'group') app.innerHTML = groupView(state.books, groupName);
  if (view === 'journal') app.innerHTML = journalView(currentBook(), bookNotes(), state.threads, journalTab, currentDoc());
  if (view === 'reader') app.innerHTML = readerView();
  if (view === 'notes') app.innerHTML = notesView();
  if (view === 'thread') app.innerHTML = threadView();
  if (view === 'reader') paintReader();
  app.dataset.view = view;
  syncDiscussionViewport();
  if (view === 'thread' && previousView === 'thread' && previousScroll != null) app.querySelector('.thread-scroll').scrollTop = previousScroll;
  paintUnreadBadges();
  if (cloud) { void refreshUnread(); void acknowledgeDiscussion(); }
  if (cloud) cloud.loadCovers(state, book => {
    document.querySelectorAll(`[data-cover-book="${CSS.escape(book.book_id)}"]`).forEach(image => { image.src = book.cover_data; });
  });
  if (previousView && previousView !== view) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

function paintUnreadBadges() {
  app.querySelectorAll('.book-tile[data-book], .discussion-card[data-thread]').forEach(tile => {
    tile.querySelector('.book-unread')?.remove();
    const count = (tile.dataset.thread ? unreadThreads.get(tile.dataset.thread) : unreadCounts.get(tile.dataset.book)) || 0;
    if (!count) return;
    const badge = document.createElement('span');
    badge.className = 'book-unread';
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.setAttribute('aria-label', `${count} 条未读消息`);
    tile.append(badge);
  });
}
async function refreshUnread() {
  if (!cloud || document.hidden || unreadJob) return unreadJob;
  unreadJob = cloud.unread().then(({items, threads = []}) => {
    const next = new Map(items.map(item => [item.book_id, item.count]));
    const nextThreads = new Map(threads.map(item => [item.thread_id, item.count]));
    if (JSON.stringify([...nextThreads]) !== JSON.stringify([...unreadThreads])) cloudDetailsLoaded = false;
    unreadCounts = next;
    unreadThreads = nextThreads;
    paintUnreadBadges();
  }).catch(() => { /* Keep the last confirmed count during a transient failure. */ }).finally(() => {unreadJob = null;});
  return unreadJob;
}
async function acknowledgeDiscussion() {
  if (!cloud || view !== 'thread' || document.hidden) return;
  const id = new URLSearchParams(location.hash.slice(1)).get('thread');
  const thread = state.threads.find(item => item.thread_id === id);
  const last = thread?.messages?.at(-1);
  if (!last || acknowledgedMessages.get(id) === last.message_id) return;
  try {
    await cloud.readThread(id, last.message_id);
    acknowledgedMessages.set(id, last.message_id);
    await unreadJob;
    await refreshUnread();
  } catch { /* Retry on the next visible refresh, without hiding unread messages. */ }
}
if (cloud) {
  const refresh = async () => {
    if (document.hidden) return;
    await refreshUnread();
    if (view === 'thread') pollThread(new URLSearchParams(location.hash.slice(1)).get('thread'));
  };
  setInterval(refresh, 12000);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('focus', refresh);
}

function readerView() {
  const book = currentBook();
  const doc = currentDoc(book);
  if (!book || !doc) return `<section class="empty"><h2>这本书暂时打不开</h2>${btn('返回上一层', 'back')}</section>`;
  if (doc.reading_status !== 'ready') return `<section class="reader-screen"><header class="reader-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>${esc(book.title)}</p><small>${formatLabel(doc.format)} · v${doc.version}</small></div><span class="head-spacer"></span></header><div class="format-wait"><img src="/reading-island/assets/default-cover.svg" alt="默认书籍封面"><h2>原件已保存${cloud ? '到书库' : '在此浏览器'}</h2><p>${formatLabel(doc.format)} 当前保留原件；这一版还不能保证稳定的正文顺序，所以暂不开放精准高亮和摘抄。</p><div>${doc.format === 'pdf' ? btn('查看 PDF', 'view-original', 'primary', `data-doc="${doc.document_id}"`) : ''}${btn('下载原件', 'download-original', 'secondary', `data-doc="${doc.document_id}"`)}</div></div></section>`;
  const chapter = currentChapter(doc);
  const previous = chapterIndex > 0;
  const next = chapterIndex < doc.chapters.length - 1;
  return `<section class="reader-screen"><header class="reader-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>${esc(book.title)}</p><small>${esc(chapter.title)} · v${doc.version}</small></div>${btn(icon('search'), 'reader-search', 'icon-btn', 'aria-label="搜索本章"')}</header><div class="reader-tools"><span>选中原文后，可以高亮、摘抄或发起讨论</span><span class="scope-pill">仅限 ${esc(doc.document_id.slice(0, 12))}…</span></div><div class="chapter-reading">${doc.format === 'epub' ? '' : `<h1>${esc(chapter.title)}</h1>`}<article id="reader-text" class="reader-paper" data-document="${esc(doc.document_id)}" data-chapter="${esc(chapter.chapter_id || '')}"></article><nav class="chapter-turner"><button type="button" data-action="previous-chapter" ${previous ? '' : 'disabled'}>‹ 上一章</button><button type="button" data-action="journal-original">章节目录</button><button type="button" data-action="next-chapter" ${next ? '' : 'disabled'}>下一章 ›</button></nav></div><div id="selection-bar" class="selection-bar hidden"><button data-action="annotate-selection">高亮并摘抄</button><button data-action="discuss-selection">讨论这段</button></div></section>`;
}

function notesView() {
  const notes = state.annotations.filter((note) => {
    const thread = state.threads.find((item) => item.thread_id === note.thread_id);
    if (filter === 'open') return note.purpose !== 'discussion' && thread?.status === 'open';
    return note.purpose !== 'discussion';
  });
  const standaloneThreads = filter === 'excerpt' ? [] : state.threads.filter((thread) => (!thread.annotation_id || state.annotations.find(n => n.annotation_id === thread.annotation_id)?.purpose === 'discussion') && (filter !== 'open' || thread.status === 'open'));
  const cards = [...notes.map((note) => globalNoteCard(note, filter !== 'excerpt')), ...standaloneThreads.map(globalThreadCard)];
  return `<section class="notes-screen"><header class="simple-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>共读札记</p><small>${state.annotations.length} 条标注 · ${state.threads.filter((t) => t.status === 'open').length} 个未结束讨论</small></div></header><nav class="filter-tabs">${['all:全部', 'excerpt:摘抄', 'open:未结束讨论'].map((item) => { const [key, label] = item.split(':'); return `<button class="${filter === key ? 'active' : ''}" data-action="filter" data-value="${key}">${label}</button>`; }).join('')}</nav><div class="notes-stack">${cards.length ? cards.join('') : '<p class="empty-copy">这里还没有内容。</p>'}</div></section>`;
}

function globalNoteCard(note, showDiscussion = true) {
  const book = state.books.find((item) => item.book_id === note.book_id);
  const thread = state.threads.find((item) => item.thread_id === note.thread_id);
  const resolved = resolveAnnotation(note, state.documents.find((doc) => doc.document_id === note.document_id));
  return `<article class="quote-card paper-card"><button class="card-main" data-action="note-detail" data-note="${noteKey(note)}"><blockquote>${esc(resolved.exact)}</blockquote>${note.insight ? `<p class="insight">${esc(note.insight)}</p>` : ''}</button><footer><span>${esc(book?.title || '未知书籍')} · v${note.document_version}</span><span>${showDiscussion && thread ? `${thread.messages.length} 条回复` : '仅摘抄'}</span></footer><div class="card-actions">${btn(icon('share'), 'share-note', 'tiny-btn', `data-note="${noteKey(note)}"`)}${showDiscussion && thread ? btn('继续讨论', 'open-thread', 'text-btn', `data-thread="${thread.thread_id}"`) : ''}</div></article>`;
}

function globalThreadCard(thread) {
  const book = state.books.find((item) => item.book_id === thread.book_id);
  const note = state.annotations.find(n => n.annotation_id === thread.annotation_id);
  const opening = thread.messages?.[0]?.text || '';
  return `<article class="discussion-card global-discussion" data-action="open-thread" data-thread="${thread.thread_id}" role="button" tabindex="0"><header><span>${thread.status === 'open' ? '讨论中' : '已结束'}</span><small>${esc((thread.created_at || '').slice(0, 10))}</small></header><h2>${esc(thread.topic || '围绕整本书')}</h2><p class="book-topic-context">${note ? '原文讨论' : '全书议题'} · 《${esc(book?.title || '未知书籍')}》</p>${note ? `<blockquote>${esc(note.anchor.exact)}</blockquote>` : ''}${opening ? `<div class="discussion-opening markdown-body"><span>${thread.messages?.[0]?.author === 'assistant' ? 'AI的开场：' : '我的开场：'}</span>${renderMarkdown(opening)}</div>` : ''}<footer><span>${note ? '原文讨论' : '全书议题'}</span><span>${thread.messages?.length || 0} 条回复</span></footer></article>`;
}

function threadView() {
  const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
  const thread = state.threads.find((item) => item.thread_id === threadId);
  const note = state.annotations.find((item) => item.thread_id === threadId);
  if (!thread) return `<section class="empty"><h2>没有找到讨论</h2>${btn('返回上一层', 'back')}</section>`;
  const book = state.books.find((item) => item.book_id === (thread.book_id || note?.book_id));
  const anchor = note ? `<small>原文 · ${esc(note.document_id.slice(0, 12))}… · v${note.document_version}</small><blockquote>${esc(note.anchor.exact)}</blockquote>${note.insight ? `<p>${esc(note.insight)}</p>` : ''}${btn('在原文查看','open-note','text-btn',`data-note="${noteKey(note)}"`)}` : `<small>全书议题</small><p>围绕《${esc(book?.title || '这本书')}》展开，不绑定某一段摘录。</p>`;
  const delivery = activeDeliveryStatuses.has(thread.delivery_status)
    ? '<p class="thread-delivery-status" role="status">AI正在读……</p>'
    : ['failed', 'interrupted', 'unavailable'].includes(thread.delivery_status) && thread.latest_turn_id
      ? `<p class="thread-delivery-status">这次回复暂时没有送达。${btn('重试', 'retry-turn', 'text-btn', `data-thread="${thread.thread_id}" data-turn="${thread.latest_turn_id}"`)}</p>`
      : '';
  return `<section class="thread-screen"><header class="simple-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>${esc(thread.topic || (note ? '附在原文上的讨论' : '全书讨论'))}</p><small>${esc(book?.title || '')}</small></div>${btn(thread.status === 'open' ? '结束' : '重开', 'toggle-thread', 'text-btn', `data-thread="${thread.thread_id}"`)}</header><div class="thread-scroll"><article class="thread-anchor">${anchor}</article><div class="messages">${groupDiscussionMessages(thread.messages).map((group) => `<article class="message ${group.author === 'me' ? 'mine' : 'assistant'}"><b>${group.author === 'me' ? '我' : esc(readingConfig.aiName)}</b>${group.parts.map(message => `${message.quote ? `<blockquote class="message-quote">${esc(message.quote.text)}</blockquote>` : ''}<div class="markdown-body">${renderMarkdown(message.text)}</div>`).join('')}</article>`).join('')}</div>${delivery}</div>${thread.status === 'open' ? '<form id="reply-form" class="reply-box"><textarea id="reply-text" required placeholder="继续说说你的想法……"></textarea><button class="primary">回复</button></form>' : '<p class="empty-copy">讨论已结束，可以从右上角重新打开。</p>'}</section>`;
}

function paintReader() {
  const target = $('#reader-text');
  const doc = currentDoc();
  const chapter = currentChapter(doc);
  if (!target || !doc?.text || !chapter) return;
  target.classList.toggle('ebook-reflow', doc.format === 'epub');
  const notes = bookNotes().filter((note) => note.document_id === doc.document_id).map((note) => ({ note, resolved: resolveAnnotation(note, doc) })).filter((item) => item.resolved.found && item.resolved.end > chapter.start && item.resolved.start < chapter.end).sort((a, b) => a.resolved.start - b.resolved.start);
  const parts = [];
  const raw = doc.text.slice(chapter.start, chapter.end);
  let offset = chapter.start;
  for (const block of raw.match(/[\s\S]+?(?:\n[ \t]*\n+|$)/g) || []) {
    const start = offset, end = start + block.length;
    const isHeading = block.trim().replace(/\s+/g, ' ').toLowerCase() === chapter.title.trim().toLowerCase();
    const element = document.createElement(doc.format === 'epub' ? (isHeading ? 'h2' : 'p') : 'span');
    const boundaries = [...new Set([start,end,...notes.flatMap(({resolved})=>[Math.max(start,Math.min(end,resolved.start)),Math.max(start,Math.min(end,resolved.end))])])].sort((a,b)=>a-b);
    for(let i=0;i<boundaries.length-1;i++) {
      const left=boundaries[i],right=boundaries[i+1];
      const covering=notes.filter(({resolved})=>resolved.start<right && resolved.end>left);
      if(!covering.length) { element.append(document.createTextNode(doc.text.slice(left,right))); continue; }
      const mark=document.createElement('mark');
      mark.dataset.note=noteKey(covering[0].note);
      mark.dataset.notes=covering.map(({note})=>noteKey(note)).join(' ');
      mark.className=covering.some(({note})=>note.purpose==='discussion') ? 'discussion-mark' : 'excerpt-mark';
      mark.title=covering.some(({note})=>note.purpose==='discussion') ? '此处有讨论' : '此处有摘录';
      mark.textContent=doc.text.slice(left,right); element.append(mark);
    }
    parts.push(element); offset = end;
  }
  target.replaceChildren(...parts);
  if (readerSearch) highlightSearch(target, readerSearch);
}

function highlightSearch(root, query) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (walker.currentNode.parentElement?.tagName !== 'MARK') nodes.push(walker.currentNode);
  for (const node of nodes) {
    const index = node.data.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) continue;
    const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + query.length);
    const span = document.createElement('span'); span.className = 'search-hit'; range.surroundContents(span);
  }
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-close]')) { sheet.close(); return; }
  if (menuOpen && !event.target.closest('.shelf-menu-wrap')) { menuOpen = false; render(); return; }
  const marked = event.target.closest('mark[data-note]');
  if (marked && !window.getSelection()?.toString()) { const note=findNote(marked.dataset.note); if(note?.thread_id) openThread(note.thread_id); else if(note) modal('完整摘录', `<blockquote>${esc(note.anchor.exact)}</blockquote><p>${esc(note.insight || '')}</p>`,''); return; }
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;
  if (cloud && !['back','toggle-menu','open-group'].includes(action)) {
    control.setAttribute('aria-busy', 'true');
    try { await ensureLibraryDetails(); } catch (error) { toast(error.message); return; }
    finally { control.removeAttribute('aria-busy'); }
  }
  if (cloud && ['open-note', 'open-chapter', 'chapter-settings'].includes(action)) {
    const targetBook = action === 'open-book' ? control.dataset.book : action === 'open-note' ? findNote(control.dataset.note)?.book_id : bookId;
    try { await cloud.ensureBook(state, targetBook); } catch (error) { toast(error.message); return; }
  }
  if (action === 'note-detail') { const note=findNote(control.dataset.note); if(note) modal('完整摘录', `<blockquote class="full-excerpt">${esc(note.anchor.exact)}</blockquote><p>${esc(note.insight || '')}</p>${btn('在原文查看','open-note','secondary',`data-note="${noteKey(note)}"`)}`,''); return; }
  if (action === 'back') { goBack(); return; }
  if (action === 'toggle-date' || action === 'date-month' || action === 'date-pick') {
    const field = control.closest('.date-field'), popup = field.querySelector('.date-popup'), input = field.querySelector('input');
    if (action === 'date-pick') {
      input.value = control.dataset.value || '';
      field.querySelector('[data-date-label]').textContent = input.value || '未设置';
      popup.hidePopover(); return;
    }
    if (action === 'toggle-date' && popup.matches(':popover-open')) { popup.hidePopover(); return; }
    const base = action === 'date-month' ? popup.dataset.month : input.value || localDate(new Date());
    const [year, month] = base.split('-').map(Number);
    const date = new Date(year, month - 1 + Number(control.dataset.step || 0), 1);
    popup.dataset.month = localDate(date).slice(0, 7);
    const prefix = popup.dataset.month, offset = (date.getDay() + 6) % 7, days = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    popup.innerHTML = `<div class="calendar-head"><button type="button" data-action="date-month" data-step="-1" aria-label="上个月">‹</button><strong>${date.getFullYear()}年${date.getMonth()+1}月</strong><button type="button" data-action="date-month" data-step="1" aria-label="下个月">›</button></div><div class="calendar-grid">${['一','二','三','四','五','六','日'].map(day=>`<span>${day}</span>`).join('')}${'<span></span>'.repeat(offset)}${Array.from({length:days},(_,i)=>{const value=prefix+'-'+String(i+1).padStart(2,'0');return `<button type="button" data-action="date-pick" data-value="${value}" aria-label="${value}" aria-pressed="${value===input.value}">${i+1}</button>`;}).join('')}</div><div class="calendar-footer"><button type="button" data-action="date-pick" data-value="">清除</button><button type="button" data-action="date-pick" data-value="${localDate(new Date())}">今天</button></div>`;
    if (!popup.matches(':popover-open')) popup.showPopover();
    const rect = field.querySelector('.date-trigger').getBoundingClientRect(), width = Math.min(300, innerWidth - 24);
    popup.style.width = `${width}px`; popup.style.left = `${Math.max(12, Math.min(rect.left, innerWidth-width-12))}px`;
    popup.style.top = `${Math.max(12, Math.min(rect.bottom+6, innerHeight-popup.getBoundingClientRect().height-12))}px`;
    return;
  }
  if (action === 'toggle-select') {
    const select = control.closest('.pretty-select'); const menu = $('.pretty-select-menu', select); const opening = !menu.matches(':popover-open');
    document.querySelectorAll('.pretty-select-menu:popover-open').forEach((item) => item.hidePopover());
    document.querySelectorAll('.pretty-select-trigger').forEach((item) => item.setAttribute('aria-expanded', 'false'));
    if (opening) {
      const rect = control.getBoundingClientRect();
      menu.style.width = `${Math.min(rect.width, innerWidth - 24)}px`;
      menu.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - rect.width - 12))}px`;
      menu.showPopover();
      const height = Math.min(menu.scrollHeight, 240);
      menu.style.top = `${Math.max(12, rect.bottom + height + 8 < innerHeight ? rect.bottom + 6 : rect.top - height - 6)}px`;
    }
    control.setAttribute('aria-expanded', String(opening)); return;
  }
  if (action === 'select-option') {
    const select = control.closest('.pretty-select'); $('input[type="hidden"]', select).value = control.dataset.value || ''; $('[data-select-label]', select).textContent = control.dataset.label || control.textContent.trim();
    select.querySelectorAll('[role="option"]').forEach((item) => item.setAttribute('aria-selected', String(item === control)));
    $('.pretty-select-menu', select).hidePopover(); $('.pretty-select-trigger', select).setAttribute('aria-expanded', 'false'); return;
  }
  if (action === 'toggle-menu') { menuOpen = !menuOpen; render(); return; }
  if (action === 'journal-original') { returnToBookTab('original'); return; }
  if (action === 'journal-tab') { journalTab = control.dataset.value || 'excerpt'; if (journalTab === 'original') { activeDocumentId = currentBook().current_document_id; chapterIndex = 0; } render(); }
  if (action === 'open-group') { menuOpen = false; navigate('group', { groupName: control.dataset.group || '堆放' }); render(); return; }
  if (action === 'open-book') { if (suppressBookClick) { suppressBookClick = false; return; } const book = state.books.find((item) => item.book_id === control.dataset.book); navigate('journal', { bookId: book.book_id, activeDocumentId: book.current_document_id, chapterIndex: 0, journalTab: 'original' }); render(); return; }
  if (action === 'open-chapter') { navigate('reader', { chapterIndex: Number(control.dataset.index) || 0 }); render(); visitChapter(); return; }
  if (action === 'previous-chapter' && chapterIndex > 0) { chapterIndex -= 1; selection = null; render(); visitChapter(); }
  if (action === 'next-chapter' && chapterIndex < (currentDoc()?.chapters?.length || 1) - 1) { chapterIndex += 1; selection = null; render(); visitChapter(); }
  if (action === 'all-notes') { menuOpen = false; navigate('notes', { filter: 'all' }); render(); }
  if (action === 'filter') { filter = control.dataset.value; render(); }
  if (action === 'add-book') uploadBook();
  if (action === 'create-group') createGroup();
  if (action === 'manage-groups') manageGroups();
  if (action === 'delete-group') { try { await deleteGroup(control.dataset.group); } catch (error) { toast(error.message); } }
  if (action === 'edit-book') editBook();
  if (action === 'start-discussion') startDiscussion();
  if (action === 'chapter-settings') editChapters();
  if (action === 'add-chapter-row') addChapterRow();
  if (action === 'remove-chapter-row') control.closest('.chapter-editor-row')?.remove();
  if (action === 'auto-chapters') await autoDetectChapters();
  if (action === 'replace-book') replaceBook();
  if (action === 'book-files') showBookFiles();
  if (action === 'download-original') { try { await downloadOriginal(control.dataset.doc); } catch (error) { toast(error.message); } }
  if (action === 'view-original') { try { await viewOriginal(control.dataset.doc); } catch (error) { toast(error.message); } }
  if (action === 'reader-search') searchReader();
  if (action === 'annotate-selection') annotateSelection(false);
  if (action === 'discuss-selection') annotateSelection(true);
  if (action === 'open-note') openNote(control.dataset.note);
  if (action === 'open-thread') openThread(control.dataset.thread);
  if (action === 'toggle-thread') { try { await toggleThread(control.dataset.thread); } catch (error) { toast(error.message); } }
  if (action === 'retry-turn' && cloud) {
    control.disabled = true;
    try {
      const refreshed = await cloud.retryTurn(control.dataset.thread, control.dataset.turn);
      const index = state.threads.findIndex(item => item.thread_id === refreshed.thread_id);
      if (index >= 0) state.threads[index] = refreshed;
      render();
      pollThread(refreshed.thread_id);
    } catch (error) { toast(error.message || '暂时无法重试，请稍后再试。'); }
  }
  if (action === 'share-note') openShare(control.dataset.note);
  if (action === 'paper-style') { share.style = control.dataset.value; share.page = 0; await renderShare(); }
  if (action === 'paper-prev') { share.page = Math.max(0, share.page - 1); await renderShare(); }
  if (action === 'paper-next') { share.page = Math.min(share.pages - 1, share.page + 1); await renderShare(); }
  if (action === 'save-note-image') saveShareImage();
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'shelf-search') { shelfSearch = event.target.value; render(); requestAnimationFrame(() => { const input = $('#shelf-search'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }); }
});

document.addEventListener('change', (event) => {
  if (!event.target.matches('.document-file-input')) return;
  const file = event.target.files?.[0];
  const label = document.querySelector(`[data-file-label-for="${CSS.escape(event.target.id)}"]`);
  if (label) label.textContent = file?.name || '选择文件';
});

function finishBookDrag() {
  if (bookDrag?.timer) clearTimeout(bookDrag.timer);
  document.querySelectorAll('.book-tile.classifying').forEach((item) => item.classList.remove('classifying'));
  document.querySelectorAll('.shelf-section.drop-ready, .shelf-section.drop-target').forEach((item) => item.classList.remove('drop-ready', 'drop-target'));
  document.querySelector('.organize-hint')?.remove();
  document.querySelector('.book-drag-ghost')?.remove();
  bookDrag = null;
}

document.addEventListener('pointerdown', (event) => {
  if (view !== 'shelf' || event.button > 0) return;
  const tile = event.target.closest('.book-tile');
  if (!tile) return;
  bookDrag = { pointerId: event.pointerId, bookId: tile.dataset.book, startX: event.clientX, startY: event.clientY, active: false, target: null, ghost: null };
  bookDrag.timer = setTimeout(() => {
    if (!bookDrag || bookDrag.pointerId !== event.pointerId) return;
    bookDrag.active = true;
    suppressBookClick = true;
    tile.classList.add('classifying');
    const bounds = tile.getBoundingClientRect();
    const ghost = tile.cloneNode(true); ghost.classList.remove('classifying'); ghost.classList.add('book-drag-ghost'); ghost.removeAttribute('data-action'); ghost.style.width = `${bounds.width}px`; ghost.style.left = `${event.clientX}px`; ghost.style.top = `${event.clientY}px`; document.body.append(ghost); bookDrag.ghost = ghost;
    document.querySelectorAll('.shelf-section').forEach((section) => section.classList.add('drop-ready'));
    const hint = document.createElement('div'); hint.className = 'organize-hint'; hint.textContent = '拖到分组区域即可移动'; document.body.append(hint);
    navigator.vibrate?.(18);
  }, 520);
}, { passive: true });

document.addEventListener('pointermove', (event) => {
  if (!bookDrag || event.pointerId !== bookDrag.pointerId) return;
  if (!bookDrag.active && Math.hypot(event.clientX - bookDrag.startX, event.clientY - bookDrag.startY) > 10) { clearTimeout(bookDrag.timer); bookDrag = null; return; }
  if (!bookDrag.active) return;
  event.preventDefault();
  if (bookDrag.ghost) { bookDrag.ghost.style.left = `${event.clientX}px`; bookDrag.ghost.style.top = `${event.clientY}px`; }
  document.querySelectorAll('.shelf-section.drop-target').forEach((section) => section.classList.remove('drop-target'));
  const section = document.elementFromPoint(event.clientX, event.clientY)?.closest('.shelf-section');
  if (section) section.classList.add('drop-target');
  bookDrag.target = section?.dataset.group || null;
}, { passive: false });

document.addEventListener('pointerup', async (event) => {
  if (!bookDrag || event.pointerId !== bookDrag.pointerId) return;
  const { active, target, bookId: draggedBookId } = bookDrag;
  finishBookDrag();
  if (!active) return;
  if (target) {
    const next = structuredClone(state);
    const book = next.books.find((item) => item.book_id === draggedBookId);
    if (book && book.category !== target) { book.category = target; await commit(next); toast(`已移到“${target}”`); }
  }
  setTimeout(() => { suppressBookClick = false; }, 450);
});

document.addEventListener('pointercancel', () => { const wasActive = bookDrag?.active; finishBookDrag(); if (wasActive) setTimeout(() => { suppressBookClick = false; }, 450); });

document.addEventListener('selectionchange', () => {
  if (view !== 'reader') return;
  const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
  const root = $('#reader-text');
  if (!range || range.collapsed || !root?.contains(range.commonAncestorContainer)) { $('#selection-bar')?.classList.add('hidden'); return; }
  const pre = document.createRange(); pre.selectNodeContents(root); pre.setEnd(range.startContainer, range.startOffset);
  const start = (currentChapter()?.start || 0) + pre.toString().length;
  selection = { start, end: start + range.toString().length, exact: range.toString() };
  $('#selection-bar')?.classList.remove('hidden');
});

$('#sheet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!sheet.dataset.mode) return;
  if (event.currentTarget.dataset.saving) return;
  const form = event.currentTarget;
  form.dataset.saving = 'true';
  const submit = form.querySelector('[type="submit"]');
  if (submit) submit.disabled = true;
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    let saved = true;
    if (sheet.dataset.mode === 'annotation') saved = await saveAnnotation(values);
    if (sheet.dataset.mode === 'discussion') saved = await saveDiscussion(values);
    if (sheet.dataset.mode === 'upload') saved = await saveUpload(values, false);
    if (sheet.dataset.mode === 'replace') saved = await saveUpload(values, true);
    if (sheet.dataset.mode === 'edit-book') saved = await saveBookMeta(values);
    if (sheet.dataset.mode === 'chapter-settings') saved = await saveChapterSettings();
    if (sheet.dataset.mode === 'create-group') saved = await saveGroup(values);
    if (saved !== false) sheet.close();
  } catch (error) { toast(error.message || '保存失败，请重试'); }
  finally { delete form.dataset.saving; if (submit) submit.disabled = false; }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'reply-form') return;
  event.preventDefault();
  const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
  const next = structuredClone(state);
  next.threads.find((item) => item.thread_id === threadId).messages.push(createThreadMessage('me', $('#reply-text').value.trim()));
  try { await commit(next); const scroll = app.querySelector('.thread-scroll'); if (scroll) scroll.scrollTop = scroll.scrollHeight; pollThread(threadId); } catch (error) { toast(error.message || '消息暂时无法发送，请稍后重试。'); }
});

function modal(title, body, mode = '') {
  sheet.dataset.operationId = crypto.randomUUID();
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = body;
  $('#sheet-body').scrollTop = 0;
  document.querySelectorAll('.pretty-select-menu').forEach((menu) => menu.addEventListener('toggle', () => {
    menu.closest('.pretty-select').querySelector('.pretty-select-trigger').setAttribute('aria-expanded', String(menu.matches(':popover-open')));
  }));
  $('#sheet-actions').innerHTML = mode ? '<button type="button" data-close>取消</button><button class="primary" type="submit">保存</button>' : '<button type="button" data-close>关闭</button>';
  sheet.dataset.mode = mode;
  sheet.showModal();
  $('[data-close]', sheet)?.addEventListener('click', () => sheet.close(), { once: true });
}

function localDate(date) { return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'); }
function customSelect(name, options, selected = '') {
  const current = options.find((option) => option.value === selected) || options[0];
  return `<div class="pretty-select"><input type="hidden" name="${esc(name)}" value="${esc(current?.value || '')}"><button type="button" class="pretty-select-trigger" data-action="toggle-select" aria-haspopup="listbox" aria-expanded="false"><span data-select-label>${esc(current?.label || '')}</span><b>⌄</b></button><div class="pretty-select-menu" popover="auto" role="listbox">${options.map((option) => `<button type="button" role="option" data-action="select-option" data-value="${esc(option.value)}" data-label="${esc(option.label)}" aria-selected="${option.value === current?.value}">${esc(option.label)}</button>`).join('')}</div></div>`;
}
function documentFileField(id, label) {
  return `<div class="document-file-field"><span>${esc(label)}</span><label class="document-file-button" for="${esc(id)}"><span data-file-label-for="${esc(id)}">选择文件</span></label><input class="document-file-input" id="${esc(id)}" name="file" type="file" accept="${FORMAT_ACCEPT}" required></div>`;
}
function groupSelect(selected = '堆放') { return customSelect('category', state.groups.map((group) => ({ value: group, label: group })), selected); }
function closeShelfMenu() { if (menuOpen) { menuOpen = false; render(); } }

function uploadBook() {
  closeShelfMenu();
  modal('添加一本书', `${documentFileField('new-book-file', '电子文档')}<div class="format-support"><b>可精准摘抄</b><span>TXT · Markdown · DOCX · EPUB · HTML</span><b>先保存原件</b><span>PDF · DOC · MOBI · AZW · AZW3</span></div><label>书名<input name="title" placeholder="默认使用文件名"></label><label>作者<input name="author"></label><div class="field-group"><span>分组</span>${groupSelect()}</div><label>出版社<input name="publisher"></label><p class="field-note">文件最多 25 MB，${cloud ? '保存到云端书库。' : '只保存在此浏览器。'}无加密 DOCX/EPUB 会生成冻结阅读文本；无法可靠解析的格式仍可查看和下载原件。</p>`, 'upload');
}

function replaceBook() { modal('新增文档版本', `${documentFileField('replacement-book-file', '新的电子书文件')}<p class="field-note">旧文档和旧标注仍保留；新文件生成新的 document_id 和版本。</p>`, 'replace'); }

function editBook() {
  const book = currentBook();
  modal('编辑书籍资料', `<div class="cover-editor"><div class="cover-preview"><img src="${esc(book.cover_data || '/reading-island/assets/default-cover.svg')}" alt="当前封面"><span>${esc(book.title)}</span></div><label class="cover-upload"><span>上传封面</span><span class="cover-file-button">选择封面</span><input id="cover-file" name="cover" type="file" accept="image/png,image/jpeg,image/webp"></label></div><div class="book-edit-fields"><label class="settings-row"><span>书名</span><input name="title" required value="${esc(book.title)}" placeholder="请输入书名"></label><label class="settings-row"><span>作者</span><input name="author" value="${esc(book.author || '')}" placeholder="请输入作者"></label><label class="settings-row"><span>出版社</span><input name="publisher" value="${esc(book.publisher || '')}" placeholder="请输入出版社"></label><div class="settings-row"><span>分组</span>${groupSelect(book.category)}</div><div class="settings-row"><span>阅读状态</span>${customSelect('reading_status', [{ value: '', label: '未读（默认）' }, { value: 'reading', label: '阅读中' }, { value: 'finished', label: '已阅' }], book.reading_status || '')}</div><div class="settings-row"><span>开始阅读时间</span><div class="date-field"><input type="hidden" name="reading_started_at" value="${esc(book.reading_started_at || '')}"><button type="button" class="date-trigger" data-action="toggle-date" aria-label="开始阅读时间"><span data-date-label>${esc(book.reading_started_at || '未设置')}</span><span>▦</span></button><div class="date-popup" popover="auto" role="dialog" aria-label="开始阅读时间日历"></div></div></div><div class="settings-row"><span>结束阅读时间</span><div class="date-field"><input type="hidden" name="reading_finished_at" value="${esc(book.reading_finished_at || '')}"><button type="button" class="date-trigger" data-action="toggle-date" aria-label="结束阅读时间"><span data-date-label>${esc(book.reading_finished_at || '未设置')}</span><span>▦</span></button><div class="date-popup" popover="auto" role="dialog" aria-label="结束阅读时间日历"></div></div></div></div>`, 'edit-book');
  $('#cover-file').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; const url = URL.createObjectURL(file); $('.cover-preview img').src = url; sheet.addEventListener('close', () => URL.revokeObjectURL(url), { once: true }); });
}

function startDiscussion() {
  const available = bookNotes().filter((note) => !note.thread_id);
  const quoteOptions = [{ value: '', label: '无（围绕整本书）' }, ...available.map((note) => ({ value: note.annotation_id, label: `${note.anchor.exact.replace(/\s+/g, ' ').slice(0, 48)}${note.anchor.exact.length > 48 ? '…' : ''}` }))];
  modal('发起讨论议题', `<div class="field-group"><span>围绕哪段摘录</span>${customSelect('annotation_id', quoteOptions, '')}</div><label>议题<input name="topic" maxlength="80" required placeholder="例如：我们为什么总想尽快知道结尾？"></label><label>我的开场<textarea name="opening" required placeholder="先写下你的问题、判断或感受……"></textarea></label><p class="field-note">选择摘录时会固定携带文档版本和准确原文；选择“无”时，这是一张只归属于当前书籍的议题卡。</p>`, 'discussion');
}

async function saveDiscussion(values) {
  const next = structuredClone(state);
  const note = values.annotation_id ? next.annotations.find((item) => item.annotation_id === values.annotation_id && item.book_id === bookId) : null;
  if (values.annotation_id && (!note || note.thread_id)) throw new Error('这段摘录已经有讨论，或不属于当前书籍。');
  const thread = { thread_id: `thread_${sheet.dataset.operationId}`, book_id: bookId, annotation_id: note?.annotation_id || '', document_id: note?.document_id || currentDoc()?.document_id || '', status: 'open', topic: values.topic.trim(), created_at: new Date().toISOString(), messages: [createThreadMessage('me', values.opening.trim())] };
  if (note) note.thread_id = thread.thread_id;
  next.threads.push(thread);
  journalTab = 'discussion';
  await commit(next);
  pollThread(thread.thread_id);
  return true;
}

function chapterEditorRow(chapter) {
  return `<div class="chapter-editor-row" data-chapter-id="${esc(chapter.chapter_id || '')}"><label>章节名<input class="chapter-title-input" value="${esc(chapter.title)}" maxlength="100" required></label><label>起始位置<input class="chapter-start-input" type="number" min="0" value="${chapter.start}" required></label>${btn('移除', 'remove-chapter-row', 'text-btn')}</div>`;
}

function editChapters() {
  const doc = currentDoc();
  if (!doc || doc.reading_status !== 'ready') return;
  modal('设置章节', `<p class="field-note chapter-note">章节位置按冻结原文的字符位置计算；调整章节不会移动摘录和讨论。</p><div id="chapter-editor">${doc.chapters.map(chapterEditorRow).join('')}</div><div class="chapter-editor-tools">${btn(`${icon('add')} 添加章节`, 'add-chapter-row', 'secondary')}${btn('重新自动识别', 'auto-chapters', 'secondary')}</div>`, 'chapter-settings');
}

function addChapterRow() {
  const editor = $('#chapter-editor');
  const doc = currentDoc();
  if (!editor || !doc) return;
  const starts = [...editor.querySelectorAll('.chapter-start-input')].map((input) => Number(input.value)).filter(Number.isFinite);
  const start = Math.min(doc.text.length - 1, Math.max(0, (starts.at(-1) || 0) + 1));
  editor.insertAdjacentHTML('beforeend', chapterEditorRow({ title: '新章节', start }));
  editor.lastElementChild.querySelector('.chapter-title-input').select();
}

async function autoDetectChapters() {
  const doc = currentDoc();
  if (!doc) return;
  const ranges = detectChapterRanges(doc.text);
  const next = structuredClone(state);
  const target = next.documents.find((item) => item.document_id === doc.document_id);
  target.chapters = ranges.map((chapter, index) => ({ ...chapter, chapter_id: `chapter_${crypto.randomUUID()}`, order: index }));
  chapterIndex = 0;
  await commit(next);
  sheet.close();
  toast(`已识别 ${ranges.length} 个章节`);
}

async function saveChapterSettings() {
  const doc = currentDoc();
  const rows = [...document.querySelectorAll('#chapter-editor .chapter-editor-row')].map((row) => ({ chapter_id: row.dataset.chapterId, title: $('.chapter-title-input', row).value, start: Number($('.chapter-start-input', row).value) }));
  const ranges = normalizeChapterRanges(doc.text, rows);
  const idsByStart = new Map(rows.map((row) => [row.start, row.chapter_id]));
  const next = structuredClone(state);
  const target = next.documents.find((item) => item.document_id === doc.document_id);
  target.chapters = ranges.map((chapter, index) => ({ ...chapter, chapter_id: idsByStart.get(chapter.start) || `chapter_${crypto.randomUUID()}`, order: index }));
  chapterIndex = Math.min(chapterIndex, target.chapters.length - 1);
  await commit(next);
  return true;
}

function createGroup() { closeShelfMenu(); if (sheet.open) sheet.close(); modal('新建分组', '<label>分组名称<input name="group" maxlength="24" required placeholder="例如：小说、诗歌、共同在读"></label>', 'create-group'); }

function manageGroups() {
  closeShelfMenu();
  modal('管理分组', `<div class="group-manager">${state.groups.map((group) => `<article><span>${esc(group)}</span>${group === '堆放' ? '<small>默认分组</small>' : btn('删除', 'delete-group', 'text-btn', `data-group="${esc(group)}"`)}</article>`).join('')}</div>${btn(`${icon('add')} 新建分组`, 'create-group', 'secondary')}`, '');
}

async function saveGroup(values) {
  const name = values.group.trim();
  if (!name || state.groups.includes(name)) { toast(name ? '已经有这个分组了' : '请填写分组名称'); return false; }
  const next = structuredClone(state); next.groups.push(name); await commit(next); return true;
}

async function deleteGroup(group) {
  if (!group || group === '堆放') return;
  const next = structuredClone(state); next.groups = next.groups.filter((item) => item !== group); next.books.forEach((book) => { if (book.category === group) book.category = '堆放'; }); await commit(next); sheet.close(); manageGroups();
}

async function saveBookMeta(values) {
  if (values.reading_started_at && values.reading_finished_at && values.reading_finished_at < values.reading_started_at) throw new Error('结束阅读时间不能早于开始阅读时间。');
  const next = structuredClone(state);
  const book = next.books.find((item) => item.book_id === bookId);
  Object.assign(book, { title: values.title.trim(), author: values.author.trim(), category: values.category.trim() || '堆放', publisher: values.publisher.trim(), reading_status: values.reading_status || '', reading_started_at: values.reading_started_at || '', reading_finished_at: values.reading_finished_at || '' });
  const coverFile = $('#cover-file')?.files[0];
  if (coverFile) book.cover_data = await normalizeCover(coverFile);
  await commit(next);
}

async function normalizeCover(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) throw new Error('封面请使用 8 MB 以内的 PNG、JPEG 或 WebP。');
  const bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : await loadCoverImage(file);
  const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1080;
  const context = canvas.getContext('2d');
  const sourceWidth = bitmap.width || bitmap.naturalWidth; const sourceHeight = bitmap.height || bitmap.naturalHeight;
  const scale = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const width = sourceWidth * scale; const height = sourceHeight * scale;
  context.fillStyle = '#f4edde'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .88));
  return await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

function loadCoverImage(file) {
  return new Promise((resolve, reject) => { const url = URL.createObjectURL(file); const image = new Image(); image.onload = () => { URL.revokeObjectURL(url); resolve(image); }; image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取这张封面图片。')); }; image.src = url; });
}

async function saveUpload(values, replacing) {
  const file = $('#sheet-body input[type=file]').files[0];
  const title = values.title?.trim() || file.name.replace(/\.(txt|md|markdown|html?|docx?|pdf|epub|mobi|azw3?)$/i, '');
  try {
    if (replacing) {
      const book = currentBook();
      const doc = await makeDocument(file, book.book_id, (currentDoc(book)?.version || 0) + 1);
      doc.document_id = `doc_${sheet.dataset.operationId}`;
      const next = structuredClone(state); next.documents.push(doc); next.books.find((item) => item.book_id === book.book_id).current_document_id = doc.document_id; activeDocumentId = doc.document_id; chapterIndex = 0; await commit(next);
    } else {
      const doc = await makeDocument(file, `book_${sheet.dataset.operationId}`);
      doc.document_id = `doc_${sheet.dataset.operationId}`;
      const book = createBook(doc, title); Object.assign(book, { author: values.author?.trim(), category: values.category?.trim() || '堆放', publisher: values.publisher?.trim() });
      const next = structuredClone(state); next.documents.push(doc); next.books.push(book); await commit(next); navigate('journal', { bookId: book.book_id, activeDocumentId: doc.document_id, chapterIndex: 0, journalTab: 'original' }); render();
    }
    return true;
  } catch (error) { toast(error.message); return false; }
}

function searchReader() { const query = prompt('在本章原文中查找：', readerSearch); if (query === null) return; readerSearch = query.trim(); render(); }

function annotateSelection(discuss) {
  if (!selection?.exact.trim()) return toast('请先选中一段原文');
  modal(discuss ? '围绕这段原文讨论' : '摘抄与见解', `<div class="selection-preview">${esc(selection.exact)}</div>${discuss ? '<label>议题<input name="topic" maxlength="80" required placeholder="想和AI讨论什么？"></label>' : ''}<label>${discuss ? '我的开场' : '我的见解'}<textarea name="insight" placeholder="这段文字让我想到……" required></textarea></label><input type="hidden" name="discuss" value="${discuss ? 'yes' : 'no'}">`, 'annotation');
}

async function saveAnnotation(values) {
  const doc = currentDoc();
  const next = structuredClone(state);
  const note = createAnnotation(bookId, doc, makeAnchor(doc.text, selection.start, selection.end), values.insight.trim()); note.annotation_id = `note_${sheet.dataset.operationId}`; note.purpose = values.discuss === 'yes' ? 'discussion' : 'excerpt'; next.annotations.push(note);
  if (values.discuss === 'yes') { const thread = { thread_id: `thread_${sheet.dataset.operationId}`, book_id: bookId, annotation_id: note.annotation_id, document_id: note.document_id, status: 'open', topic: values.topic.trim(), created_at: new Date().toISOString(), messages: [createThreadMessage('me', values.insight.trim())] }; note.thread_id = thread.thread_id; next.threads.push(thread); journalTab = 'discussion'; }
  else journalTab = 'excerpt';
  await commit(next); selection = null; returnToBookTab(values.discuss === 'yes' ? 'discussion' : 'excerpt');
}

function openNote(key) { if(sheet.open) sheet.close(); const note = findNote(key); if (!note) return; const doc = state.documents.find((item) => item.document_id === note.document_id); const index = Math.max(0, doc?.chapters?.findIndex((chapter) => note.anchor.start >= chapter.start && note.anchor.start < chapter.end) ?? 0); navigate('reader', { bookId: note.book_id, activeDocumentId: note.document_id, chapterIndex: index }); render(); visitChapter(false); requestAnimationFrame(() => $(`mark[data-notes~="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' })); }
let progressQueue = Promise.resolve();
function visitChapter(reset = true) {
  const doc = currentDoc(), chapter = currentChapter(doc);
  if (!doc || !chapter) return;
  if (reset) { window.scrollTo({top:0,behavior:'instant'}); document.querySelector('.chapter-reading')?.scrollTo(0,0); }
  const start = chapter.start, documentId = doc.document_id;
  const progress = doc.reading_progress || {visited_starts:[]};
  doc.reading_progress = {visited_starts:[...new Set([...progress.visited_starts,start])],last_start:start};
  history.replaceState({readingNav:navState(),readingStack:navigationStack},'',location.href);
  progressQueue = progressQueue.then(async () => {
    if (cloud) await cloud.visitChapter(documentId,start);
    else { const expected=state.revision; const next=structuredClone(state); next.revision=expected+1; await saveSnapshot(db,next,expected); state=next; }
  }).catch(() => toast('本次阅读位置暂未保存，请稍后重试。'));
}
function openThread(threadId) { navigate('thread', {}, threadId); render(); pollThread(threadId); }

function showBookFiles() {
  const docs = state.documents.filter((doc) => doc.book_id === bookId).sort((a, b) => b.version - a.version);
  modal('文件与版本', `<div class="file-list">${docs.map((doc) => `<article><div><strong>版本 ${doc.version} · ${formatLabel(doc.format)}</strong><small>${esc(doc.filename || doc.file_name || '未命名')} · ${doc.reading_status === 'ready' ? '可精准摘抄' : '原件模式'} · ${doc.document_id.slice(0, 12)}…</small></div><div>${doc.format === 'pdf' ? btn('查看', 'view-original', 'text-btn', `data-doc="${doc.document_id}"`) : ''}${btn(`${icon('download')} 下载`, 'download-original', 'text-btn', `data-doc="${doc.document_id}"`)}</div></article>`).join('')}</div><p class="field-note">每个版本保留独立 document_id；旧标注继续指向当时的文件。</p>`, '');
}

async function downloadOriginal(documentId) {
  const doc = state.documents.find((item) => item.document_id === documentId);
  if (cloud && doc) doc.original = await cloud.original(doc);
  if (!doc?.original) return toast(cloud ? '原件暂时无法读取' : '这份旧本地数据没有保存原文件');
  const link = document.createElement('a'); link.href = URL.createObjectURL(doc.original); link.download = doc.filename || doc.file_name || '共读岛文档.txt'; link.rel = 'noopener'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function viewOriginal(documentId) {
  const doc = state.documents.find((item) => item.document_id === documentId);
  if (cloud && doc && doc.format === 'pdf') {
    const opened = window.open('about:blank', '_blank');
    if (!opened) return toast('浏览器阻止了新窗口，请使用下载原件');
    opened.opener = null;
    try {
      const original = await cloud.original(doc);
      const url = URL.createObjectURL(new Blob([original], { type: 'application/pdf' }));
      opened.location.replace(url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { opened.close(); throw error; }
    return;
  }
  if (!doc?.original || doc.format !== 'pdf') return toast('这种格式请下载原件后查看');
  const url = URL.createObjectURL(new Blob([doc.original], { type: 'application/pdf' }));
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) toast('浏览器阻止了新窗口，请使用下载原件');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function toggleThread(threadId) {
  const next = structuredClone(state);
  const thread = next.threads.find((item) => item.thread_id === threadId);
  if (!thread) return;
  thread.status = thread.status === 'open' ? 'closed' : 'open';
  await commit(next);
}

function openShare(key) {
  const note = findNote(key); if (!note) return;
  share = { noteKey: key, style: 'cotton', page: 0, pages: 1 };
  modal('把摘录做成便签', `<div class="share-preview"><canvas id="note-canvas" width="960" height="1200"></canvas></div><div class="paper-choices"><button type="button" data-action="paper-style" data-value="cotton">棉纸</button><button type="button" data-action="paper-style" data-value="sand">原麻</button><button type="button" data-action="paper-style" data-value="sage">鼠尾草</button><button type="button" data-action="paper-style" data-value="ink">深海蓝</button></div><div class="share-pager"><button type="button" data-action="paper-prev">‹</button><span id="paper-page">1 / 1</span><button type="button" data-action="paper-next">›</button></div>`, '');
  $('#sheet-actions').innerHTML = `<button type="button" data-close>取消</button><button type="button" class="primary" data-action="save-note-image">${icon('download')} 保存图片</button>`;
  $('[data-close]', sheet).addEventListener('click', () => sheet.close(), { once: true });
  renderShare();
}

async function renderShare() {
  const note = findNote(share.noteKey);
  const book = state.books.find((item) => item.book_id === note.book_id);
  const result = await drawNote($('#note-canvas'), book, note, share.style, share.page);
  share.pages = result.pages; share.page = result.page;
  $('#paper-page').textContent = `${share.page + 1} / ${share.pages}`;
  document.querySelectorAll('[data-action="paper-style"]').forEach((button) => button.classList.toggle('active', button.dataset.value === share.style));
}

function saveShareImage() { const canvas = $('#note-canvas'); canvas.toBlob((blob) => { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `共读岛-摘录-${share.page + 1}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }, 'image/png'); }
function toast(message) { const element = document.createElement('div'); element.className = 'toast'; element.textContent = message; element.setAttribute('role', 'status'); element.setAttribute('popover', 'manual'); (sheet.open ? sheet : document.body).append(element); if (typeof element.showPopover === 'function') element.showPopover(); else if (sheet.open) sheet.append(element); setTimeout(() => element.remove(), 4000); }

document.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && event.target.matches("article[role=button][data-action]")) { event.preventDefault(); event.target.click(); } });

// iOS visualViewport shrinks and can pan when the software keyboard opens.
function syncDiscussionViewport() {
  const viewport = window.visualViewport;
  document.body.classList.toggle('discussion-open', view === 'thread');
  app.style.setProperty('--discussion-height', `${viewport?.height || window.innerHeight}px`);
  app.style.setProperty('--discussion-top', `${viewport?.offsetTop || 0}px`);
}
window.visualViewport?.addEventListener('resize', syncDiscussionViewport);
window.visualViewport?.addEventListener('scroll', syncDiscussionViewport);
window.addEventListener('resize', syncDiscussionViewport);
