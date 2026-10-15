import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudLibrary} from '../web/cloud-adapter.mjs';
import {mergeThread,mergeLibraryThreads,captureDialogReturnFocus} from '../web/confirmed-state.mjs';

const message = {message_id:'msg_one',text:'原创回复',author:'me',sequence:0,created_at:'2026-01-01'};
const thread = {thread_id:'thread_one',title:'原创议题',status:'open',revision:1,messages:[]};
const book = {book_id:'book_one',title:'原创书籍',author:'原作者',publisher:'',category:'堆放',group_id:'',revision:1};
const snapshot = () => ({revision:0,groups:['堆放'],group_records:[],books:[{...book}],documents:[],annotations:[],threads:[structuredClone(thread)]});
const unavailable = () => Object.assign(new Error('offline'),{status:503});
const deferred = () => {let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};

test('a delayed reply reads only its own thread and cannot roll back a newer book edit',async()=>{
  const wait=deferred(),reads=[];
  const cloud=createCloudLibrary({api:{sendMessage:async()=>({message}),get:async(kind,id)=>{reads.push([kind,id]);await wait.promise;return {...thread};},list:async(kind,query)=>{assert.equal(kind,'messages');assert.equal(query.thread_id,thread.thread_id);return {items:[message]};}}});
  const state=snapshot(),reply=cloud.sendReply(thread.thread_id,message);
  state.books[0]={...book,author:'新作者',revision:2};
  wait.resolve();const received=await reply;
  state.threads[0]=mergeThread(state.threads[0],received.thread);
  assert.deepEqual(reads,[['threads',thread.thread_id]]);
  assert.equal(state.books[0].author,'新作者');assert.equal(state.books[0].revision,2);
});

test('book write acknowledgement survives list failure and the next edit uses its confirmed revision',async()=>{
  let saved={...book},writes=0;
  const cloud=createCloudLibrary({api:{list:async()=>{throw unavailable();},updateBook:async value=>{assert.equal(value.revision,saved.revision);writes++;saved={...value,revision:saved.revision+1};return saved;}}});
  const before=snapshot(),next=structuredClone(before);next.books[0].publisher='已保存';
  const first=await cloud.commit(before,next);
  assert.match(first.warning,/已保存/);assert.equal(first.state.books[0].revision,2);assert.equal(first.state.books[0].publisher,'已保存');
  const newer=structuredClone(first.state);newer.books[0].publisher='下一份草稿';
  const second=await cloud.commit(first.state,newer);
  assert.equal(second.state.books[0].revision,3);assert.equal(second.state.books[0].publisher,'下一份草稿');assert.equal(writes,2);
});

test('partial write failure retains only confirmed fields, and a true conflict remains a conflict',async()=>{
  const cloud=createCloudLibrary({api:{updateBook:async value=>({...value,revision:2}),uploadCover:async()=>{throw unavailable();}}});
  const before=snapshot(),next=structuredClone(before);next.books[0].author='新作者';next.books[0].cover_data='data:image/png;base64,AA==';
  await assert.rejects(cloud.commit(before,next),error=>{
    assert.equal(error.confirmedState.books[0].revision,2);assert.equal(error.confirmedState.books[0].author,'新作者');assert.equal(error.confirmedState.books[0].cover_data,undefined);return true;
  });
  const conflict=createCloudLibrary({api:{updateBook:async()=>{throw Object.assign(new Error('conflict'),{status:409});}}});
  await assert.rejects(conflict.commit(before,next),error=>error.status===409&&error.confirmedState.books[0].revision===1);
});

test('reply acknowledgement is final even when subsequent thread reading fails',async()=>{
  let sends=0;
  const cloud=createCloudLibrary({api:{sendMessage:async value=>{sends++;assert.equal(value.turn_id,'turn_one');return {message};},get:async()=>{throw unavailable();}}});
  const result=await cloud.sendReply(thread.thread_id,message);
  assert.equal(result.message.message_id,message.message_id);assert.match(result.warning,/已发送/);assert.equal(sends,1);
});

test('an unknown send is reconciled under the same message identity without a second send',async()=>{
  let sends=0;
  const cloud=createCloudLibrary({api:{sendMessage:async()=>{sends++;throw unavailable();},get:async()=>({...thread}),list:async()=>({items:[message]})}});
  await assert.rejects(cloud.sendReply(thread.thread_id,message));
  const result=await cloud.sendReply(thread.thread_id,message,{reconcile:true});
  assert.equal(result.thread.messages.length,1);assert.equal(sends,1);
});

test('older thread reads preserve a newer closed status and messages received concurrently',()=>{
  const closed={...thread,status:'closed',revision:3,messages:[message]};
  const incoming={...thread,revision:2,messages:[{...message,message_id:'msg_two',sequence:1}]};
  const merged=mergeThread(closed,incoming);
  assert.equal(merged.status,'closed');assert.equal(merged.revision,3);assert.equal(merged.messages.length,2);
  const old=snapshot(),fresh=snapshot();old.threads=[closed];fresh.threads=[incoming];
  assert.equal(mergeLibraryThreads(old,fresh).threads[0].status,'closed');
});

test('a completed upload retains its exact book receipt even if the library refresh fails',async()=>{
  const before=snapshot(),next=structuredClone(before);
  next.books.push({...book,book_id:'book_new',title:'新书'});
  next.documents.push({document_id:'doc_new',book_id:'book_new',filename:'original.txt',original:new Blob(['原创正文']),text:'原创正文',text_sha256:'sha'});
  let creation;
  const cloud=createCloudLibrary({api:{
    createBook:async value=>{creation=value;return {...value,revision:1,archived:true};},
    uploadDocument:async()=>({document_id:'doc_new',book_id:'book_new',status:'ready',version:1,text_sha256:'sha',chapters:[],book_snapshot:{...next.books[1],current_document_id:'doc_new',current_version:1,archived:false,revision:2}}),
    list:async()=>{throw unavailable();}
  }});
  const result=await cloud.commit(before,next);
  assert.equal(creation.import_document_id,'doc_new');assert.equal(result.state.books[1].revision,2);assert.equal(result.state.documents[0].text,'原创正文');assert.equal(result.state.books[1].current_document_id,'doc_new');
});

test('saved dialog focus returns to its replacement entry',()=>{
  let focused='none';
  const old={isConnected:true,closest:()=>({getAttribute:()=> 'edit-book'}),focus:()=>{focused='old';}};
  const replacement={getAttribute:()=> 'edit-book',getClientRects:()=>[{}],focus:()=>{focused='replacement';}};
  const restore=captureDialogReturnFocus({activeElement:old,querySelectorAll:()=>[replacement]});
  old.isConnected=false;restore();assert.equal(focused,'replacement');
});
