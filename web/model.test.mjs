import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, resolveAnnotation, anchor, verifyAnchor, discussionContext, MAX_BYTES } from './model.mjs';
import { detectChapterRanges, normalizeChapterRanges } from '../src/core/document-formats.mjs';
test('original bytes remain intact while canonical newline offsets are stable', async()=>{
  const raw=new TextEncoder().encode('\uFEFF第一行\r\n重复句。\r重复句。🙂尾声');
  const d=await makeDocument(new File([raw],'sample.txt'),'book1');
  assert.deepEqual(new Uint8Array(await d.original.arrayBuffer()),raw);
  assert.equal(d.text,'第一行\n重复句。\n重复句。🙂尾声');
  const start=d.text.lastIndexOf('重复句。');const a=anchor(d,start,d.text.length);
  assert.equal(verifyAnchor(d,a).start,start);
  assert.equal(a.exact,'重复句。🙂尾声');
  assert.throws(()=>anchor(d,d.text.indexOf('🙂')+1,d.text.length));
});
test('new version cannot reinterpret an old anchor, even with identical text',async()=>{
  const d=await makeDocument(new File(['重复\n重复'],'a.txt'),'book1');
  const a=anchor(d,3,5);
  const v2=await makeDocument(new File(['重复\n重复'],'a.txt'),'book1');
  assert.throws(()=>verifyAnchor(v2,a));
  assert.throws(()=>verifyAnchor(d,{...a,exact:'错误'}));
  assert.throws(()=>verifyAnchor(d,{...a,start:-1}));
  assert.throws(()=>verifyAnchor(d,{...a,prefix:'错误'}));
  assert.equal(verifyAnchor(d,a).exact,'重复');
});
test('discussion retains book, version, quote, context, insight and all replies',async()=>{
  const d=await makeDocument(new File(['上文\n引用\n下文'],'a.txt'),'book1');
  const n={book_id:'book1',annotation_id:'n1',anchor:anchor(d,3,5),insight:'我的见解',messages:[{text:'继续想'},{text:'新的问题'}],status:'open'};
  const c=discussionContext({book_id:'book1',title:'书'},d,n);
  assert.equal(c.context.quote,'引用');assert.equal(c.context.before,'上文\n');assert.equal(c.context.after,'\n下文');
  assert.equal(c.insight,'我的见解');assert.equal(c.discussion.length,2);assert.equal(c.document.document_id,d.document_id);
  c.discussion[0].text='changed';assert.equal(n.messages[0].text,'继续想');
  assert.throws(()=>discussionContext({book_id:'other',title:'书'},d,n));
});
test('invalid format, encoding, empty text and oversize content are rejected',async()=>{
  for(const file of [new File(['test'],'a.exe'),new File([new Uint8Array([255,254,0])],'a.txt'),new File(['   '],'a.txt'),new File(['a\u0000b'],'a.txt'),new File([new Uint8Array(MAX_BYTES+1)],'a.txt')])await assert.rejects(makeDocument(file,'book1'));
});
test('PDF and Kindle formats preserve the original with precise annotation disabled',async()=>{
  for(const name of ['sample.pdf','sample.mobi','sample.azw3']){
    const doc=await makeDocument(new File(['original bytes'],name),'book1');
    assert.equal(doc.reading_status,'original-only');assert.equal(doc.text,'');assert.equal(doc.original.size,14);
  }
});
test('chapter detection and manual boundaries stay inside the frozen text',async()=>{
  const text='前言\n先说几句。\n\n第一章 出发\n海风吹来。\n\n第二章 归来\n灯亮了。';
  const detected=detectChapterRanges(text);
  assert.deepEqual(detected.map((chapter)=>chapter.title),['前言','第一章 出发','第二章 归来']);
  assert.equal(detected[0].start,0);assert.equal(detected.at(-1).end,text.length);
  const manual=normalizeChapterRanges(text,[{title:'上篇',start:0},{title:'下篇',start:text.indexOf('第二章')}]);
  assert.equal(manual[0].end,manual[1].start);assert.equal(manual[1].end,text.length);
  assert.throws(()=>normalizeChapterRanges(text,[{title:'缺少开头',start:2}]));
  const doc=await makeDocument(new File([text],'chapters.txt'),'book1');
  assert.equal(doc.chapters.length,3);assert.ok(doc.chapters.every((chapter)=>chapter.chapter_id));
});

test('cloud anchors locate the exact occurrence and reject mismatched frozen identity',async()=>{
  const doc=await makeDocument(new File(['same paragraph\nother\nsame paragraph'],'a.txt'),'book1');
  const start=doc.text.lastIndexOf('same');
  const note={document_id:doc.document_id,document_version:doc.version,text_sha256:doc.text_sha256,anchor:{start,end:doc.text.length,exact:'same paragraph'}};
  assert.deepEqual(resolveAnnotation(note,doc),{found:true,start,end:doc.text.length,exact:'same paragraph'});
  for(const changed of [{...doc,version:2},{...doc,text_sha256:'wrong'},{...doc,document_id:'other'},{...doc,text:'changed'}]) assert.equal(resolveAnnotation(note,changed).found,false);
});
