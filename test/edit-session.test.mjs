import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditSessions} from '../web/edit-session.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no; }); return {promise,resolve,reject}; };
function editor() {
  let open=true,disabled=false,closed=0;
  const outcomes=[],errors=[];
  const edits=createEditSessions({isOpen:()=>open,onSaving:value=>{disabled=value;},onSaved:job=>{outcomes.push(job);if(job.unchanged()){open=false;closed++;}},onError:(error,job)=>errors.push({error,current:job.current()})});
  return {edits,outcomes,errors,get disabled(){return disabled;},get closed(){return closed;},get open(){return open;},close(){open=false;},begin(context){open=true;return edits.begin(context);}};
}

test('a completed old save cannot close a reopened editor or change its pending state',async()=>{
  const ui=editor(),first=deferred(),second=deferred();
  ui.begin({mode:'edit-book',bookId:'book_a'});
  const a=ui.edits.run(async(input,job)=>{assert.equal(input.publisher,'A');assert.equal(job.bookId,'book_a');await first.promise;},()=>({publisher:'A'}));
  ui.close();ui.begin({mode:'reader-profile',bookId:null});
  const b=ui.edits.run(async()=>second.promise,()=>({username:'new draft B'}));
  first.resolve();await a;
  assert.equal(ui.open,true);assert.equal(ui.disabled,true);assert.equal(ui.closed,0);assert.equal(ui.outcomes.length,0);
  second.resolve();await b;
  assert.equal(ui.closed,1);
});

test('a failed old save reports its own failure without mutating the new editor',async()=>{
  const ui=editor(),pending=deferred();ui.begin({mode:'discussion'});
  const save=ui.edits.run(()=>pending.promise,()=>({opening:'A'}));
  ui.close();ui.begin({mode:'edit-book'});
  pending.reject(new Error('offline'));await save;
  assert.equal(ui.open,true);assert.equal(ui.disabled,false);assert.equal(ui.closed,0);
  assert.equal(ui.errors[0].current,false);assert.equal(ui.errors[0].error.message,'offline');
});

test('edits typed during a save stay open and the next save uses the newer draft',async()=>{
  const ui=editor(),pending=deferred();ui.begin({mode:'edit-book'});let text='A';
  const save=ui.edits.run(async(input)=>{assert.equal(input,text);await pending.promise;assert.equal(input,'A');},()=>text);
  text='newer B';ui.edits.touch();pending.resolve();await save;
  assert.equal(ui.open,true);assert.equal(ui.disabled,false);assert.equal(ui.outcomes[0].unchanged(),false);
  await ui.edits.run(async input=>assert.equal(input,'newer B'),()=>text);
  assert.equal(ui.closed,1);
});

test('duplicate submits run once and capture mode, context and input before waiting',async()=>{
  const ui=editor(),pending=deferred();ui.begin({mode:'upload',operationId:'original',bookId:'book_a'});let calls=0,value='original';
  const save=ui.edits.run(async(input,job)=>{calls++;await pending.promise;assert.equal(job.mode,'upload');assert.equal(job.operationId,'original');assert.equal(job.bookId,'book_a');assert.equal(input,'original');},()=>value);
  await ui.edits.run(()=>{calls++;},()=>value);
  ui.close();ui.begin({mode:'discussion',operationId:'new',bookId:'book_b'});value='new';pending.resolve();await save;
  assert.equal(calls,1);assert.equal(ui.closed,0);
});

test('closing without reopening suppresses completion effects and a failed current save remains retryable',async()=>{
  const ui=editor(),pending=deferred();ui.begin({mode:'annotation'});
  const save=ui.edits.run(()=>pending.promise,()=>({}));ui.close();pending.resolve();await save;assert.equal(ui.closed,0);
  ui.begin({mode:'chapter-settings'});
  await ui.edits.run(async()=>{throw new Error('conflict');},()=>({}));
  assert.equal(ui.open,true);assert.equal(ui.disabled,false);assert.equal(ui.errors[0].current,true);
  await ui.edits.run(async()=>false,()=>({}));assert.equal(ui.open,true);
  await ui.edits.run(async()=>true,()=>({}));assert.equal(ui.closed,1);
});
