import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {openBookCatalog} from '../web/book-catalog.mjs';

const search={job_id:'search-fixture',type:'search',status:'succeeded',args:{query:'原创',language:''},created_at:1,result:{items:[{candidate_id:'gutenberg_123',title:'原创预览',author:'测试作者',languages:['zh'],source_url:'https://www.gutenberg.org/ebooks/123'}]}};
const usage={searches:{remaining:9,used:1,limit:10},imports:{remaining:3,used:0,limit:3}};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(run){
 const saved={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch};
 const {document,Event}=parseHTML('<html><body></body></html>'),posts=[];let jobs=[structuredClone(search)],release;
 const create=document.createElement.bind(document);
 document.createElement=name=>{
  const node=create(name);if(name==='dialog'){
   node.showModal=()=>{node.open=true;for(const form of node.querySelectorAll('form')){Object.defineProperty(form,'elements',{value:new Proxy({},{get:(_,name)=>form.querySelector(`[name="${name}"]`)})});form.reportValidity=()=>true;}
    for(const select of node.querySelectorAll('select'))Object.defineProperty(select,'value',{value:'',writable:true,configurable:true});};
   node.close=()=>{node.open=false;node.dispatchEvent(new Event('close'));};
  }return node;
 };
 globalThis.document=document;globalThis.window={addEventListener(){}};
 globalThis.fetch=async(_url,options={})=>{
  if(options.method==='POST'){
   const input=JSON.parse(options.body);posts.push(input);
   return new Promise(resolve=>{release=()=>{const job={...input,status:'queued',args:{candidate_id:input.candidate_id,search_job_id:input.search_job_id,group_id:input.group_id},created_at:2};jobs=[job,...jobs];resolve(Response.json(job));};});
  }
  return Response.json({items:jobs,usage});
 };
 let dialog;
 try{dialog=openBookCatalog({groups:[]});await flush();await run({document,dialog,Event,posts,release:()=>release?.()});}
 finally{if(dialog?.open)dialog.close();await flush();Object.assign(globalThis,saved);}
}
function choose({dialog,Event},checked=true){const input=dialog.querySelector('[name=candidate]');input.checked=checked;input.dispatchEvent(new Event('change',{bubbles:true}));}
const primary=dialog=>dialog.querySelector('.catalog-footer [data-catalog-primary]');

test('catalog selection changes the single footer action and query edits cannot import an old version',()=>harness(async h=>{
 const {dialog,Event,posts}=h,form=dialog.querySelector('.catalog-search'),button=primary(dialog);
 assert.equal(dialog.querySelector('.catalog-import button'),null);
 assert.equal(button.textContent,'搜索书籍');assert(!button.hasAttribute('data-action'));
 assert(dialog.querySelector('.catalog-secondary-action[data-tab=tasks]'));
 choose(h);assert.equal(button.textContent,'导入所选书籍');
 choose(h,false);assert.equal(button.textContent,'搜索书籍');
 choose(h);form.elements.query.value='另一作品';form.elements.query.dispatchEvent(new Event('input',{bubbles:true}));
 assert.equal(button.textContent,'搜索书籍');assert.equal(dialog.querySelectorAll('[name=candidate]').length,0);
 assert.equal(posts.length,0);
 form.elements.query.value='原创';form.elements.query.dispatchEvent(new Event('input',{bubbles:true}));choose(h);
 form.elements.language.value='en';form.elements.language.dispatchEvent(new Event('change',{bubbles:true}));
 assert.equal(button.textContent,'搜索书籍');assert.equal(dialog.querySelectorAll('[name=candidate]').length,0);
}));

test('catalog primary action imports its selected search once and stays disabled for the queued import',()=>harness(async h=>{
 const {dialog,Event,posts}=h,form=dialog.querySelector('.catalog-search');choose(h);
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
 assert.equal(posts.length,1);assert.equal(posts[0].type,'import');assert.equal(posts[0].candidate_id,'gutenberg_123');assert.equal(posts[0].search_job_id,'search-fixture');
 assert.equal(primary(dialog).disabled,true);h.release();await flush();
 assert.equal(primary(dialog).disabled,true);assert.equal(dialog.querySelector('[data-task-panel]').hidden,false);
 form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));assert.equal(posts.length,1);
}));
