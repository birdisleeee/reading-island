import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {journalView,chapterResumeIndex,captureChapterDirectory,restoreChapterDirectory,jumpToReadChapter} from '../web/visual.mjs';

const book={book_id:'original_book',title:'原创章节测试',current_document_id:'original_doc'};
const makeDoc=(progress={})=>({document_id:'original_doc',reading_status:'ready',reading_progress:progress,chapters:Array.from({length:5},(_,i)=>({title:'第'+(i+1)+'章',start:i*100,end:(i+1)*100}))});
function fixture(doc,layout){
  const {document,window}=parseHTML('<html><body><main id="app"></main></body></html>');
  window.getComputedStyle=element=>({paddingBottom:element.style.paddingBottom||'60px'});
  const app=document.querySelector('#app');app.innerHTML=journalView(book,[],[],'original',doc);
  geometry(app,layout);return app;
}
// Model a finite scroll viewport, including normal browser scrollTop clamping.
function geometry(app,{height=300,contentHeight=456,viewportTop=100,firstTop=56,rowStep=80}={}){
  const scroller=app.querySelector('.journal-content'),list=app.querySelector('.chapter-list');if(!list)return;
  let top=0;Object.defineProperties(scroller,{clientTop:{value:0},clientHeight:{value:height},scrollHeight:{get:()=>Math.max(height,contentHeight+(parseFloat(list.style.paddingBottom)||60))},scrollTop:{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,scroller.scrollHeight-height));}}});
  scroller.getBoundingClientRect=()=>({top:viewportTop});
  for(const card of list.querySelectorAll('[data-index]'))card.getBoundingClientRect=()=>({top:viewportTop+firstTop+Number(card.dataset.index)*rowStep-scroller.scrollTop});
}

test('chapter cards show only read/unread state while preserving chapter order and separate excerpt counts',()=>{
  const doc=makeDoc({visited_starts:[0,200],last_start:300}),app=fixture(doc);
  app.innerHTML=journalView(book,[{document_id:doc.document_id,anchor:{start:215},purpose:'excerpt'}],[],'original',doc);
  const cards=[...app.querySelectorAll('.chapter-card')];
  assert.deepEqual(cards.map(card=>card.dataset.index),['0','1','2','3','4']);
  assert.deepEqual(cards.map(card=>card.querySelector('em>span').textContent),['已读','未读','已读','已读','未读']);
  assert.equal(cards[2].querySelector('em small').textContent,' · 1 条摘录');
  assert(!/打开阅读|最近阅读|已读过/.test(app.textContent));
  assert.equal(app.querySelector('.reader-screen'),null);
  assert.equal(app.querySelectorAll('.journal-bottom button').length,1);
  assert.equal(app.querySelector('.journal-bottom button').textContent,'跳到已读章节');
  assert.equal(app.querySelector('.journal-bottom [data-action="book-files"]'),null);
  assert.equal(app.querySelector('.journal-bottom [data-action="replace-book"]'),null);
});

test('resume uses the actual last chapter, accepts chapter zero, and falls back only to existing visited chapters',()=>{
  assert.equal(chapterResumeIndex(makeDoc()),-1);
  assert.equal(chapterResumeIndex(makeDoc({visited_starts:[100,300],last_start:100})),1,'a revisit is more recent than the greatest position');
  assert.equal(chapterResumeIndex(makeDoc({visited_starts:[100,300],last_start:0})),0);
  assert.equal(chapterResumeIndex(makeDoc({visited_starts:[100,300,999],last_start:999})),3,'removed chapter positions cannot become an invalid row');
});

test('opening stays at the natural start; only the explicit action aligns the latest read chapter',()=>{
  const doc=makeDoc({visited_starts:[400],last_start:400}),app=fixture(doc),before=doc.chapters.map(chapter=>chapter.start);
  restoreChapterDirectory(app,doc,null);
  assert.equal(app.querySelector('.journal-content').scrollTop,0);
  const progress=structuredClone(doc.reading_progress);
  assert.equal(jumpToReadChapter(app,doc),true);
  const scroller=app.querySelector('.journal-content'),card=app.querySelector('[data-index="4"]');
  assert.equal(card.getBoundingClientRect().top,scroller.getBoundingClientRect().top);
  assert.equal(scroller.scrollTop,376);assert(parseFloat(app.querySelector('.chapter-list').style.paddingBottom)>60);
  assert.deepEqual(doc.chapters.map(chapter=>chapter.start),before,'resuming must not reorder the document');
  assert.deepEqual(doc.reading_progress,progress,'jumping must not mark a chapter read');
});

test('a never-read directory keeps its heading and first chapter at the natural starting position',()=>{
  const doc=makeDoc(),app=fixture(doc);restoreChapterDirectory(app,doc,null);
  assert.equal(app.querySelector('.journal-content').scrollTop,0);
  assert.equal(app.querySelector('.chapter-list').style.paddingBottom,'');
  assert.equal(jumpToReadChapter(app,doc),false);
  assert.equal(app.querySelector('.journal-bottom button').hasAttribute('disabled'),true);
});

test('a short two-chapter directory aligns the recent row when scrollHeight initially equals clientHeight',()=>{
  const doc=makeDoc({visited_starts:[100],last_start:100});doc.chapters=doc.chapters.slice(0,2);
  const layout={height:420,contentHeight:287.14,viewportTop:401.39,firstTop:76.29,rowStep:80},app=fixture(doc,layout);
  const scroller=app.querySelector('.journal-content'),list=app.querySelector('.chapter-list'),card=app.querySelector('[data-index="1"]');
  assert.equal(scroller.scrollHeight,scroller.clientHeight,'a non-overflowing element conceals its actual content height');
  list.style.paddingBottom='216.29px';scroller.scrollTop=156.29;
  assert(Math.abs(scroller.scrollTop-83.43)<.01,'the fixture reproduces the insufficient-padding failure');
  list.style.paddingBottom='';scroller.scrollTop=0;
  jumpToReadChapter(app,doc);
  assert(Math.abs(scroller.scrollTop-156.29)<.01,'short content must not clamp the required 156.29px position to 83.43px');
  assert(Math.abs(card.getBoundingClientRect().top-scroller.getBoundingClientRect().top)<.01);
  const minimumPadding=layout.height+156.29-layout.contentHeight;
  assert(parseFloat(list.style.paddingBottom)>=minimumPadding);
  assert(parseFloat(list.style.paddingBottom)<=minimumPadding+1.01,'the temporary viewport padding must be reduced after measuring overflow');
});

test('refreshing the same directory preserves user scrolling rather than repeatedly snapping to progress',()=>{
  const doc=makeDoc({visited_starts:[400],last_start:400}),app=fixture(doc);jumpToReadChapter(app,doc);
  app.querySelector('.journal-content').scrollTop=160;
  const previous=captureChapterDirectory(app),updated=makeDoc({visited_starts:[100,400],last_start:100});
  app.innerHTML=journalView(book,[],[],'original',updated);geometry(app);restoreChapterDirectory(app,updated,previous);
  assert.equal(app.querySelector('.journal-content').scrollTop,160);
  assert.equal(app.querySelector('.chapter-list').style.paddingBottom,previous.paddingBottom);
});

test('late metadata and returning from reader do not jump until explicitly requested',async()=>{
  const app=fixture(null);assert.equal(captureChapterDirectory(app),null);restoreChapterDirectory(app,null,null);
  await Promise.resolve();const doc=makeDoc({visited_starts:[200],last_start:200});
  app.innerHTML=journalView(book,[],[],'original',doc);geometry(app);restoreChapterDirectory(app,doc,null);
  assert.equal(app.querySelector('.journal-content').scrollTop,0);
  app.innerHTML='<section class="reader-screen"></section>';const previous=captureChapterDirectory(app);assert.equal(previous,null);
  doc.reading_progress={visited_starts:[200,300],last_start:300};
  app.innerHTML=journalView(book,[],[],'original',doc);geometry(app);restoreChapterDirectory(app,doc,previous);
  assert.equal(app.querySelector('.journal-content').scrollTop,0);assert(app.querySelector('.journal-screen'));assert.equal(app.querySelector('.reader-screen'),null);
  jumpToReadChapter(app,doc);assert.equal(app.querySelector('.journal-content').scrollTop,296);
});

test('another document version does not inherit the previous version directory scroll',()=>{
  const doc=makeDoc({visited_starts:[100],last_start:100}),app=fixture(doc);
  restoreChapterDirectory(app,doc,{documentId:'older_doc',top:300,paddingBottom:'500px'});
  assert.equal(app.querySelector('.journal-content').scrollTop,0);
});
