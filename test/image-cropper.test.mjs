import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {cropImage,cropOutputOptions,encodeCropCanvas} from '../web/image-cropper.mjs';

test('crop output preserves the PNG defaults and validates bounded avatar options',()=>{
  assert.deepEqual(cropOutputOptions(),{maxOutputSize:1920,outputType:'image/png',outputQuality:.92,maxOutputBytes:Infinity});
  const avatar={maxOutputSize:256,outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000};
  assert.deepEqual(cropOutputOptions(avatar),avatar);
  for(const options of [{maxOutputSize:1921},{outputType:'image/gif'},{outputQuality:0},{maxOutputBytes:0}])assert.throws(()=>cropOutputOptions(options),/图片输出设置无效/);
});

test('avatar encoding lowers JPEG quality only until the byte limit is met',async()=>{
  const calls=[],canvas={toBlob(callback,type,quality){calls.push({type,quality});callback(new Blob([new Uint8Array(quality>.62?45000:22000)],{type}));}};
  const blob=await encodeCropCanvas(canvas,{outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000});
  assert.equal(blob.type,'image/jpeg');assert.equal(blob.size,22000);assert.deepEqual(calls.map(call=>call.quality),[.82,.72,.62]);
  assert(calls.every(call=>call.type==='image/jpeg'));
});

test('encoding rejects oversized or unsupported output and stops cancelled work',async()=>{
  let calls=0;const oversized={toBlob(callback,type){calls++;callback(new Blob([new Uint8Array(40000)],{type}));}};
  await assert.rejects(encodeCropCanvas(oversized,{outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000}),/图片压缩后仍超过大小限制，请换一张图片。/);
  assert.equal(calls,7);
  await assert.rejects(encodeCropCanvas({toBlob(callback){callback(new Blob(['x'],{type:'image/png'}));}},{outputType:'image/jpeg'}),/此设备无法保存所需图片格式/);
  calls=0;await assert.rejects(encodeCropCanvas(oversized,{},()=>true),{name:'AbortError'});assert.equal(calls,0);
});

const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(run,{deferEncoding=false,deferDecoding=false,failOpen=false,stageHeight=300}={}){
  const saved=Object.fromEntries(['document','createImageBitmap','getComputedStyle','ResizeObserver'].map(key=>[key,globalThis[key]]));
  const createURL=URL.createObjectURL,revokeURL=URL.revokeObjectURL;
  const {document,Event}=parseHTML('<html><body><dialog id="parent" open></dialog></body></html>');
  const parent=document.querySelector('#parent');parent.open=true;
  let closes=0,revokes=0,disconnects=0,decodes=0,release,releaseDecode;const encodings=[];
  const bitmap={width:800,height:600,close(){closes++;}};
  const create=document.createElement.bind(document);
  const append=document.body.append.bind(document.body);
  document.body.append=(...nodes)=>{for(const node of nodes)for(const select of node.querySelectorAll?.('select')||[])Object.defineProperty(select,'value',{value:'target',writable:true,configurable:true});append(...nodes);};
  document.createElement=name=>{
    const node=create(name);
    if(name==='dialog'){
      node.showModal=()=>{
        if(failOpen)throw new Error('fixture dialog failed');
        node.open=true;
        const stage=node.querySelector('.crop-stage'),frame=node.querySelector('.crop-frame');
        stage.getBoundingClientRect=()=>({width:390,height:stageHeight});
        frame.getBoundingClientRect=()=>({width:parseFloat(frame.style.width)||200,height:parseFloat(frame.style.height)||200});
        frame.setPointerCapture=()=>{};
      };
      node.close=()=>{node.open=false;node.dispatchEvent(new Event('close'));};
    }
    if(name==='canvas'){
      node.getContext=()=>({drawImage(){},fillRect(){}});
      node.toBlob=(callback,type,quality)=>{
        encodings.push({width:node.width,height:node.height,type,quality});
        const finish=()=>callback(new Blob([new Uint8Array(30000)],{type}));
        if(deferEncoding)release=finish;else finish();
      };
    }
    return node;
  };
  Object.assign(globalThis,{document,createImageBitmap:()=>{decodes++;return deferDecoding?new Promise(resolve=>{releaseDecode=()=>resolve(bitmap);}):Promise.resolve(bitmap);},getComputedStyle:()=>({paddingLeft:'16px',paddingRight:'16px',paddingTop:'16px',paddingBottom:'16px'}),ResizeObserver:class{observe(){}disconnect(){disconnects++;}}});
  URL.createObjectURL=()=> 'blob:fixture';URL.revokeObjectURL=()=>{revokes++;};
  let promise,dialog;
  try{
    const source=new Blob(['fixture'],{type:'image/png'});
    const start=async options=>{promise=cropImage(source,options);promise.catch(()=>{});await flush();dialog=document.querySelector('.image-cropper');return dialog;};
    await run({start,source,parent,encodings,release:()=>release?.(),releaseDecode:()=>releaseDecode?.(),result:()=>promise,decodeCount:()=>decodes,find:()=>document.querySelector('.image-cropper'),resources:()=>({closes,revokes,disconnects})});
  }finally{
    if(dialog?.open)dialog.close();release?.();releaseDecode?.();if(promise)await promise.catch(()=>{});await flush();
    Object.assign(globalThis,saved);URL.createObjectURL=createURL;URL.revokeObjectURL=revokeURL;
  }
}

test('circle mode locks a square, preserves drag/pinch/slider and emits a bounded square JPEG',()=>harness(async h=>{
  const dialog=await h.start({shape:'circle',lockedAspect:true,aspect:16/9,initial:{ratio:'landscape'},maxOutputSize:256,outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000});
  assert.equal(dialog.dataset.shape,'circle');assert.equal(dialog.querySelector('[data-ratio-row]').hidden,true);assert.equal(dialog.querySelector('select').disabled,true);
  const frame=dialog.querySelector('.crop-frame'),zoom=dialog.querySelector('input');
  zoom.value='2';zoom.oninput();
  const pointer=(pointerId,clientX,clientY)=>({pointerId,clientX,clientY,preventDefault(){}});
  frame.onpointerdown(pointer(1,100,100));frame.onpointermove(pointer(1,110,100));frame.onpointerdown(pointer(2,210,100));frame.onpointermove(pointer(2,260,100));
  await dialog.querySelector('[data-done]').onclick();
  const result=await h.result();assert.equal(result.source,h.source);assert.equal(result.blob.type,'image/jpeg');assert(result.blob.size<=35000);
  assert.equal(result.crop.ratio,'target');assert.equal(result.crop.scale,3);assert(result.crop.x<.5);
  assert.deepEqual(h.encodings.map(({width,height,type})=>({width,height,type})),[{width:256,height:256,type:'image/jpeg'}]);
  assert.equal(h.parent.open,true);assert.deepEqual(h.resources(),{closes:1,revokes:1,disconnects:1});
}));

test('default crop remains an unlocked PNG crop with selectable proportions',()=>harness(async h=>{
  const dialog=await h.start({aspect:4/3});assert.equal(dialog.querySelector('[data-ratio-row]').hidden,false);assert.equal(dialog.querySelector('select').disabled,false);
  await dialog.querySelector('[data-done]').onclick();const result=await h.result();assert.equal(result.blob.type,'image/png');
  assert.deepEqual(h.encodings.map(({width,height})=>({width,height})),[{width:1920,height:1440}]);
}));

test('closing during encoding leaves the parent open and cleans resources without another encode',()=>harness(async h=>{
  const dialog=await h.start({shape:'circle',maxOutputSize:256,outputType:'image/jpeg',maxOutputBytes:35000});
  const encoding=dialog.querySelector('[data-done]').onclick();assert.equal(dialog.querySelector('input').disabled,true);
  dialog.querySelector('[data-cancel]').onclick();assert.equal(await h.result(),null);assert.equal(h.parent.open,true);
  h.release();await encoding;assert.equal(h.encodings.length,1);assert.deepEqual(h.resources(),{closes:1,revokes:1,disconnects:1});
},{deferEncoding:true}));

test('already-aborted avatar work does not decode or mount a cropper',()=>harness(async h=>{
  const controller=new AbortController();controller.abort();
  assert.equal(await h.start({signal:controller.signal}),null);assert.equal(await h.result(),null);
  assert.equal(h.decodeCount(),0);assert.deepEqual(h.resources(),{closes:0,revokes:0,disconnects:0});assert.equal(h.parent.open,true);
}));

test('aborting during decoding closes the bitmap without opening a late cropper',()=>harness(async h=>{
  const controller=new AbortController();assert.equal(await h.start({signal:controller.signal}),null);
  controller.abort();h.releaseDecode();assert.equal(await h.result(),null);assert.equal(h.find(),null);
  assert.equal(h.decodeCount(),1);assert.deepEqual(h.resources(),{closes:1,revokes:0,disconnects:0});assert.equal(h.parent.open,true);
},{deferDecoding:true}));

test('aborting an open cropper returns to its parent and removes the abort listener',()=>harness(async h=>{
  const controller=new AbortController(),signal=controller.signal;
  const remove=signal.removeEventListener.bind(signal);let removed=0;
  signal.removeEventListener=(...args)=>{if(args[0]==='abort')removed++;return remove(...args);};
  const dialog=await h.start({signal,shape:'circle'});assert.equal(dialog.open,true);
  controller.abort();assert.equal(await h.result(),null);assert.equal(h.parent.open,true);assert.equal(removed,1);
  assert.deepEqual(h.resources(),{closes:1,revokes:1,disconnects:1});assert.equal(h.find(),null);
}));

test('aborting during encoding discards late output and does not encode again',()=>harness(async h=>{
  const controller=new AbortController(),dialog=await h.start({signal:controller.signal,shape:'circle',maxOutputSize:256,outputType:'image/jpeg',maxOutputBytes:35000});
  const encoding=dialog.querySelector('[data-done]').onclick();controller.abort();assert.equal(await h.result(),null);
  h.release();await encoding;assert.equal(h.encodings.length,1);assert.equal(h.parent.open,true);
  assert.deepEqual(h.resources(),{closes:1,revokes:1,disconnects:1});
},{deferEncoding:true}));

test('cropper setup failure still cleans its bitmap, URL and observer',()=>harness(async h=>{
  await h.start();await assert.rejects(h.result(),/fixture dialog failed/);
  assert.deepEqual(h.resources(),{closes:1,revokes:1,disconnects:1});assert.equal(h.find(),null);assert.equal(h.parent.open,true);
},{failOpen:true}));

test('a short viewport scales the square preview down without changing avatar output',()=>harness(async h=>{
  const dialog=await h.start({shape:'circle',maxOutputSize:256,outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000});
  const frame=dialog.querySelector('.crop-frame');assert.equal(frame.style.width,'128px');assert.equal(frame.style.height,'128px');
  await dialog.querySelector('[data-done]').onclick();assert.equal((await h.result()).blob.type,'image/jpeg');
  assert.equal(h.encodings[0].width,256);assert.equal(h.encodings[0].height,256);
},{stageHeight:160}));
