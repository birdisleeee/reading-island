import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readerTapAction,readerPageTarget,mountReaderControls} from '../web/reader-controls.mjs';

const rect={left:20,right:420,top:10,bottom:810,width:400,height:800};
const tap=(x,extra={})=>readerTapAction({startX:x,startY:200,endX:x,endY:200,duration:100,rect,...extra});
const pause=()=>new Promise(resolve=>setTimeout(resolve,310));

test('tap classification excludes selection, scroll, drag, long press and controls; only edges page',()=>{
  assert.equal(tap(30),'previous');assert.equal(tap(220),'toggle');assert.equal(tap(410),'next');
  for(const extra of [{selected:true},{scrolled:true},{blocked:true},{duration:451},{endY:220},{endX:500},{endY:900},{startX:NaN}])assert.equal(tap(220,extra),null);
  assert.equal(readerPageTarget({top:0,height:800,scrollHeight:2400,direction:1}),736);
  assert.equal(readerPageTarget({top:1600,height:800,scrollHeight:2400,direction:1}),1600);
  assert.equal(readerPageTarget({top:40,height:800,scrollHeight:2400,direction:-1}),0);
});

function harness(){
  const {document,window}=parseHTML('<html><body><main><section class="reader-screen"><header class="reader-head"><button data-action="back">返回</button><div>书名</div><button data-action="reader-settings">排版</button></header><div class="reader-tools"><span>选中原文后摘抄</span></div><div class="chapter-reading"><h1>第一章</h1><article id="reader-text"><p>原创示例正文</p><mark data-note="note">摘录标注</mark><a href="#">链接</a></article><nav class="chapter-turner"><button data-action="previous-chapter">上一章</button><button data-action="next-chapter">下一章</button></nav></div></section></main></body></html>');
  // Linkedom exposes a getter-only select value; browsers provide the setter.
  if(!Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value')?.set)Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value||this.querySelector('option')?.value||'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===value);}});
  const screen=document.querySelector('.reader-screen'),p=document.querySelector('p');
  window.HTMLElement.prototype.getBoundingClientRect=function(){return this.classList.contains('reader-chapter-end')?{top:rect.top+2600-screen.scrollTop}:rect;};
  let selected=false,values={font:'serif',size:18,line:1.85,padding:24},save=()=>Promise.resolve();const writes=[];
  window.innerWidth=440;window.innerHeight=820;window.getSelection=()=>({isCollapsed:!selected,toString:()=>selected?'已选中文字':''});window.getComputedStyle=()=>({overflowY:'auto'});
  screen.getBoundingClientRect=()=>rect;Object.defineProperty(screen,'clientHeight',{value:800});Object.defineProperty(screen,'scrollHeight',{value:3000});screen.scrollTop=0;screen.scrollTo=({top,behavior})=>{assert.equal(behavior,'instant');screen.scrollTop=top;};
  const api=mountReaderControls(screen,{appearance:{values:()=>({...values}),preview:next=>{values={...next};},save:next=>{writes.push({...next});return save(next);}}});
  const dispatch=(target,type,props={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,props);target.dispatchEvent(event);return event;};
  const pointer=(type,target=p,x=220,y=200,extra={})=>dispatch(target,type,{pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y,...extra});
  const click=async(x=220,target=p)=>{pointer('pointerdown',target,x);pointer('pointerup',target,x);dispatch(target,'click',{detail:1});await pause();};
  return {document,window,screen,p,api,writes,dispatch,pointer,click,select:value=>{selected=value;},values:()=>values,setSave:value=>{save=value;}};
}

test('center taps toggle both docks; edges scroll one viewport and never change chapters',async()=>{
  const h=harness();try{
    assert.equal(h.screen.dataset.readerControls,'hidden');assert.ok(h.document.querySelector('.reader-controls-top').hidden);
    assert.equal(h.document.querySelector('.reader-controls-reveal'),null);
    await h.click();assert.equal(h.screen.dataset.readerControls,'visible');assert.equal(h.document.querySelector('.reader-controls-bottom').hidden,false);
    await h.click(410);assert.equal(h.screen.scrollTop,736);assert.equal(h.screen.dataset.readerControls,'visible');
    await h.click(30);assert.equal(h.screen.scrollTop,0);
    await h.click();assert.equal(h.screen.dataset.readerControls,'hidden');
    assert.equal(h.writes.length,0);assert.equal(h.document.querySelectorAll('[data-action="next-chapter"]').length,1);
  }finally{h.api.dispose();}
});

test('selection, native scroll, moving/multiple pointers, marked text and double click never page or toggle',async()=>{
  const h=harness();try{
    h.select(true);await h.click(410);h.select(false);
    h.pointer('pointerdown',h.p,410);h.dispatch(h.screen,'scroll');h.pointer('pointerup',h.p,410);h.dispatch(h.p,'click',{detail:1});await pause();
    h.pointer('pointerdown',h.p,410);h.pointer('pointermove',h.p,410,240);h.pointer('pointerup',h.p,410);h.dispatch(h.p,'click',{detail:1});await pause();
    h.pointer('pointerdown',h.p,410);h.pointer('pointerdown',h.p,410,200,{pointerId:2,isPrimary:false});h.pointer('pointerup',h.p,410,200,{pointerId:2});h.pointer('pointerup',h.p,410);h.dispatch(h.p,'click',{detail:1});await pause();
    await h.click(410,h.document.querySelector('mark'));await h.click(410,h.document.querySelector('a'));
    h.pointer('pointerdown');h.pointer('pointerup');h.dispatch(h.p,'click',{detail:1});h.dispatch(h.p,'dblclick',{detail:2});await pause();
    h.api.setVisible(true);h.pointer('pointerdown',h.p,410);h.pointer('pointerup',h.p,410);h.dispatch(h.p,'click',{detail:1});h.select(true);h.dispatch(h.document,'selectionchange');await pause();
    assert.equal(h.screen.scrollTop,0);assert.equal(h.screen.dataset.readerControls,'hidden');
  }finally{h.api.dispose();}
});

test('reaching the actual text end automatically shows only chapter navigation and preserves selection',()=>{
  const h=harness();try{
    const top=h.document.querySelector('.reader-controls-top'),bottom=h.document.querySelector('.reader-controls-bottom'),quick=h.document.querySelector('.reader-quick-layout');
    assert.equal(bottom.hidden,true);
    h.screen.scrollTop=1900;h.dispatch(h.screen,'scroll');
    assert.equal(h.screen.dataset.readerChapterEnd,'true');assert.equal(top.hidden,true);assert.equal(bottom.hidden,false);assert.equal(quick.hidden,true);assert.equal(bottom.dataset.readerMode,'chapters');assert.equal(h.writes.length,0);
    h.select(true);h.dispatch(h.document,'selectionchange');assert.equal(bottom.hidden,true);
    h.select(false);h.dispatch(h.document,'selectionchange');assert.equal(bottom.hidden,false);
    h.api.setVisible(true);assert.equal(top.hidden,false);assert.equal(quick.hidden,false);
    h.api.setVisible(false);assert.equal(top.hidden,true);assert.equal(bottom.hidden,false);assert.equal(quick.hidden,true);
    h.screen.scrollTop=0;h.dispatch(h.screen,'scroll');assert.equal(bottom.hidden,true);assert.equal(h.screen.dataset.readerChapterEnd,'false');
  }finally{h.api.dispose();assert.equal(h.document.querySelector('.reader-chapter-end'),null);}
});

test('font/size preview and save use the shared values; failed and stale saves remain distinguishable',async()=>{
  const h=harness(),pending=[];h.setSave(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));try{
    h.api.setVisible(true);const range=h.document.querySelector('[data-reader-size]'),font=h.document.querySelector('[data-reader-font]');
    range.value='22';h.dispatch(range,'input');assert.equal(h.values().size,22);assert.equal(h.values().line,1.85);assert.equal(h.writes.length,1);
    range.value='22';h.dispatch(range,'input');assert.equal(h.writes.length,1,'unchanged values never write');
    font.value='kaiti';h.dispatch(font,'change');assert.equal(h.values().font,'kaiti');assert.equal(h.writes.length,2);
    pending[0].reject();await Promise.resolve();assert.equal(h.document.querySelector('[data-reader-save-retry]').hidden,true,'late failure cannot replace newer pending save');
    pending[1].reject();await Promise.resolve();assert.equal(h.document.querySelector('[data-reader-save-retry]').hidden,false);
    h.dispatch(h.document.querySelector('[data-reader-save-retry]'),'click');assert.equal(h.writes.length,3);pending[2].resolve();await Promise.resolve();assert.equal(h.document.querySelector('[data-reader-save-status]').textContent,'已保存到此设备');
    assert.equal(h.writes[2].padding,24);assert.equal(h.writes[2].size,22);assert.equal(h.writes[2].font,'kaiti');
  }finally{h.api.dispose();}
});

test('keyboard controls respect editing/selection and modal focus; dispose restores DOM and removes late taps',async()=>{
  const h=harness();const originalHead=h.document.querySelector('.reader-head'),originalNav=h.document.querySelector('.chapter-turner');
  h.dispatch(h.screen,'keydown',{key:'Enter'});assert.equal(h.screen.dataset.readerControls,'visible');
  assert.equal(h.dispatch(h.screen,'keydown',{key:'PageDown'}).defaultPrevented,true);assert.equal(h.screen.scrollTop,736);
  h.select(true);assert.equal(h.dispatch(h.screen,'keydown',{key:'ArrowRight'}).defaultPrevented,false);h.select(false);
  h.dispatch(h.screen,'keydown',{key:'ArrowRight',shiftKey:true});assert.equal(h.screen.scrollTop,736);
  h.dispatch(h.document.querySelector('[data-reader-font]'),'keydown',{key:'ArrowRight'});assert.equal(h.screen.scrollTop,736);
  assert.equal(h.dispatch(h.document.querySelector('[data-reader-font]'),'keydown',{key:'Escape'}).defaultPrevented,false);assert.equal(h.screen.dataset.readerControls,'visible');
  h.dispatch(h.document.querySelector('[data-action="back"]'),'keydown',{key:'Escape'});assert.equal(h.screen.dataset.readerControls,'hidden');
  const dialog=h.document.createElement('dialog');dialog.setAttribute('open','');h.document.body.append(dialog);h.dispatch(h.screen,'keydown',{key:'Enter'});assert.equal(h.screen.dataset.readerControls,'hidden');dialog.remove();
  h.pointer('pointerdown');h.pointer('pointerup');h.dispatch(h.p,'click',{detail:1});h.api.dispose();await pause();
  assert.equal(h.document.querySelector('.reader-controls-portal'),null);assert.equal(h.screen.querySelector('.reader-head'),originalHead);assert.equal(h.screen.querySelector('.chapter-turner'),originalNav);assert.equal(h.screen.getAttribute('tabindex'),null);assert.equal(h.screen.dataset.readerControls,undefined);
});
