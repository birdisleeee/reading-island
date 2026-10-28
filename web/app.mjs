import {dismissOnOutside} from './dialog-behavior.mjs';
import {createEditSessions} from './edit-session.mjs';
import {mergeThread, mergeLibraryThreads, captureDialogReturnFocus} from './confirmed-state.mjs';
import { syncIslandBadgeAppearance, readingConfig,refreshReadingConfig } from './badge-appearance.mjs';
import { ensureSession, updateSession, getSession } from './session.mjs';
import {openAISettings} from './ai-settings.mjs';
import {openBookCatalog} from './book-catalog.mjs';
import {readerProfileView} from './reader-profile-view.mjs';
import {bindReaderAvatarEditor} from './reader-avatar-editor.mjs';
import {readerAvatarContent} from './reader-avatar-view.mjs';
import {startupView,prepareInitialArtwork} from './startup-view.mjs';
import {mountReaderControls} from './reader-controls.mjs';
import {initAppearance,applyAppearance,collapsedGroups,toggleGroup} from './appearance.mjs';
import {openSettings,openAppearance,openAccountSettings} from './settings.mjs';
const startupProfile=await loadAtStartup(ensureSession, '暂时无法连接共读岛，请检查网络后重试。');
document.querySelector('#app').innerHTML=startupView(startupProfile,'正在打开你的书架…');
await loadAtStartup(refreshReadingConfig, '暂时无法读取共读岛配置，请重试。');
await initAppearance();
const {initialDesktopArtwork}=await import('./desktop.mjs');
await import('./artwork.mjs');
import { groupDiscussionMessages } from './discussion-messages.mjs';
import { renderMarkdown } from './markdown.mjs';
import { createAnnotation, createBook, createThreadMessage, makeAnchor, makeDocument, openDatabase, readSnapshot, resolveAnnotation, saveSnapshot } from './model.mjs';
import { btn, drawNote, groupView, icon, journalView,updateJournalView, shelfView,updateShelfView,captureChapterDirectory,restoreChapterDirectory,jumpToReadChapter } from './visual.mjs';
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
let libraryWriteGeneration = 0;
async function ensureLibraryDetails() {
  while (!cloudDetailsLoaded) {
    if (!cloudDetailsJob) {
      const generation = libraryWriteGeneration;
      cloudDetailsJob = cloud.load().then(value => {
        if (generation === libraryWriteGeneration) { state = mergeLibraryThreads(state, value); cloudDetailsLoaded = true; }
      }).finally(() => { cloudDetailsJob = null; });
    }
    await cloudDetailsJob;
  }
}

async function loadAtStartup(load, message) {
  while (true) {
    try { return await load(); }
    catch {
      // Keep failures distinct from a successfully loaded empty library.
      const root = document.querySelector('#app');
      root.innerHTML = startupView(getSession(),message,true);
      const button = root.querySelector('button');
      await new Promise(resolve => button.addEventListener('click', resolve, { once: true }));
      button.disabled = true;
      root.querySelector('[role="status"]').textContent = '正在重新连接…';
    }
  }
}
state = await loadAtStartup(() => cloud ? cloud.load({ shelfOnly: true }) : readSnapshot(db), '书库暂时无法读取，请稍后重试。');
let view = 'shelf';
let bookId = null;
let activeDocumentId = null;
let readerSearch = '';
let shelfSearch = '';
let selection = null;
let filter = 'all';
let share = null;
let shareDrawVersion = 0;
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
// Drafts and unknown send results belong to their discussion, not a rendered form.
const replyDrafts = new Map();
const replyDraftVersions = new Map();
const pendingReplies = new Map();
const activeDeliveryStatuses = new Set(['pending', 'dispatching', 'accepted', 'processing', 'delivering']);
let bookDrag = null;
let suppressBookClick = false;
const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const sheet = $('#sheet');
let profileAvatarEditor;
let readerControls;
let initialCoverPass=true;
dismissOnOutside(sheet);
const edits = createEditSessions({
  isOpen: () => sheet.open,
  onSaving: busy => {
    $('#sheet-form').toggleAttribute('aria-busy', busy);
    // Creation IDs describe immutable submitted content. Keep close/cancel usable,
    // but don't allow a second payload under the same creation identity.
    $('#sheet-body').inert = busy && !['edit-book', 'reader-profile'].includes(sheet.dataset.mode);
    const submit = $('#sheet-actions [type="submit"]');
    if (submit) submit.disabled = busy || sheet.dataset.avatarBusy === 'true';
  },
  onSaved: job => {
    if (job.unchanged()) { sheet.close(); job.returnFocus?.(); }
    else toast('已保存提交时的内容，后续修改尚未保存。');
  },
  onError: (error, job) => toast((job.current() ? '' : '上一项操作保存失败：') + (job.mode === 'upload' ? '导入尚未完成，书架不会显示空书；保留当前窗口可用同一文件重试。' : '') + (error.message || '保存失败，请重试'), !job.current()),
});
for (const type of ['input', 'change']) sheet.addEventListener(type, () => edits.touch());
let actionGeneration = 0;
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
const initialCovers=cloud?cloud.loadCovers(state,paintCover).then(()=>state.books.slice(0,12).map(book=>book.cover_data)):[];
await prepareInitialArtwork(['/reading-island/assets/reading-cluster.svg','/reading-island/assets/default-cover.svg',initialDesktopArtwork,initialCovers,...['--theme-image','--reader-image'].map(key=>document.documentElement.style.getPropertyValue(key).match(/^url\(["']?(.*?)["']?\)$/)?.[1])]);
render();
delete document.body.dataset.readingStarting;
if (restoredThread) pollThread(restoredThread.thread_id);

async function commit(next) {
  if (cloud) {
    libraryWriteGeneration++;
    let result;
    try { result = await cloud.commit(state, next); }
    catch (error) {
      if (error.confirmedState) { state = mergeLibraryThreads(state, error.confirmedState); render(); }
      throw error;
    }
    state = mergeLibraryThreads(state, result.state);
    if (!result.warning) cloudDetailsLoaded = true;
    render();
    if (result.warning) toast(result.warning, true);
    return;
  }
  const expected = state.revision;
  next.revision = expected + 1;
  await saveSnapshot(db, next, expected);
  state = next;
  render();
}

const shelfRefreshedTurns=new Map();
function refreshShelfAfterTurn(thread){
  if(!cloud)return;
  const turn=thread.latest_turn_id||thread.opening_turn_id;
  if(!turn||shelfRefreshedTurns.get(thread.thread_id)===turn)return;
  shelfRefreshedTurns.set(thread.thread_id,turn);
  const generation=libraryWriteGeneration;
  void cloud.load({shelfOnly:true}).then(snapshot=>{
    if(generation!==libraryWriteGeneration)return;
    const changed=JSON.stringify(state.books)!==JSON.stringify(snapshot.books)||JSON.stringify(state.group_records)!==JSON.stringify(snapshot.group_records);
    if(!changed)return;
    libraryWriteGeneration++;
    state={...state,books:snapshot.books,groups:snapshot.groups,group_records:snapshot.group_records};
    cloudDetailsLoaded=false;paintUnreadBadges();
    if(view==='shelf'||view==='group')render();
  }).catch(()=>{/* A later explicit reload can recover the shelf without repeating a model request. */});
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
      state.threads[index] = mergeThread(state.threads[index], thread);
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
      if (!activeDeliveryStatuses.has(thread.delivery_status)) { refreshShelfAfterTurn(thread); return; }
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
  actionGeneration++;
  if (sheet.open) sheet.close();
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
  readerControls?.dispose();readerControls=null;
  const previousView = app.dataset.view;
  const previousScroll = app.querySelector('.thread-scroll')?.scrollTop;
  const previousDirectory = captureChapterDirectory(app);
  if (view === 'shelf') updateShelfView(app,shelfView(state.books, state.groups, shelfSearch, menuOpen,collapsedGroups()));
  const existingReminder=app.querySelector('.ai-connect-reminder');
  if(view==='shelf'&&!readingConfig.aiConfigured&&!existingReminder){
    const reminder=document.createElement('div');reminder.className='ai-connect-reminder';
    reminder.innerHTML='<span>先连接自己的 AI，再开始一起读书。</span><button type="button" data-action="ai-settings">去接入 AI →</button>';
    app.querySelector('.library-hero').after(reminder);
  }
  if(view==='shelf'&&readingConfig.aiConfigured)existingReminder?.remove();
  if (view === 'group') app.innerHTML = groupView(state.books, groupName);
  if (view === 'journal') updateJournalView(app,journalView(currentBook(), bookNotes(), state.threads, journalTab, currentDoc()));
  if (view === 'journal') app.append(app.querySelector('.journal-bottom'));
  if (view === 'journal' && journalTab === 'original') restoreChapterDirectory(app, currentDoc(), previousDirectory);
  if (view === 'reader') app.innerHTML = readerView();
  if (view === 'notes') app.innerHTML = notesView();
  if (view === 'thread') app.innerHTML = threadView();
  if (view === 'reader') paintReader();
  app.dataset.view = view;
  if(view==='reader')readerControls=mountReaderControls(app.querySelector('.reader-screen'));
  syncDiscussionViewport();
  if (view === 'thread' && previousView === 'thread' && previousScroll != null) app.querySelector('.thread-scroll').scrollTop = previousScroll;
  paintUnreadBadges();
  if (cloud) { void refreshUnread(); void acknowledgeDiscussion(); }
  if (cloud&&!initialCoverPass) void cloud.loadCovers(state,paintCover);
  initialCoverPass=false;
  if (previousView && previousView !== view) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}

function paintCover(book){
  const source=book.cover_data;
  void prepareInitialArtwork([source]).then(()=>{const current=state.books.find(item=>item.book_id===book.book_id);if(current?.cover_data!==source||current.cover_sha256!==book.cover_sha256)return;document.querySelectorAll(`[data-cover-book="${CSS.escape(book.book_id)}"]`).forEach(image=>{if(image.getAttribute('src')!==source)image.src=source;});});
}

function paintUnreadBadges() {
  document.dispatchEvent(new CustomEvent('reading-library-summary',{detail:{groups:state.groups,books:state.books.map(book=>({book_id:book.book_id,category:book.category,unread:unreadCounts.get(book.book_id)||0}))}}));
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
  return `<section class="reader-screen"><header class="reader-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>${esc(book.title)}</p><small>${esc(chapter.title)} · v${doc.version}</small></div>${btn(icon('search'), 'reader-search', 'icon-btn', 'aria-label="搜索本章"')}${btn('<svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>', 'reader-settings', 'icon-btn', 'aria-label="阅读排版设置"')}</header><div class="reader-tools"><span>选中原文后，可以高亮、摘抄或发起讨论</span><span class="scope-pill">仅限 ${esc(doc.document_id.slice(0, 12))}…</span></div><div class="chapter-reading">${doc.format === 'epub' ? '' : `<h1>${esc(chapter.title)}</h1>`}<article id="reader-text" class="reader-paper" data-document="${esc(doc.document_id)}" data-chapter="${esc(chapter.chapter_id || '')}"></article><nav class="chapter-turner"><button type="button" data-action="previous-chapter" ${previous ? '' : 'disabled'}>‹ 上一章</button><button type="button" data-action="journal-original">章节目录</button><button type="button" data-action="next-chapter" ${next ? '' : 'disabled'}>下一章 ›</button></nav></div><div id="selection-bar" class="selection-bar hidden"><button data-action="annotate-selection">高亮并摘抄</button><button data-action="discuss-selection">讨论这段</button></div></section>`;
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
  return `<article class="discussion-card global-discussion" data-action="open-thread" data-thread="${thread.thread_id}" role="button" tabindex="0"><header><span>${thread.status === 'open' ? '讨论中' : '已结束'}</span><small>${esc((thread.created_at || '').slice(0, 10))}</small></header><h2>${esc(thread.topic || '围绕整本书')}</h2><p class="book-topic-context">${note ? '原文讨论' : '全书议题'} · 《${esc(book?.title || '未知书籍')}》</p>${note ? `<blockquote>${esc(note.anchor.exact)}</blockquote>` : ''}${opening ? `<div class="discussion-opening markdown-body"><span>${thread.scheduled ? '定时任务：' : thread.messages?.[0]?.author === 'assistant' ? 'AI的开场：' : '我的开场：'}</span>${renderMarkdown(opening)}</div>` : ''}<footer><span>${note ? '原文讨论' : '全书议题'}</span><span>${thread.messages?.length || 0} 条回复</span></footer></article>`;
}

function threadView() {
  const threadId = new URLSearchParams(location.hash.slice(1)).get('thread');
  const thread = state.threads.find((item) => item.thread_id === threadId);
  const note = state.annotations.find((item) => item.thread_id === threadId);
  if (!thread) return `<section class="empty"><h2>没有找到讨论</h2>${btn('返回上一层', 'back')}</section>`;
  const pending = pendingReplies.get(threadId);
  const composer = thread.status === 'open' ? `<form id="reply-form" class="reply-box" data-thread="${esc(threadId)}"><div class="reply-composer"><textarea id="reply-text" maxlength="16000" ${pending ? '' : 'required'} placeholder="继续说说你的想法……" aria-describedby="reply-send-status">${esc(replyDrafts.get(threadId) || '')}</textarea></div><button class="primary" ${pending?.busy ? 'disabled' : ''}>${pending ? pending.busy ? '发送中…' : '重试发送' : '回复'}</button><p id="reply-send-status" class="reply-send-status" role="status">${replyStatus(pending)}</p></form>` : '<p class="empty-copy">讨论已结束，可以从右上角重新打开。</p>';
  const book = state.books.find((item) => item.book_id === (thread.book_id || note?.book_id));
  const anchor = note ? `<small>原文 · ${esc(note.document_id.slice(0, 12))}… · v${note.document_version}</small><blockquote>${esc(note.anchor.exact)}</blockquote>${note.insight ? `<p>${esc(note.insight)}</p>` : ''}${btn('在原文查看','open-note','text-btn',`data-note="${noteKey(note)}"`)}` : `<small>全书议题</small><p>围绕《${esc(book?.title || '这本书')}》展开，不绑定某一段摘录。</p>`;
  const delivery = activeDeliveryStatuses.has(thread.delivery_status)
    ? '<p class="thread-delivery-status" role="status">AI正在读……</p>'
    : ['failed', 'interrupted', 'unavailable'].includes(thread.delivery_status) && thread.latest_turn_id
      ? `<p class="thread-delivery-status">这次回复暂时没有送达。${btn('重试', 'retry-turn', 'text-btn', `data-thread="${thread.thread_id}" data-turn="${thread.latest_turn_id}"`)}</p>`
      : '';
  return `<section class="thread-screen"><header class="simple-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><p>${esc(thread.topic || (note ? '附在原文上的讨论' : '全书讨论'))}</p><small>${esc(book?.title || '')}</small></div>${btn(thread.status === 'open' ? '结束' : '重开', 'toggle-thread', 'text-btn', `data-thread="${thread.thread_id}"`)}</header><div class="thread-scroll"><article class="thread-anchor">${anchor}</article><div class="messages">${groupDiscussionMessages(thread.messages).map((group) => `<article class="message ${group.author === 'me' ? 'mine' : 'assistant'}"><b>${group.author === 'me' ? (thread.scheduled&&group.parts[0]?.sequence===0?'定时任务':'我') : esc(readingConfig.aiName)}</b>${group.parts.map(message => `${message.quote ? `<blockquote class="message-quote">${esc(message.quote.text)}</blockquote>` : ''}<div class="markdown-body">${renderMarkdown(message.text)}</div>`).join('')}</article>`).join('')}</div>${delivery}</div>${composer}</section>`;
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
    element.className=isHeading?'reader-heading':'reader-paragraph';
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
  if (event.target.closest('[data-close]') && sheet.contains(event.target)) { actionGeneration++; sheet.close(); return; }
  if (menuOpen && !event.target.closest('.shelf-menu-wrap')) { menuOpen = false; render(); if (!event.target.closest('.reading-desktop-rail')) return; }
  const marked = event.target.closest('mark[data-note]');
  if (marked && !window.getSelection()?.toString()) { const note=findNote(marked.dataset.note); if(note?.thread_id) openThread(note.thread_id); else if(note) showNoteDetail(note); return; }
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const action = control.dataset.action;
  const generation = ++actionGeneration;
  if (cloud && !['back','toggle-menu','open-group','open-shelf','toggle-group','reader-settings','reader-profile'].includes(action)) {
    control.setAttribute('aria-busy', 'true');
    try { await ensureLibraryDetails(); } catch (error) { toast(error.message); return; }
    finally { control.removeAttribute('aria-busy'); }
    if (generation !== actionGeneration || !control.isConnected) return;
  }
  if (cloud && ['open-note', 'open-chapter', 'chapter-settings'].includes(action)) {
    const targetBook = action === 'open-book' ? control.dataset.book : action === 'open-note' ? findNote(control.dataset.note)?.book_id : bookId;
    try { await cloud.ensureBook(state, targetBook); } catch (error) { toast(error.message); return; }
    if (generation !== actionGeneration || !control.isConnected) return;
  }
  if (action === 'note-detail') { const note=findNote(control.dataset.note); if(note) showNoteDetail(note); return; }
  if (action === 'back') { goBack(); return; }
  if (action === 'open-shelf') { menuOpen = false; navigate('shelf', {bookId:null}); render(); return; }
  if(action==='settings'||action==='toggle-menu'){openSettings({navigation:action==='toggle-menu',onNavigate:action=>void navigateFromDrawer(action),books:state.books,groups:state.group_records||[],onAI:async()=>{await refreshReadingConfig();applyAppearance();render();}});return;}
  if(action==='public-account'){void openAccountSettings();return;}
  if(action==='reader-settings'){openAppearance('reader');return;}
  if(action==='toggle-group'){
    const collapsed=toggleGroup(control.dataset.group),section=control.closest('.shelf-section');
    const isCollapsed=collapsed.has(control.dataset.group);
    section.querySelector('.book-strip').hidden=isCollapsed;
    control.setAttribute('aria-expanded',String(!isCollapsed));
    return;
  }
  if(action==='ai-settings'){await openAISettings(async()=>{await refreshReadingConfig();render();});return;}
  if (['date-month','date-pick','date-cancel'].includes(action)) {
    const field = control.closest('.date-field'), popup = field.querySelector('.date-popup'), input = field.querySelector('input');
    if (action === 'date-cancel') { popup.hidePopover(); return; }
    if (action === 'date-pick') {
      edits.touch();
      input.value = control.dataset.value || '';
      field.querySelector('[data-date-label]').textContent = input.value || '未设置';
      popup.hidePopover(); return;
    }
    renderDateCalendar(field, Number(control.dataset.step));
    positionFieldPopover(popup, field.querySelector('.date-trigger'));
    return;
  }
  if (action === 'select-option') {
    edits.touch();
    const select = control.closest('.pretty-select'); $('input[type="hidden"]', select).value = control.dataset.value || ''; $('[data-select-label]', select).textContent = control.dataset.label || control.textContent.trim();
    select.querySelectorAll('[role="option"]').forEach((item) => item.setAttribute('aria-selected', String(item === control)));
    $('.pretty-select-menu', select).hidePopover(); $('.pretty-select-trigger', select).setAttribute('aria-expanded', 'false'); return;
  }

  if (action === 'journal-original') { returnToBookTab('original'); return; }
  if (action === 'jump-read-chapter') {
    if(journalTab!=='original'){journalTab='original';render();}
    if(!jumpToReadChapter(app,currentDoc()))toast('还没有已读章节');
    return;
  }
  if (action === 'journal-tab') { journalTab = control.dataset.value || 'excerpt'; if (journalTab === 'original') { activeDocumentId = currentBook().current_document_id; chapterIndex = 0; } render(); }
  if (action === 'open-group') { menuOpen = false; navigate('group', { groupName: control.dataset.group || '堆放' }); render(); return; }
  if (action === 'open-book') { if (suppressBookClick) { suppressBookClick = false; return; } const book = state.books.find((item) => item.book_id === control.dataset.book); navigate('journal', { bookId: book.book_id, activeDocumentId: book.current_document_id, chapterIndex: 0, journalTab: 'original' }); render(); return; }
  if (action === 'open-chapter') { navigate('reader', { chapterIndex: Number(control.dataset.index) || 0 }); render(); visitChapter(); return; }
  if (action === 'previous-chapter' && chapterIndex > 0) { chapterIndex -= 1; selection = null; render(); visitChapter(); }
  if (action === 'next-chapter' && chapterIndex < (currentDoc()?.chapters?.length || 1) - 1) { chapterIndex += 1; selection = null; render(); visitChapter(); }
  if (action === 'all-notes') { menuOpen = false; navigate('notes', { filter: 'all' }); render(); }
  if (action === 'filter') { filter = control.dataset.value; render(); }
  if (action === 'add-book') uploadBook();
  if (action === 'search-books' && cloud) openCatalogWorkflow();
  if (action === 'create-group') createGroup();
  if (action === 'manage-groups') manageGroups();
  if (action === 'reader-profile') { try { await openReaderProfile(); } catch(error) { toast(error.message); } }
  if (action === 'delete-group') { try { await deleteGroup(control.dataset.group); } catch (error) { toast(error.message); } }
  if (action === 'edit-book') editBook();
  if (action === 'book-options') modal('书籍管理', `<nav class="book-management" aria-label="书籍管理">${btn('编辑资料','edit-book','secondary')}${btn('文件与下载','book-files','secondary')}${btn('新增版本','replace-book','secondary')}</nav>`);
  if (action === 'start-discussion') startDiscussion();
  if (action === 'chapter-settings') editChapters();
  if (action === 'add-chapter-row') addChapterRow();
  if (action === 'remove-chapter-row') { edits.touch(); control.closest('.chapter-editor-row')?.remove(); }
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
      if (index >= 0) state.threads[index] = mergeThread(state.threads[index], refreshed);
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
  if (event.target.id === 'reply-text') {
    const id = event.target.closest('#reply-form').dataset.thread;
    replyDrafts.set(id, event.target.value);
    replyDraftVersions.set(id, (replyDraftVersions.get(id) || 0) + 1);
  }
  if (event.target.id === 'shelf-search') { shelfSearch = event.target.value; render(); }
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
  if (!sheet.dataset.mode || sheet.dataset.avatarBusy === 'true') return;
  await edits.run((input, job) => {
    const { values } = input;
    switch (job.mode) {
      case 'annotation': return saveAnnotation(values, job);
      case 'discussion': return saveDiscussion(values, job);
      case 'upload': return saveUpload(values, false, job, input.file);
      case 'replace': return saveUpload(values, true, job, input.file);
      case 'edit-book': return saveBookMeta(values, job, input.cover);
      case 'chapter-settings': return saveChapterSettings(job, input.chapters);
      case 'create-group': return saveGroup(values);
      case 'reader-profile': return saveReaderProfile(values, job);
      default: return false;
    }
  }, captureSheetInput);
});

function captureSheetInput() {
  return {
    values: Object.fromEntries(new FormData($('#sheet-form'))),
    file: $('#sheet-body input[name=file]')?.files[0],
    cover: $('#cover-file')?.files[0],
    chapters: [...sheet.querySelectorAll('#chapter-editor .chapter-editor-row')].map(row => ({ chapter_id: row.dataset.chapterId, title: $('.chapter-title-input', row).value, start: Number($('.chapter-start-input', row).value) })),
  };
}

function replyStatus(pending) {
  return !pending ? '' : pending.busy ? '正在发送，可继续写下一条。' : '上一条发送结果尚未确认，重试会核对上一条消息，当前草稿会保留。';
}
function updateReplyComposer(threadId) {
  const form = $('#reply-form');
  if (form?.dataset.thread !== threadId) return;
  const pending = pendingReplies.get(threadId);
  const button = form.querySelector('button');
  button.disabled = Boolean(pending?.busy);
  button.textContent = pending ? pending.busy ? '发送中…' : '重试发送' : '回复';
  const status = form.querySelector('#reply-send-status');
  status.textContent = replyStatus(pending);
  form.querySelector('textarea').required = !pending;
}
document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'reply-form') return;
  event.preventDefault();
  const threadId = event.target.dataset.thread;
  let pending = pendingReplies.get(threadId);
  if (pending?.busy) return;
  const raw = event.target.querySelector('textarea').value;
  replyDrafts.set(threadId, raw);
  if (!pending) {
    if (!raw.trim()) return;
    pending = { message: createThreadMessage('me', raw.trim()), draftVersion: replyDraftVersions.get(threadId) || 0, attempts: 0 };
    pendingReplies.set(threadId, pending);
  }
  pending.busy = true;
  const reconcile = pending.attempts++ > 0;
  updateReplyComposer(threadId);
  let replyResult;
  try {
    if (cloud) {
      replyResult = await cloud.sendReply(threadId, pending.message, { reconcile });
      const index = state.threads.findIndex(item => item.thread_id === threadId);
      if (index >= 0) state.threads[index] = mergeThread(state.threads[index], replyResult.thread || { ...state.threads[index], messages: [replyResult.message] });
    } else {
      const next = structuredClone(state);
      const messages = next.threads.find(item => item.thread_id === threadId).messages;
      if (!messages.some(item => item.message_id === pending.message.message_id)) messages.push(pending.message);
      await commit(next);
    }
  } catch (error) {
    pending.busy = false;
    updateReplyComposer(threadId);
    toast(error.status ? error.message : '上一条发送结果尚未确认，请重试发送。');
    return;
  }
  // The send is confirmed. DOM availability must never change its outcome.
  if ((replyDraftVersions.get(threadId) || 0) === pending.draftVersion) replyDrafts.delete(threadId);
  pendingReplies.delete(threadId);
  try {
    if (view === 'thread' && new URLSearchParams(location.hash.slice(1)).get('thread') === threadId) {
      // Keep the live input node, focus and geometry stable across send completion.
      const template = document.createElement('template');
      template.innerHTML = threadView();
      const messages = app.querySelector('.messages');
      if (messages) messages.replaceChildren(...template.content.querySelector('.messages').childNodes);
      app.querySelector('.thread-delivery-status')?.remove();
      const delivery = template.content.querySelector('.thread-delivery-status');
      if (delivery && messages) messages.after(delivery);
      const textarea = app.querySelector('#reply-text'), draft = replyDrafts.get(threadId) || '';
      if (textarea && textarea.value !== draft) textarea.value = draft;
      updateReplyComposer(threadId);
      const scroll = app.querySelector('.thread-scroll');
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
      pollThread(threadId);
    }
    if (replyResult?.warning) toast(replyResult.warning);
    void refreshUnread();
  } catch {
    toast('回复已发送，显示暂未更新，请重新打开讨论查看。');
  }
});

function modal(title, body, mode = '') {
  profileAvatarEditor?.dispose();profileAvatarEditor=null;delete sheet.dataset.avatarBusy;
  const returnFocus = captureDialogReturnFocus(document);
  sheet.dataset.operationId = crypto.randomUUID();
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = body;
  $('#sheet-body').scrollTop = 0;
  sheet.querySelectorAll('.pretty-select-menu,.date-popup').forEach(menu => {
    const trigger = menu.parentElement.querySelector('[popovertarget]');
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      if (menu.classList.contains('date-popup')) renderDateCalendar(menu.parentElement);
      menu.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        if (menu.matches(':popover-open')) positionFieldPopover(menu, trigger);
        menu.style.visibility = '';
      });
    });
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  });
  $('#sheet-actions').innerHTML = mode ? '<button type="button" data-close>取消</button><button class="primary" type="submit">保存</button>' : '<button type="button" data-close>关闭</button>';
  sheet.dataset.mode = mode;
  const session = edits.begin({ mode, operationId: sheet.dataset.operationId, bookId, documentId: currentDoc()?.document_id, selection: selection && { ...selection }, view, activeDocumentId, returnFocus });
  sheet.showModal();
  return session;
}

function showNoteDetail(note) {
  modal('完整摘录', `<blockquote class="full-excerpt">${esc(note.anchor.exact)}</blockquote><p>${esc(note.insight || '')}</p>`);
  $('#sheet-actions').innerHTML = btn('在原文查看', 'open-note', 'primary', `data-note="${noteKey(note)}"`);
}

function positionFieldPopover(popup, trigger) {
  const rect = trigger.getBoundingClientRect(), calendar = popup.classList.contains('date-popup');
  const width = Math.min(calendar ? 300 : Math.max(200, rect.width), innerWidth - 24);
  popup.style.width = width + 'px';
  popup.style.left = Math.max(12, Math.min(rect.right - width, innerWidth - width - 12)) + 'px';
  const height = popup.getBoundingClientRect().height;
  const top = rect.bottom + height + 8 < innerHeight ? rect.bottom + 6 : rect.top - height - 6;
  popup.style.top = Math.max(12, Math.min(top, innerHeight - height - 12)) + 'px';
}
function renderDateCalendar(field, step) {
  const popup = field.querySelector('.date-popup'), input = field.querySelector('input');
  const base = step === undefined ? input.value || localDate(new Date()) : popup.dataset.month;
  const [year, month] = base.split('-').map(Number);
  const date = new Date(year, month - 1 + (step || 0), 1);
  popup.dataset.month = localDate(date).slice(0, 7);
  const prefix = popup.dataset.month, offset = (date.getDay() + 6) % 7, days = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  popup.innerHTML = `<div class="calendar-head"><button type="button" data-action="date-month" data-step="-1" aria-label="上个月">‹</button><strong>${date.getFullYear()}年${date.getMonth()+1}月</strong><button type="button" data-action="date-month" data-step="1" aria-label="下个月">›</button></div><div class="calendar-grid">${['一','二','三','四','五','六','日'].map(day=>`<span>${day}</span>`).join('')}${'<span></span>'.repeat(offset)}${Array.from({length:days},(_,i)=>{const value=prefix+'-'+String(i+1).padStart(2,'0');return `<button type="button" data-action="date-pick" data-value="${value}" aria-label="${value}" aria-pressed="${value===input.value}">${i+1}</button>`;}).join('')}</div><div class="calendar-footer"><button type="button" data-action="date-cancel">取消</button><button type="button" data-action="date-pick" data-value="${localDate(new Date())}">今天</button></div>`;
}

function localDate(date) { return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0'); }
function customSelect(name, options, selected = '', label = '') {
  const menuId = 'select-' + crypto.randomUUID();
  const current = options.find((option) => option.value === selected) || options[0];
  return `<div class="pretty-select"><input type="hidden" name="${esc(name)}" value="${esc(current?.value || '')}"><button type="button" class="pretty-select-trigger" popovertarget="${menuId}" popovertargetaction="toggle" ${label ? `aria-label="${esc(label)}"` : ''} aria-haspopup="listbox" aria-expanded="false"><span data-select-label>${esc(current?.label || '')}</span><b aria-hidden="true">›</b></button><div id="${menuId}" class="pretty-select-menu" popover="auto" role="listbox">${options.map((option) => `<button type="button" role="option" data-action="select-option" data-value="${esc(option.value)}" data-label="${esc(option.label)}" aria-selected="${option.value === current?.value}">${esc(option.label)}</button>`).join('')}</div></div>`;
}
function documentFileField(id, label) {
  return `<div class="document-file-field">${label?`<span>${esc(label)}</span>`:''}<label class="document-file-button" for="${esc(id)}"><span data-file-label-for="${esc(id)}">选择文件</span></label><input class="document-file-input" id="${esc(id)}" name="file" type="file" accept="${FORMAT_ACCEPT}" required></div>`;
}
function groupSelect(selected = '堆放') { return customSelect('category', state.groups.map((group) => ({ value: group, label: group })), selected, '分组'); }
function closeShelfMenu() { if (menuOpen) { menuOpen = false; render(); } }

function uploadBook() {
  closeShelfMenu();
  modal('添加一本书', `<div class="book-source-options">${documentFileField('new-book-file', '电子文档')}${cloud ? '<button type="button" class="secondary catalog-source" data-action="search-books">从开放书库导入</button>' : ''}</div><div class="format-support"><b>可精准摘抄</b><span>TXT · Markdown · DOCX · EPUB · HTML</span><b>先保存原件</b><span>PDF · DOC · MOBI · AZW · AZW3</span></div><label>书名<input name="title" placeholder="默认使用文件名"></label><label>作者<input name="author"></label><div class="field-group"><span>分组</span>${groupSelect()}</div><label>出版社<input name="publisher"></label><p class="field-note">文件最多 25 MB，${cloud ? '保存到云端书库。' : '只保存在此浏览器。'}无加密 DOCX/EPUB 会生成冻结阅读文本；无法可靠解析的格式仍可查看和下载原件。</p>`, 'upload');
}

function replaceBook() { modal('新增文档版本', `${documentFileField('replacement-book-file', '')}<p class="field-note">旧文档和旧标注仍保留；新文件生成新的 document_id 和版本。</p>`, 'replace'); }

function editBook() {
  const book = currentBook();
  modal('编辑书籍资料', `<div class="cover-editor"><div class="cover-preview"><img src="${esc(book.cover_data || '/reading-island/assets/default-cover.svg')}" alt="当前封面"><span>${esc(book.title)}</span></div><label class="cover-upload"><span>上传封面</span><span class="cover-file-button">选择封面</span><input id="cover-file" name="cover" type="file" accept="image/png,image/jpeg,image/webp"></label></div><div class="book-edit-fields"><label class="settings-row"><span>书名</span><input name="title" required value="${esc(book.title)}" placeholder="请输入书名"></label><label class="settings-row"><span>作者</span><input name="author" value="${esc(book.author || '')}" placeholder="请输入作者"></label><label class="settings-row"><span>出版社</span><input name="publisher" value="${esc(book.publisher || '')}" placeholder="请输入出版社"></label><div class="settings-row"><span>分组</span>${groupSelect(book.category)}</div><div class="settings-row"><span>阅读状态</span>${customSelect('reading_status', [{ value: '', label: '未读（默认）' }, { value: 'reading', label: '阅读中' }, { value: 'finished', label: '已阅' }], book.reading_status || '', '阅读状态')}</div><div class="settings-row"><span>开始阅读时间</span><div class="date-field"><input type="hidden" name="reading_started_at" value="${esc(book.reading_started_at || '')}"><button type="button" class="date-trigger" popovertarget="book-start-date" aria-expanded="false" aria-label="开始阅读时间"><span data-date-label>${esc(book.reading_started_at || '未设置')}</span><span aria-hidden="true">›</span></button><div id="book-start-date" class="date-popup" popover="auto" role="dialog" aria-label="开始阅读时间日历"></div></div></div><div class="settings-row"><span>结束阅读时间</span><div class="date-field"><input type="hidden" name="reading_finished_at" value="${esc(book.reading_finished_at || '')}"><button type="button" class="date-trigger" popovertarget="book-end-date" aria-expanded="false" aria-label="结束阅读时间"><span data-date-label>${esc(book.reading_finished_at || '未设置')}</span><span aria-hidden="true">›</span></button><div id="book-end-date" class="date-popup" popover="auto" role="dialog" aria-label="结束阅读时间日历"></div></div></div></div>`, 'edit-book');
  $('#cover-file').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; const url = URL.createObjectURL(file); $('.cover-preview img').src = url; sheet.addEventListener('close', () => URL.revokeObjectURL(url), { once: true }); });
}

function startDiscussion() {
  const available = bookNotes().filter((note) => !note.thread_id);
  const quoteOptions = [{ value: '', label: '无（围绕整本书）' }, ...available.map((note) => ({ value: note.annotation_id, label: `${note.anchor.exact.replace(/\s+/g, ' ').slice(0, 48)}${note.anchor.exact.length > 48 ? '…' : ''}` }))];
  modal('发起讨论议题', `<div class="field-group"><span>围绕哪段摘录</span>${customSelect('annotation_id', quoteOptions, '')}</div><label>议题<input name="topic" maxlength="80" required placeholder="例如：我们为什么总想尽快知道结尾？"></label><label>我的开场<textarea name="opening" required placeholder="先写下你的问题、判断或感受……"></textarea></label><p class="field-note">选择摘录时会固定携带文档版本和准确原文；选择“无”时，这是一张只归属于当前书籍的议题卡。</p>`, 'discussion');
}

async function saveDiscussion(values, job) {
  const next = structuredClone(state);
  const note = values.annotation_id ? next.annotations.find((item) => item.annotation_id === values.annotation_id && item.book_id === job.bookId) : null;
  if (values.annotation_id && (!note || note.thread_id)) throw new Error('这段摘录已经有讨论，或不属于当前书籍。');
  const thread = { thread_id: `thread_${job.operationId}`, book_id: job.bookId, annotation_id: note?.annotation_id || '', document_id: note?.document_id || job.documentId || '', status: 'open', topic: values.topic.trim(), created_at: new Date().toISOString(), messages: [createThreadMessage('me', values.opening.trim())] };
  if (note) note.thread_id = thread.thread_id;
  next.threads.push(thread);
  await commit(next);
  if (job.unchanged()) { journalTab = 'discussion'; render(); }
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
  edits.touch();
  const editor = $('#chapter-editor');
  const doc = currentDoc();
  if (!editor || !doc) return;
  const starts = [...editor.querySelectorAll('.chapter-start-input')].map((input) => Number(input.value)).filter(Number.isFinite);
  const start = Math.min(doc.text.length - 1, Math.max(0, (starts.at(-1) || 0) + 1));
  editor.insertAdjacentHTML('beforeend', chapterEditorRow({ title: '新章节', start }));
  editor.lastElementChild.querySelector('.chapter-title-input').select();
}

async function autoDetectChapters() {
  await edits.run(async (_, job) => {
    const doc = state.documents.find(item => item.document_id === job.documentId);
    if (!doc) return false;
    const ranges = detectChapterRanges(doc.text);
    const next = structuredClone(state);
    const target = next.documents.find((item) => item.document_id === doc.document_id);
    target.chapters = ranges.map((chapter, index) => ({ ...chapter, chapter_id: `chapter_${crypto.randomUUID()}`, order: index }));
    await commit(next);
    if (job.unchanged()) { chapterIndex = 0; render(); toast(`已识别 ${ranges.length} 个章节`); }
  }, () => null);
}

async function saveChapterSettings(job, rows) {
  const doc = state.documents.find(item => item.document_id === job.documentId);
  const ranges = normalizeChapterRanges(doc.text, rows);
  const idsByStart = new Map(rows.map((row) => [row.start, row.chapter_id]));
  const next = structuredClone(state);
  const target = next.documents.find((item) => item.document_id === doc.document_id);
  target.chapters = ranges.map((chapter, index) => ({ ...chapter, chapter_id: idsByStart.get(chapter.start) || `chapter_${crypto.randomUUID()}`, order: index }));
  await commit(next);
  if (job.unchanged()) { chapterIndex = Math.min(chapterIndex, target.chapters.length - 1); render(); }
  return true;
}

async function openReaderProfile() {
  closeShelfMenu();
  const session = modal('个人中心', '<p role="status">正在读取个人资料…</p>');
  await ensureLibraryDetails();
  if (!edits.current(session)) return;
  const response=await fetch('/api/reading/profile',{cache:'no-store'});
  if (!edits.current(session)) return;
  if(!response.ok)throw new Error('登录资料暂时无法读取，请重试。');
  const value = await response.json();
  if (!edits.current(session)) return;
  const profile=updateSession(value);
  const editor=modal('个人中心',readerProfileView(profile,{counts:{books:state.books.length,notes:state.annotations.filter(note=>note.purpose!=='discussion').length,threads:state.threads.length},hosted:Boolean(getSession()?.hosted)}),'reader-profile');
  profileAvatarEditor=bindReaderAvatarEditor(sheet,{profile,isCurrent:()=>edits.current(editor),onTouch:()=>edits.touch(),onError:message=>toast(message),onBusy:busy=>{
    if(!edits.current(editor))return;
    sheet.dataset.avatarBusy=String(busy);
    const submit=$('#sheet-actions [type="submit"]');if(submit)submit.disabled=busy||$('#sheet-form').getAttribute('aria-busy')==='true';
  }});
}
async function saveReaderProfile(values, job) {
  const response=await fetch('/api/reading/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:values.username.trim(),revision:Number(values.revision),avatar_data:values.avatar_data})});
  if(!response.ok)throw new Error(response.status===409?'资料已在其他窗口更新，请重新打开后修改。':'资料未保存，请检查用户名并重试。');
  const profile = updateSession(await response.json());
  document.querySelectorAll('.drawer-identity strong').forEach((name) => { name.textContent = profile.username; });
  document.querySelectorAll('.drawer-identity [data-reader-avatar]').forEach((avatar) => { avatar.innerHTML=readerAvatarContent(profile); });
  const revision = sheet.dataset.mode === 'reader-profile' && sheet.open ? sheet.querySelector('[name=revision]') : null;
  if (revision && Number(revision.value) === Number(values.revision)) revision.value = profile.revision;
  if (job.current()) {
    // A later draft keeps its text but must use the revision just committed.
    toast('个人资料已保存');
  }
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
  await edits.run(async (_, job) => {
    const next = structuredClone(state); next.groups = next.groups.filter((item) => item !== group); next.books.forEach((book) => { if (book.category === group) book.category = '堆放'; }); await commit(next);
    if (job.unchanged()) manageGroups();
    return false;
  }, () => null);
}

async function saveBookMeta(values, job, coverFile) {
  if (values.reading_started_at && values.reading_finished_at && values.reading_finished_at < values.reading_started_at) throw new Error('结束阅读时间不能早于开始阅读时间。');
  const cover = coverFile ? await normalizeCover(coverFile) : null;
  const next = structuredClone(state);
  const book = next.books.find((item) => item.book_id === job.bookId);
  Object.assign(book, { title: values.title.trim(), author: values.author.trim(), category: values.category.trim() || '堆放', publisher: values.publisher.trim(), reading_status: values.reading_status || '', reading_started_at: values.reading_started_at || '', reading_finished_at: values.reading_finished_at || '' });
  if (cover) book.cover_data = cover;
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

async function saveUpload(values, replacing, job, file) {
  const operationId = job.operationId;
  const title = values.title?.trim() || file.name.replace(/\.(txt|md|markdown|html?|docx?|pdf|epub|mobi|azw3?)$/i, '');
    if (replacing) {
      const book = state.books.find(item => item.book_id === job.bookId);
      const previousDoc = state.documents.find(item => item.document_id === job.documentId);
      const doc = await makeDocument(file, book.book_id, (previousDoc?.version || 0) + 1);
      doc.document_id = `doc_${operationId}`;
      const next = structuredClone(state); next.documents.push(doc); next.books.find((item) => item.book_id === book.book_id).current_document_id = doc.document_id; await commit(next);
      if (job.unchanged() && bookId === book.book_id && view === job.view && activeDocumentId === job.activeDocumentId) {
        activeDocumentId = doc.document_id; chapterIndex = 0;
        history.replaceState({ readingNav: navState(), readingStack: [...navigationStack] }, '', location.href);
        render();
      }
    } else {
      const doc = await makeDocument(file, `book_${operationId}`);
      doc.document_id = `doc_${operationId}`;
      const book = createBook(doc, title); Object.assign(book, { author: values.author?.trim(), category: values.category?.trim() || '堆放', publisher: values.publisher?.trim() });
      const next = structuredClone(state); next.documents.push(doc); next.books.push(book); await commit(next);
      if (job.unchanged()) { navigate('journal', { bookId: book.book_id, activeDocumentId: doc.document_id, chapterIndex: 0, journalTab: 'original' }); render(); }
    }
    return true;
}

function searchReader() { const query = prompt('在本章原文中查找：', readerSearch); if (query === null) return; readerSearch = query.trim(); render(); }

function annotateSelection(discuss) {
  if (!selection?.exact.trim()) return toast('请先选中一段原文');
  modal(discuss ? '围绕这段原文讨论' : '摘抄与见解', `<div class="selection-preview">${esc(selection.exact)}</div>${discuss ? '<label>议题<input name="topic" maxlength="80" required placeholder="想和AI讨论什么？"></label>' : ''}<label>${discuss ? '我的开场' : '我的见解'}<textarea name="insight" placeholder="这段文字让我想到……" required></textarea></label><input type="hidden" name="discuss" value="${discuss ? 'yes' : 'no'}">`, 'annotation');
}

async function saveAnnotation(values, job) {
  const doc = state.documents.find(item => item.document_id === job.documentId);
  const next = structuredClone(state);
  const note = createAnnotation(job.bookId, doc, makeAnchor(doc.text, job.selection.start, job.selection.end), values.insight.trim()); note.annotation_id = `note_${job.operationId}`; note.purpose = values.discuss === 'yes' ? 'discussion' : 'excerpt'; next.annotations.push(note);
  if (values.discuss === 'yes') { const thread = { thread_id: `thread_${job.operationId}`, book_id: job.bookId, annotation_id: note.annotation_id, document_id: note.document_id, status: 'open', topic: values.topic.trim(), created_at: new Date().toISOString(), messages: [createThreadMessage('me', values.insight.trim())] }; note.thread_id = thread.thread_id; next.threads.push(thread); }
  await commit(next);
  if (job.unchanged()) { selection = null; returnToBookTab(values.discuss === 'yes' ? 'discussion' : 'excerpt'); }
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
  modal('文件与版本', `<div class="file-list">${docs.map((doc) => `<article><div><strong>版本 ${doc.version} · ${formatLabel(doc.format)}</strong><small>${esc(doc.filename || doc.file_name || '未命名')} · ${doc.reading_status === 'ready' ? '可精准摘抄' : '原件模式'} · ${doc.document_id.slice(0, 12)}…</small></div><div>${doc.format === 'pdf' ? btn('查看', 'view-original', 'text-btn', `data-doc="${doc.document_id}"`) : ''}${btn(icon('download'), 'download-original', 'icon-btn', `data-doc="${doc.document_id}" aria-label="下载版本 ${doc.version} 原件" title="下载原件"`)}</div></article>`).join('')}</div><p class="field-note">每个版本保留独立 document_id；旧标注继续指向当时的文件。</p>`, '');
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
  void renderShare();
}

async function renderShare() {
  const draft = share, operationId = sheet.dataset.operationId, version = ++shareDrawVersion;
  const note = findNote(draft.noteKey);
  const book = state.books.find((item) => item.book_id === note.book_id);
  const canvas = $('#note-canvas'), scratch = document.createElement('canvas'), save = sheet.querySelector('[data-action=save-note-image]');
  if (save) save.disabled = true;
  let result;
  try { result = await drawNote(scratch, book, note, draft.style, draft.page); }
  catch (error) { if (sheet.open && operationId === sheet.dataset.operationId && version === shareDrawVersion) toast(error.message || '便签图片生成失败，请重新打开。'); return; }
  if (!sheet.open || operationId !== sheet.dataset.operationId || share !== draft || version !== shareDrawVersion) return;
  canvas.width = scratch.width; canvas.height = scratch.height; canvas.getContext('2d').drawImage(scratch, 0, 0);
  if (save) save.disabled = false;
  share.pages = result.pages; share.page = result.page;
  $('#paper-page').textContent = `${share.page + 1} / ${share.pages}`;
  document.querySelectorAll('[data-action="paper-style"]').forEach((button) => button.classList.toggle('active', button.dataset.value === share.style));
}

function saveShareImage() { const canvas = $('#note-canvas'); canvas.toBlob((blob) => { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `共读岛-摘录-${share.page + 1}.png`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }, 'image/png'); }
function toast(message, outside = false) { const element = document.createElement('div'); element.className = 'toast'; element.textContent = message; element.setAttribute('role', 'status'); element.setAttribute('popover', 'manual'); (sheet.open && !outside ? sheet : document.body).append(element); if (typeof element.showPopover === 'function') element.showPopover(); else if (sheet.open && !outside) sheet.append(element); setTimeout(() => element.remove(), 4000); }

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

function openCatalogWorkflow(){
    if(sheet.open)sheet.close();
    openBookCatalog({groups:state.group_records||[],onImported:async()=>{
      libraryWriteGeneration++;
      const snapshot=await cloud.load({shelfOnly:true});
      state={...state,books:snapshot.books,groups:snapshot.groups,group_records:snapshot.group_records};
      cloudDetailsLoaded=false;render();
    }});
}
async function navigateFromDrawer(action){try{await ensureLibraryDetails();if(action==='search-books')openCatalogWorkflow();if(action==='manage-groups')manageGroups();if(action==='reader-profile')await openReaderProfile();if(action==='all-notes'){navigate('notes',{filter:'all'});render();}}catch(error){toast(error.message);}}
