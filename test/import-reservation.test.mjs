import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import {issueToken} from '../src/core/auth.mjs';

test('first import is hidden until its matching frozen document is ready; retry publishes once and preserves owner isolation',async()=>{
  const bindings={SESSION_SECRET:'import-fixture-secret',READER_TOKEN:'fixture',AI_MODE:'mock'};
  const mf=new Miniflare({modules:true,scriptPath:'dist/worker.mjs',compatibilityDate:'2026-07-30',durableObjects:{READING_LIBRARY:{className:'ReadingLibraryDO',useSQLite:true}},r2Buckets:['BOOK_BUCKET'],bindings});
  try {
    const auth=async owner=>'Bearer '+await issueToken(bindings.SESSION_SECRET,{purpose:'session',user_id:owner});
    const req=async(route,method='GET',body,owner='alice')=>mf.dispatchFetch('https://reading.test/api/reading/'+route,{method,headers:{Authorization:await auth(owner),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const upload=async(id,owner='alice')=>mf.dispatchFetch('https://reading.test/api/reading/documents/'+id+'?book_id=book_import&filename=original.txt',{method:'PUT',headers:{Authorization:await auth(owner)},body:'第一章 原创\n\n可重试的导入正文。'});
    const create={book_id:'book_import',title:'原创导入',import_document_id:'doc_import'};
    const pending=await req('books','POST',create);assert.equal(pending.status,200);assert.equal((await pending.json()).archived,true);
    assert.equal((await (await req('books')).json()).items.length,0);
    // Failure before the PUT is dispatched leaves a hidden reservation. Same ID resumes.
    assert.equal((await req('books','POST',create)).status,200);
    assert.equal((await upload('doc_wrong')).status,409);
    assert.equal((await upload('doc_import','bob')).status,404);
    const ready=await upload('doc_import');assert.equal(ready.status,200);const receipt=await ready.json();
    assert.equal(receipt.book_snapshot.revision,2);assert.equal(receipt.book_snapshot.current_document_id,'doc_import');assert.equal(receipt.book_snapshot.archived,false);
    assert.equal((await req('books','POST',create)).status,200);assert.equal((await upload('doc_import')).status,200);
    const books=(await (await req('books')).json()).items;assert.equal(books.length,1);assert.equal(books[0].current_version,1);
    assert.equal((await (await req('documents')).json()).items.length,1);
    assert.equal((await req('books','POST',{...create,title:'不同草稿'})).status,409);
    assert.equal((await (await req('books','GET',null,'bob')).json()).items.length,0);
    assert.match(await (await req('documents/doc_import/text')).text(),/可重试的导入正文/);
    // Existing Agent / server clients can still create a visible empty book deliberately.
    assert.equal((await req('books','POST',{book_id:'book_existing_api',title:'原接口'})).status,200);
    assert.equal((await (await req('books')).json()).items.length,2);
  } finally {await mf.dispose();}
});
