import test from 'node:test';
import assert from 'node:assert/strict';
import {createAvatarDraft,bindReaderAvatarEditor} from '../web/reader-avatar-editor.mjs';
import {readerAvatarContent,avatarData} from '../web/reader-avatar-view.mjs';
import {createEditSessions} from '../web/edit-session.mjs';
import {readerProfileView} from '../web/reader-profile-view.mjs';
import {parseHTML} from 'linkedom';

const first='data:image/jpeg;base64,/9j/2Q==',second='data:image/jpeg;base64,YWJjZA==';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function harness(overrides={}){
 const previews=[],errors=[],busy=[],crops=[];let touches=0,current=true;
 const draft=createAvatarDraft({isCurrent:()=>current,onPreview:value=>previews.push(value),onTouch:()=>touches++,onError:error=>errors.push(error),onBusy:value=>busy.push(value),crop:async(file,options)=>{crops.push({file,options});return {blob:new Blob(),crop:{scale:2,x:.4,y:.6}};},encode:async()=>first,...overrides});
 return {draft,previews,errors,busy,crops,get touches(){return touches;},close(){current=false;}};
}

test('selected avatar is cropped locally with a fixed circle preview and bounded square JPEG output',async()=>{
 const fixture=harness(),file=new Blob(['original photo'],{type:'image/png'});
 assert.equal(await fixture.draft.select(file),true);
 assert.deepEqual(fixture.previews,[first]);assert(fixture.touches>0);assert.deepEqual(fixture.busy,[true,false]);
 assert.equal(fixture.crops[0].options.shape,'circle');assert.equal(fixture.crops[0].options.lockedAspect,true);assert.equal(fixture.crops[0].options.maxOutputSize,256);assert.equal(fixture.crops[0].options.outputType,'image/jpeg');assert.equal(fixture.crops[0].options.maxOutputBytes,35000);
 assert.equal(await fixture.draft.adjust(),true);assert.equal(fixture.crops[1].file,file);assert.deepEqual(fixture.crops[1].options.initial,{scale:2,x:.4,y:.6});
 fixture.draft.clear();assert.equal(fixture.previews.at(-1),'');assert.equal(await fixture.draft.adjust(),false);
});

test('cancel and invalid image leave the prior avatar draft intact',async()=>{
 const cancel=harness({initialData:first,crop:async()=>null});assert.equal(await cancel.draft.select(new Blob()),false);assert.deepEqual(cancel.previews,[]);assert.deepEqual(cancel.busy,[true,false]);
 const error=harness({crop:async()=>{throw Error('图片无法读取。');}});assert.equal(await error.draft.select(new Blob()),false);assert.deepEqual(error.errors,['图片无法读取。']);assert.deepEqual(error.previews,[]);
 const invalid=harness({encode:async()=>'<svg onload=alert(1)>'});assert.equal(await invalid.draft.select(new Blob()),false);assert.equal(invalid.previews.length,0);assert.equal(invalid.errors.length,1);
});

test('a late crop cannot overwrite a newer selection or a closed profile',async()=>{
 const old=deferred(),latest=deferred();let calls=0;
 const fixture=harness({crop:async()=>++calls===1?old.promise:latest.promise,encode:async blob=>blob.size===1?first:second});
 const previous=fixture.draft.select(new Blob()),next=fixture.draft.select(new Blob());
 latest.resolve({blob:new Blob(['22']),crop:{}});assert.equal(await next,true);
 old.resolve({blob:new Blob(['1']),crop:{}});assert.equal(await previous,false);assert.deepEqual(fixture.previews,[second]);
 const pending=deferred(),closing=harness({crop:()=>pending.promise});const selected=closing.draft.select(new Blob());closing.close();pending.resolve({blob:new Blob(),crop:{}});assert.equal(await selected,false);assert.deepEqual(closing.previews,[]);
});

test('disposing during encoding aborts crop ownership and blocks stale preview writes',async()=>{
 const encoded=deferred();let signal;
 const fixture=harness({crop:async(_,options)=>{signal=options.signal;return {blob:new Blob(),crop:{}};},encode:()=>encoded.promise});
 const result=fixture.draft.select(new Blob());await Promise.resolve();fixture.draft.dispose();assert.equal(signal.aborted,true);encoded.resolve(first);assert.equal(await result,false);assert.deepEqual(fixture.previews,[]);assert.equal(await fixture.draft.select(new Blob()),false);
});

test('starting a new adjustment keeps an earlier in-flight save from closing that draft',async()=>{
 let open=true,closed=false;
 const edits=createEditSessions({isOpen:()=>open,onSaving:()=>{},onSaved:job=>{if(job.unchanged()){closed=true;open=false;}},onError:()=>{}}),save=deferred(),crop=deferred();
 const session=edits.begin({mode:'reader-profile'}),draft=harness({initialData:first,isCurrent:()=>edits.current(session),onTouch:()=>edits.touch(),crop:()=>crop.promise});
 const submitted=edits.run(()=>save.promise,()=>({})),adjusting=draft.draft.adjust();
 save.resolve();await submitted;assert.equal(closed,false);assert.equal(open,true);
 crop.resolve({blob:new Blob(),crop:{}});assert.equal(await adjusting,true);assert.deepEqual(draft.previews,[first]);
});

test('avatar markup rejects arbitrary URLs, oversized data and injected content',()=>{
 assert.equal(avatarData(first),first);assert.equal(readerAvatarContent({avatar_data:first}),`<img src="${first}" alt="">`);
 for(const avatar_data of ['https://example.test/photo.jpg','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','data:image/jpeg;base64,'+'A'.repeat(50000),'data:image/jpeg;base64,AAAA" onerror="x']){
  assert.equal(avatarData(avatar_data),'');assert.equal(readerAvatarContent({avatar_data,username:'<reader'}),'&lt;');
 }
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function editorFixture({initialData='',crop=async()=>null,encode=async()=>second}={}){
 const profile={username:'共读者',avatar_data:initialData,revision:4},html='<html><body><dialog id="sheet">'+readerProfileView(profile)+'</dialog><button id="outside">其他操作</button></body></html>';
 const {document,Event}=parseHTML(html),sheet=document.querySelector('#sheet'),choose=sheet.querySelector('[data-avatar-choose]'),picker=sheet.querySelector('[data-avatar-file]'),adjust=sheet.querySelector('[data-avatar-adjust]'),replace=sheet.querySelector('[data-avatar-replace]'),menu=sheet.querySelector('[data-avatar-menu]'),value=sheet.querySelector('[name=avatar_data]');
 let focused=null,picked=0,current=true,touched=0;const crops=[],errors=[],busy=[];
 Object.defineProperty(document,'activeElement',{get:()=>focused});
 for(const button of sheet.querySelectorAll('button'))button.focus=()=>{focused=button;};
 picker.click=()=>{picked++;};
 const editor=bindReaderAvatarEditor(sheet,{profile,isCurrent:()=>current,onTouch:()=>touched++,onError:message=>errors.push(message),onBusy:state=>busy.push(state),crop:async(file,options)=>{crops.push({file,options});return crop(file,options);},encode});
 return {document,sheet,choose,picker,adjust,replace,menu,value,editor,crops,errors,busy,get picked(){return picked;},get touched(){return touched;},get focused(){return focused;},key(target,key){const event=new Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:key});target.dispatchEvent(event);return event;},outside(){document.querySelector('#outside').dispatchEvent(new Event('pointerdown',{bubbles:true}));},file(file){Object.defineProperty(picker,'files',{value:file?[file]:[],configurable:true});picker.onchange();},close(){current=false;sheet.dispatchEvent(new Event('close'));}};
}

test('a default avatar directly opens the picker and gains its menu after a successful crop',async()=>{
 const fixture=editorFixture({crop:async()=>({blob:new Blob(),crop:{scale:2}})});
 try{
  fixture.choose.click();assert.equal(fixture.picked,1);assert.equal(fixture.menu.hidden,true);assert.equal(fixture.touched,0);
  fixture.file(new Blob(['photo'],{type:'image/png'}));await flush();
  assert.equal(fixture.value.value,second);assert.equal(fixture.choose.getAttribute('aria-haspopup'),'menu');
  fixture.choose.click();assert.equal(fixture.menu.hidden,false);assert.equal(fixture.picked,1);assert.equal(fixture.focused,fixture.adjust);
 }finally{fixture.editor.dispose();}
});

test('clicking an uploaded avatar opens only its two actions and dismissing changes no draft',()=>{
 const fixture=editorFixture({initialData:first});
 try{
  fixture.choose.click();assert.equal(fixture.menu.hidden,false);assert.equal(fixture.choose.getAttribute('aria-expanded'),'true');assert.equal(fixture.picked,0);
  fixture.outside();assert.equal(fixture.menu.hidden,true);assert.equal(fixture.choose.getAttribute('aria-expanded'),'false');
  fixture.choose.click();const escape=fixture.key(fixture.adjust,'Escape');assert.equal(escape.defaultPrevented,true);assert.equal(fixture.menu.hidden,true);assert.equal(fixture.focused,fixture.choose);
  assert.equal(fixture.value.value,first);assert.equal(fixture.touched,0);assert.equal(fixture.crops.length,0);
 }finally{fixture.editor.dispose();}
});

test('avatar menu keyboard navigation stays in its two choices and Tab returns to normal navigation',()=>{
 const fixture=editorFixture({initialData:first});
 try{
  fixture.key(fixture.choose,'ArrowDown');assert.equal(fixture.menu.hidden,false);assert.equal(fixture.focused,fixture.adjust);
  fixture.key(fixture.adjust,'ArrowDown');assert.equal(fixture.focused,fixture.replace);
  fixture.key(fixture.replace,'ArrowDown');assert.equal(fixture.focused,fixture.adjust);
  fixture.key(fixture.adjust,'End');assert.equal(fixture.focused,fixture.replace);
  fixture.key(fixture.replace,'Home');assert.equal(fixture.focused,fixture.adjust);
  const tab=fixture.key(fixture.adjust,'Tab');assert.equal(tab.defaultPrevented,false);assert.equal(fixture.menu.hidden,true);assert.equal(fixture.focused,fixture.choose);
  fixture.key(fixture.choose,'ArrowUp');assert.equal(fixture.focused,fixture.replace);
 }finally{fixture.editor.dispose();}
});

test('adjusting from the avatar menu uses the saved image and cancellation preserves the draft',async()=>{
 const fixture=editorFixture({initialData:first});
 try{
  fixture.choose.click();fixture.adjust.click();await flush();
  assert.equal(fixture.menu.hidden,true);assert.equal(fixture.picked,0);assert.equal(fixture.crops.length,1);
  assert.equal(fixture.crops[0].file.type,'image/jpeg');assert.equal(fixture.value.value,first);assert.deepEqual(fixture.busy,[true,false]);assert.deepEqual(fixture.errors,[]);
  assert.equal(fixture.sheet.querySelector('[name=revision]').value,'4');
 }finally{fixture.editor.dispose();}
});

test('replacement opens the picker without deleting the saved image when the picker is cancelled',async()=>{
 const fixture=editorFixture({initialData:first});
 try{
  fixture.choose.click();fixture.replace.click();assert.equal(fixture.picked,1);assert.equal(fixture.menu.hidden,true);
  fixture.file(null);await flush();assert.equal(fixture.value.value,first);assert.equal(fixture.crops.length,0);assert.equal(fixture.touched,0);
 }finally{fixture.editor.dispose();}
});

test('closing the profile aborts an avatar-menu adjustment and blocks late preview replacement',async()=>{
 const pending=deferred(),fixture=editorFixture({initialData:first,crop:()=>pending.promise});
 fixture.choose.click();fixture.adjust.click();assert.equal(fixture.crops.length,1);const signal=fixture.crops[0].options.signal;
 fixture.close();assert.equal(signal.aborted,true);assert.equal(fixture.menu.hidden,true);assert.equal(fixture.choose.onclick,null);
 pending.resolve({blob:new Blob(),crop:{}});await flush();assert.equal(fixture.value.value,first);assert.deepEqual(fixture.errors,[]);
 fixture.editor.dispose();
});
