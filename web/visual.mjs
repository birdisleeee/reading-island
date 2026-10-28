import { renderMarkdown } from './markdown.mjs';
export const escapeHTML = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const e = escapeHTML;
const paths = { back: 'm15 18-6-6 6-6', add: 'M12 5v14M5 12h14', menu: 'M4 7h16M4 12h16M4 17h16', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', share: 'M12 16V3m-4 4 4-4 4 4M6 10H4v11h16V10h-2', edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z', book: 'M12 5C8 2 4 3 2 4v16c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Zm0 0v16', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', chat: 'M21 11a9 8 0 0 1-9 8H7l-5 3 2-6a8 8 0 1 1 17-5Z' };
export function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`; }
export function btn(label, action, cls = '', attrs = '') { return `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`; }

function bookCover(book) {
  return `<div class="book-cover default-cover"><img data-cover-book="${e(book.book_id)}" src="${e(book.cover_data || '/reading-island/assets/default-cover.svg')}" alt="${e(book.title)}封面"><div class="cover-type"><strong>${e(book.title)}</strong><small>${e(book.author || '共读岛')}</small></div></div>`;
}

function readingStatusLabel(value) {
  return value === 'reading' ? '阅读中' : value === 'finished' ? '已阅' : '未读';
}

export function shelfView(books, groups, query = '', menuOpen = false,collapsed=new Set()) {
  const normalized = query.trim().toLowerCase();
  const visible = books.filter((book) => `${book.title}${book.author || ''}${book.category || ''}`.toLowerCase().includes(normalized));
  const categories = groups?.length ? groups : ['堆放'];
  return `<section class="shelf-screen">
    <header class="shelf-top"><span class="shelf-heading-spacer" aria-hidden="true"></span><h1>共读岛</h1><div class="shelf-menu-wrap">${btn(icon('menu'), 'toggle-menu', 'icon-btn', `aria-label="书架菜单" aria-expanded="${menuOpen}"`)}${menuOpen ? `<div class="shelf-menu"><button type="button" data-action="manage-groups">管理分组 ${icon('add')}</button><button type="button" data-action="all-notes">全部札记</button><button type="button" data-action="reader-profile">登录资料</button></div>` : ''}</div></header>
    <label class="search-box">${icon('search')}<input id="shelf-search" value="${e(query)}" placeholder="搜索书籍内容……" aria-label="搜索书籍"></label>
    <div class="library-hero object-cluster"><img src="/reading-island/assets/reading-cluster.svg" alt="书架插图"></div>
    <div class="shelf-books" aria-label="分类书架">${categories.map((category) => { const group = visible.filter((book) => (book.category || '堆放') === category); return `<section class="shelf-section" data-group="${e(category)}"><header class="shelf-label"><h2>${btn(e(category), 'open-group', 'group-title', `data-group="${e(category)}"`)}</h2>${btn('<svg class="icon collapse-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>', 'toggle-group', 'group-more', `data-group="${e(category)}" aria-expanded="${!collapsed.has(category)}" aria-label="展开或收起${e(category)}"`)}</header><div class="book-grid book-strip" ${collapsed.has(category)?'hidden':''}>${group.map((book) => `<button class="book-tile" type="button" data-action="open-book" data-book="${book.book_id}">${bookCover(book)}<strong>${e(book.title)}</strong><small>${e(book.author || '作者待补')} · ${readingStatusLabel(book.reading_status)}</small></button>`).join('') || '<p class="group-empty">这里还没有书</p>'}</div></section>`; }).join('') || '<p class="empty-copy">没有找到这本书。</p>'}</div>
    ${btn(icon('add'), 'add-book', 'book-fab', 'aria-label="添加书籍"')}
  </section>`;
}

const shelfContents=new WeakMap();
// A shelf refresh must not disconnect its decoded artwork or active search field.
export function updateShelfView(container,markup){
  const template=container.ownerDocument.createElement('template');template.innerHTML=markup;
  const next=template.content.firstElementChild,current=container.querySelector(':scope > .shelf-screen');
  const books=current?.querySelector('.shelf-books'),nextBooks=next.querySelector('.shelf-books');
  if(!current||!books||!current.querySelector('.library-hero')){
    container.replaceChildren(next);shelfContents.set(nextBooks,nextBooks.innerHTML);return;
  }
  const menu=current.querySelector('.shelf-menu-wrap'),nextMenu=next.querySelector('.shelf-menu-wrap');
  if(menu.innerHTML!==nextMenu.innerHTML)menu.replaceChildren(...nextMenu.childNodes);
  const input=current.querySelector('#shelf-search'),nextInput=next.querySelector('#shelf-search');
  if(input.value!==nextInput.value)input.value=nextInput.value;
  const content=nextBooks.innerHTML;
  if(shelfContents.get(books)!==content){
    const top=books.scrollTop,positions=new Map([...books.querySelectorAll('.shelf-section')].map(section=>[section.dataset.group,section.querySelector('.book-strip')?.scrollLeft||0]));
    books.replaceChildren(...nextBooks.childNodes);books.scrollTop=top;
    for(const section of books.querySelectorAll('.shelf-section'))section.querySelector('.book-strip').scrollLeft=positions.get(section.dataset.group)||0;
    shelfContents.set(books,content);
  }
}

export function groupView(books, groupName = '堆放') {
  const group = books.filter((book) => (book.category || '堆放') === groupName);
  return `<section class="group-screen">
    <header class="group-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<div><h1>${e(groupName)}</h1><small>${group.length} 本书</small></div><span class="head-spacer"></span></header>
    <div class="group-library">${group.map((book) => `<button class="book-tile" type="button" data-action="open-book" data-book="${book.book_id}">${bookCover(book)}<strong>${e(book.title)}</strong><small>${e(book.author || '作者待补')} · ${readingStatusLabel(book.reading_status)}</small></button>`).join('') || '<p class="empty-copy">这里还没有书。</p>'}</div>
  </section>`;
}

export function journalView(book, notes, threads, activeTab = 'excerpt', doc = null) {
  if (!book) return '<section class="empty"><h2>没有找到这本书</h2></section>';
  const bookThreads = threads.filter((thread) => thread.book_id === book.book_id || notes.some((note) => note.thread_id === thread.thread_id));
  const excerpts = notes.filter(note => note.purpose !== 'discussion');
  const panels = {
    excerpt: `<div class="journal-list">${excerpts.length ? excerpts.map(journalCard).join('') : '<div class="journal-empty">还没有摘录。<br>翻开原文，留住让你停下来的那一句。</div>'}</div>`,
    original: chapterPanel(doc, notes),
    discussion: discussionPanel(book, bookThreads, notes),
  };
  return `<section class="journal-screen" data-book="${e(book.book_id)}">
    <header class="journal-head">${btn(icon('back'), 'back', 'icon-btn', 'aria-label="返回上一层"')}<h1>阅读笔记</h1>${btn('编辑', 'book-options', 'text-btn')}</header>
    <div class="book-profile"><div class="book-facts">${bookCover(book)}<dl><div><dt>书名</dt><dd>《${e(book.title)}》</dd></div><div><dt>作者</dt><dd>${e(book.author || '待填写')}</dd></div><div><dt>出版社</dt><dd>${e(book.publisher || '待填写')}</dd></div><div><dt>分组</dt><dd>${e(book.category || '堆放')}</dd></div><div><dt>阅读状态</dt><dd>${readingStatusLabel(book.reading_status)}</dd></div><div><dt>开始阅读</dt><dd>${e(book.reading_started_at || '未设置')}</dd></div><div><dt>结束阅读</dt><dd>${e(book.reading_finished_at || '未设置')}</dd></div></dl></div></div>
    <nav class="journal-tabs"><button class="${activeTab === 'excerpt' ? 'active' : ''}" type="button" data-action="journal-tab" data-value="excerpt">摘录 ${excerpts.length}</button><button class="${activeTab === 'original' ? 'active' : ''}" type="button" data-action="journal-tab" data-value="original">原文</button><button class="${activeTab === 'discussion' ? 'active' : ''}" type="button" data-action="journal-tab" data-value="discussion">讨论 ${bookThreads.length}</button></nav>
    <div class="journal-content">${panels[activeTab] || panels.excerpt}</div>
    <div class="journal-bottom">${btn('跳到已读章节', 'jump-read-chapter', '', chapterResumeIndex(doc)<0?'disabled title="还没有已读章节"':'')}</div>
  </section>`;
}

const journalContents=new WeakMap();
function journalRegionSignature(node){const copy=node.cloneNode(true);if(node.classList.contains('book-profile'))copy.querySelectorAll('[data-cover-book]').forEach(image=>image.removeAttribute('src'));return copy.innerHTML;}
// Tabs share one connected profile and cover; only changed regions are replaced.
export function updateJournalView(container,markup){
  const template=container.ownerDocument.createElement('template');template.innerHTML=markup;
  const next=template.content.firstElementChild,current=container.querySelector(':scope > .journal-screen');
  if(!current||!next?.matches('.journal-screen')||current.dataset.book!==next.dataset.book){
    container.replaceChildren(next);
    if(next?.matches('.journal-screen'))journalContents.set(next,new Map([...next.children].map(node=>[node.className,journalRegionSignature(node)])));
    return;
  }
  const signatures=journalContents.get(current)||new Map();
  for(const replacement of [...next.children]){
    const region=replacement.className,existing=region==='journal-bottom'?container.querySelector(':scope > .journal-bottom')||current.querySelector('.journal-bottom'):[...current.children].find(node=>node.className===region);
    const signature=journalRegionSignature(replacement);
    if(existing&&signatures.get(region)===signature){
      if(region==='book-profile'){const image=existing.querySelector('[data-cover-book]'),source=replacement.querySelector('[data-cover-book]')?.getAttribute('src');if(image&&source&&image.getAttribute('src')!==source)image.src=source;}
      continue;
    }
    if(existing)existing.replaceWith(replacement);else current.append(replacement);
    signatures.set(region,signature);
  }
  journalContents.set(current,signatures);
}

function journalCard(note) {
  const key = `${note.document_id}:${note.annotation_id}`;
  return `<article class="journal-entry" data-action="note-detail" data-note="${key}" tabindex="0" role="button"><blockquote>${e(note.anchor.exact)}</blockquote>${note.insight ? `<p class="insight">${e(note.insight)}</p>` : ''}<footer><span>${e((note.created_at || '').slice(0, 10))} · 文档 v${note.document_version}</span><span>仅摘抄</span></footer><div class="entry-actions">${btn(icon('share'), 'share-note', 'tiny-btn', `data-note="${key}"`)}${btn('在原文查看', 'open-note', 'text-btn', `data-note="${key}"`)}</div></article>`;
}

export function chapterResumeIndex(doc) {
  const chapters = doc?.chapters || [], progress = doc?.reading_progress || {};
  const recent = chapters.findIndex(chapter => chapter.start === progress.last_start);
  if (recent >= 0) return recent;
  for (const start of [...(progress.visited_starts || [])].reverse()) {
    const index = chapters.findIndex(chapter => chapter.start === start);
    if (index >= 0) return index;
  }
  return -1;
}

export function captureChapterDirectory(container) {
  const list = container.querySelector('.chapter-list[data-document]'), scroller = list?.closest('.journal-content');
  return scroller ? { documentId: list.dataset.document, top: scroller.scrollTop, paddingBottom: list.style.paddingBottom } : null;
}

// Only preserve a directory which is already open; entering it never jumps.
export function restoreChapterDirectory(container, doc, previous) {
  const list = container.querySelector('.chapter-list[data-document]'), scroller = list?.closest('.journal-content');
  if (!scroller || !doc || list.dataset.document !== doc.document_id) return;
  if (previous?.documentId === doc.document_id) {
    list.style.paddingBottom = previous.paddingBottom || '';
    scroller.scrollTop = previous.top;
  }
}

// Progress is used only by the explicit jump action, without marking anything read.
export function jumpToReadChapter(container,doc){
  const list=container.querySelector('.chapter-list[data-document]'),scroller=list?.closest('.journal-content'),index=chapterResumeIndex(doc);
  if(!scroller||doc?.reading_status!=='ready'||list.dataset.document!==doc.document_id||index<0)return false;
  const card=list.querySelector(`[data-index="${index}"]`);if(!card)return false;
  const top = Math.max(0, card.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop);
  const missing = Math.max(0, top - (scroller.scrollHeight - scroller.clientHeight));
  if (missing) {
    const padding = parseFloat(container.ownerDocument.defaultView.getComputedStyle(list).paddingBottom) || 0;
    // scrollHeight never reports less than clientHeight. Make short content
    // overflow first, then trim the extra padding using its actual scroll range.
    const expanded=padding+scroller.clientHeight;
    list.style.paddingBottom = `${expanded}px`;
    const excess=Math.max(0,scroller.scrollHeight-scroller.clientHeight-top);
    list.style.paddingBottom = `${Math.max(padding,expanded-excess+1)}px`;
  }
  scroller.scrollTop = top;
  return true;
}

function chapterPanel(doc, notes) {
  if (!doc) return '<div class="journal-empty">还没有可阅读的文件。</div>';
  const rows = doc.reading_status === 'ready' ? (doc.chapters || []).map((chapter, index) => {
    const excerptCount = notes.filter((note) => note.purpose !== 'discussion' && note.document_id === doc.document_id && note.anchor.start >= chapter.start && note.anchor.start < chapter.end).length;
    const progress = doc.reading_progress || {};
    const visited = progress.visited_starts?.includes(chapter.start) || progress.last_start === chapter.start;
    return `<button class="chapter-card ${visited ? 'chapter-visited' : ''}" type="button" data-action="open-chapter" data-index="${index}"><span><small>${String(index + 1).padStart(2, '0')}</small><strong>${e(chapter.title)}</strong></span><em><span>${visited ? '已读' : '未读'}</span>${excerptCount ? `<small> · ${excerptCount} 条摘录</small>` : ''}</em></button>`;
  }).join('') : `<button class="chapter-card" type="button" data-action="open-chapter" data-index="0"><span><small>原件</small><strong>${e(doc.filename || doc.file_name)}</strong></span><em>打开 ›</em></button>`;
  const source = doc.reading_status === 'ready' ? `${doc.chapters?.length || 0} 章 · ${doc.chapters?.[0]?.source === 'manual' ? '手动设置' : doc.chapters?.[0]?.source === 'epub-spine' ? '沿用 EPUB 目录' : '自动识别'}` : '原件模式';
  return `<section class="journal-panel chapter-panel"><header><div><h2>原文章节</h2><small>${source}</small></div>${doc.reading_status === 'ready' ? btn('设置章节', 'chapter-settings', 'primary') : ''}</header><div class="chapter-list" ${doc.reading_status === 'ready' && doc.chapters?.length ? `data-document="${e(doc.document_id)}"` : ''}>${rows}</div></section>`;
}

function discussionPanel(book, bookThreads, notes) {
  const cards = bookThreads.map((thread) => {
    const note = notes.find((item) => item.annotation_id === thread.annotation_id);
    const opening = thread.messages?.[0]?.text || note?.insight || '';
    const context = note ? `<blockquote>${e(note.anchor.exact)}</blockquote>` : `<p class="book-topic-context">全书议题 · 《${e(book.title)}》</p>`;
    return `<article class="discussion-card" data-action="open-thread" data-thread="${thread.thread_id}" tabindex="0" role="button"><header><span>${thread.status === 'open' ? '讨论中' : '已结束'}</span><small>${e((thread.created_at || note?.created_at || '').slice(0, 10))}</small></header><h2>${e(thread.topic || (note ? '围绕这段原文' : '围绕整本书'))}</h2>${context}${opening ? `<div class="discussion-opening markdown-body"><span>${thread.messages?.[0]?.author === 'assistant' ? 'AI的开场：' : '我的开场：'}</span>${renderMarkdown(opening)}</div>` : ''}<footer><span>${note ? `文档 v${note.document_version}` : '全书议题'}</span><span>${thread.messages?.length || 0} 条回复</span></footer></article>`;
  }).join('');
  return `<section class="journal-panel discussion-panel"><div class="discussion-lead"><div class="discussion-lead-title"><img src="/reading-island/assets/discussion-bird.svg" alt="讨论图标"><h2>这本书的讨论</h2></div>${btn('＋ 发起议题', 'start-discussion', 'secondary')}</div><div class="discussion-list">${cards || '<div class="journal-empty">还没有议题。<br>发起一张属于这本书的讨论卡。</div>'}</div></section>`;
}

const paperStyles = {
  cotton: { fill: '#faf9f5', ink: '#35342f' },
  sand: { fill: '#c7b18b', ink: '#3c342a' },
  sage: { fill: '#aeb7a2', ink: '#283128' },
  ink: { fill: '#173b63', ink: '#f5f0dc' },
};

function wrapText(context, text, width) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const char of Array.from(paragraph)) {
      if (line && context.measureText(line + char).width > width) { lines.push(line); line = char; } else line += char;
    }
    lines.push(line);
  }
  return lines;
}

export async function drawNote(canvas, book, note, styleName, page = 0) {
  await document.fonts.ready;
  const style = paperStyles[styleName] || paperStyles.cotton;
  const context = canvas.getContext('2d');
  canvas.width = 960; canvas.height = 1200;
  context.font = '42px "KaiTi", "STKaiti", serif';
  const lines = wrapText(context, note.anchor.exact, 710);
  const perPage = 12;
  const pages = Math.max(1, Math.ceil(lines.length / perPage));
  page = Math.min(page, pages - 1);
  context.clearRect(0, 0, 960, 1200);
  const texture = new Image(); texture.src = '/reading-island/assets/paper.svg'; await texture.decode();
  context.save(); context.beginPath(); context.moveTo(55, 100); context.lineTo(905, 100); context.lineTo(905, 1095); context.lineTo(875, 1125); context.lineTo(55, 1125); context.closePath(); context.shadowColor = '#34261630'; context.shadowBlur = 23; context.shadowOffsetY = 12; context.fillStyle = style.fill; context.fill(); context.shadowColor = 'transparent'; context.clip(); context.globalAlpha = .38; context.globalCompositeOperation = 'multiply'; context.drawImage(texture, 55, 100, 850, 1030); context.restore();
  context.save(); context.translate(480, 105); context.rotate(-.035); context.fillStyle = '#d7c49d99'; context.fillRect(-132, -29, 264, 65); context.restore();
  context.fillStyle = style.ink; context.font = '42px "KaiTi", "STKaiti", serif'; context.textBaseline = 'top'; lines.slice(page * perPage, (page + 1) * perPage).forEach((line, index) => context.fillText(line, 125, 210 + index * 58));
  context.textAlign = 'right'; context.font = '30px "KaiTi", "STKaiti", serif'; context.fillText(`——《${book.title}》`, 835, 975); context.font = '23px Georgia, serif'; context.fillText((note.created_at || '').slice(0, 10).replaceAll('-', '.'), 835, 1055);
  if (pages > 1) { context.textAlign = 'left'; context.fillText(`${page + 1} / ${pages}`, 125, 1055); }
  return { pages, page };
}
