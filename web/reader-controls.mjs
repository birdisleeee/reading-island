import {appearanceValues,previewAppearance,saveAppearance} from './appearance.mjs';

const interactive='a,button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[data-action],mark,.selection-bar';
const fonts=[['serif','宋体 / 衬线'],['system','系统黑体'],['kaiti','楷体'],['mono','等宽字体']];
let nextId=0;

// A tap is a short, stationary, unselected primary-pointer gesture. It never
// replaces native scrolling or selection, and the central half only shows tools.
export function readerTapAction({startX,startY,endX,endY,duration,rect,scrolled=false,selected=false,blocked=false}){
  if(blocked||selected||scrolled||!rect||![startX,startY,endX,endY,duration,rect.left,rect.top,rect.bottom,rect.width].every(Number.isFinite)||rect.width<=0||duration<0||duration>450||Math.hypot(endX-startX,endY-startY)>8)return null;
  if(endX<rect.left||endX>rect.left+rect.width||endY<rect.top||endY>rect.bottom)return null;
  const position=(endX-rect.left)/rect.width;
  return position<.25?'previous':position>.75?'next':'toggle';
}

export function readerPageTarget({top,height,scrollHeight,direction}){
  const limit=Math.max(0,scrollHeight-height),distance=Math.max(1,height-Math.min(64,height*.15));
  return Math.max(0,Math.min(limit,top+(direction<0?-distance:distance)));
}

export function mountReaderControls(screen,{initiallyVisible=false,appearance}={}){
  const text=screen?.querySelector('#reader-text'),surface=screen?.querySelector('.chapter-reading'),head=screen?.querySelector('.reader-head');
  if(!text||!surface||!head)return {dispose(){},setVisible(){},pageBy(){return false;}};
  const doc=screen.ownerDocument,win=doc.defaultView||globalThis.window;
  const prefs=appearance||{values:()=>appearanceValues('reader'),preview:value=>previewAppearance('reader',value),save:value=>saveAppearance('reader',value)};
  const listeners=[],originalTabindex=screen.getAttribute('tabindex'),originalLabel=screen.getAttribute('aria-label'),originalKeys=screen.getAttribute('aria-keyshortcuts');
  const listen=(target,name,fn,options)=>{target?.addEventListener(name,fn,options);listeners.push(()=>target?.removeEventListener(name,fn,options));};
  const selection=()=>{const selected=win?.getSelection?.()||doc.getSelection?.();return Boolean(selected&&(!selected.isCollapsed||String(selected).length));};
  const modalOpen=()=>Boolean(doc.querySelector('dialog[open]'));
  const element=target=>target?.nodeType===1?target:target?.parentElement;
  const blocked=target=>!element(target)||Boolean(element(target).closest(interactive));
  const now=()=>Date.now();
  let disposed=false,visible=false,atEnd=false,pointer=null,gesture=null,tapTimer=null,saveVersion=0,failedValue=null;
  const pointers=new Set(),portal=doc.createElement('div'),top=doc.createElement('div'),bottom=doc.createElement('div');
  const headPlace=doc.createComment('reader header'),tools=screen.querySelector('.reader-tools'),toolsPlace=doc.createComment('reader hint'),nav=surface.querySelector('.chapter-turner'),navPlace=doc.createComment('reader chapters');
  const endMarker=doc.createElement('span');endMarker.className='reader-chapter-end';endMarker.setAttribute('aria-hidden','true');text.append(endMarker);
  head.before(headPlace);top.className='reader-controls-top';top.append(head);
  if(tools){tools.before(toolsPlace);top.append(tools);}
  const dismiss=doc.createElement('button');dismiss.type='button';dismiss.className='reader-controls-dismiss';dismiss.textContent='收起';dismiss.setAttribute('aria-label','收起阅读工具');(tools||head).append(dismiss);
  bottom.className='reader-controls-bottom';
  const rangeId='reader-size-'+(++nextId);
  bottom.innerHTML=`<div class="reader-quick-layout"><label class="reader-quick-font">字体<select aria-label="阅读字体" data-reader-font>${fonts.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><div class="reader-quick-size"><label for="${rangeId}">字号 <output data-reader-size-output></output></label><div><button type="button" data-reader-size-step="-1" aria-label="减小字号">A−</button><input id="${rangeId}" type="range" min="14" max="36" step="1" aria-label="阅读字号" data-reader-size><button type="button" data-reader-size-step="1" aria-label="增大字号">A＋</button></div></div></div><div class="reader-controls-feedback"><span role="status" aria-live="polite" data-reader-save-status>排版保存在此设备</span><button type="button" data-reader-save-retry hidden>重试保存</button></div>`;
  if(nav){nav.before(navPlace);bottom.append(nav);}
  // Theme/backdrop filters make the app a fixed-position containing block.
  // A body portal keeps these overlays aligned to the measured reader viewport.
  portal.className='reader-controls-portal';portal.append(top,bottom);doc.body.append(portal);screen.classList.add('reader-controls-enabled');
  screen.tabIndex=0;screen.setAttribute('aria-label','原文阅读。按 Enter 显示工具栏，左右方向键或 Page Up、Page Down 翻页。');screen.setAttribute('aria-keyshortcuts','Enter ArrowLeft ArrowRight PageUp PageDown Escape');
  const quick=bottom.querySelector('.reader-quick-layout'),feedback=bottom.querySelector('.reader-controls-feedback'),family=bottom.querySelector('[data-reader-font]'),size=bottom.querySelector('[data-reader-size]'),output=bottom.querySelector('[data-reader-size-output]'),status=bottom.querySelector('[data-reader-save-status]'),retry=bottom.querySelector('[data-reader-save-retry]');
  const sync=()=>{const values=prefs.values();family.value=fonts.some(([font])=>font===values.font)?values.font:'serif';size.value=String(Math.max(14,Math.min(36,Number(values.size)||18)));output.textContent=size.value+' px';for(const button of bottom.querySelectorAll('[data-reader-size-step]'))button.disabled=Number(button.dataset.readerSizeStep)<0?Number(size.value)<=14:Number(size.value)>=36;};
  const persist=value=>{
    const version=++saveVersion;failedValue=null;retry.hidden=true;status.textContent='正在保存排版…';
    let saving;try{saving=prefs.save(value);}catch{saving=Promise.reject();}
    void Promise.resolve(saving).then(()=>{if(!disposed&&version===saveVersion)status.textContent='已保存到此设备';},()=>{if(disposed||version!==saveVersion)return;failedValue=value;status.textContent='排版已预览，保存失败';retry.hidden=false;});
  };
  const update=change=>{const current=prefs.values(),value={...current,...change};if(value.font===current.font&&Number(value.size)===Number(current.size))return;prefs.preview(value);sync();updateChapterEnd();persist(value);};
  listen(family,'change',()=>update({font:family.value}));
  listen(size,'input',()=>update({size:Number(size.value)}));
  for(const button of bottom.querySelectorAll('[data-reader-size-step]'))listen(button,'click',()=>update({size:Math.max(14,Math.min(36,Number(size.value)+Number(button.dataset.readerSizeStep)))}));
  listen(retry,'click',()=>{if(failedValue)persist({...prefs.values()});});
  const viewport=()=>{
    const rect=screen.getBoundingClientRect(),width=win?.innerWidth||doc.documentElement.clientWidth||rect.width,height=win?.innerHeight||doc.documentElement.clientHeight||rect.bottom;
    return {left:Math.max(0,rect.left),top:Math.max(0,rect.top),right:Math.min(width,rect.right),bottom:Math.min(height,rect.bottom),width:Math.max(0,Math.min(width,rect.right)-Math.max(0,rect.left)),height:Math.max(0,Math.min(height,rect.bottom)-Math.max(0,rect.top)),viewportHeight:height};
  };
  const position=()=>{if(disposed||!screen.isConnected)return;const rect=viewport();portal.style.setProperty('--reader-controls-left',rect.left+'px');portal.style.setProperty('--reader-controls-width',rect.width+'px');portal.style.setProperty('--reader-controls-top',rect.top+'px');portal.style.setProperty('--reader-controls-bottom',Math.max(0,rect.viewportHeight-rect.bottom)+'px');};
  const updateChapterEnd=()=>{
    if(disposed)return;
    const rect=viewport();atEnd=rect.height>0&&endMarker.getBoundingClientRect().top<=rect.bottom+2;
    const selected=selection(),hideBottom=selected||(!visible&&(!atEnd||!nav));
    if(hideBottom&&!selected&&bottom.contains(doc.activeElement))screen.focus({preventScroll:true});
    top.hidden=!visible||selected;bottom.hidden=hideBottom;
    quick.hidden=feedback.hidden=!visible;bottom.dataset.readerMode=visible?'full':'chapters';screen.dataset.readerChapterEnd=String(atEnd);
  };
  const setVisible=value=>{
    if(disposed)return;visible=Boolean(value);sync();position();
    if(!visible&&!selection()&&(top.contains(doc.activeElement)||bottom.contains(doc.activeElement)))screen.focus({preventScroll:true});
    updateChapterEnd();screen.dataset.readerControls=visible?'visible':'hidden';
  };
  const cancelTap=()=>{gesture=null;if(tapTimer!==null){clearTimeout(tapTimer);tapTimer=null;}};
  const scroller=()=>{
    for(let node=screen;node&&node!==doc.body;node=node.parentElement){if(node.clientHeight>0&&node.scrollHeight>node.clientHeight+1&&/(auto|scroll)/.test(win?.getComputedStyle?.(node)?.overflowY||''))return node;}
    return doc.scrollingElement||doc.documentElement;
  };
  const pageBy=direction=>{
    if(disposed||selection()||modalOpen())return false;
    const node=scroller(),rect=viewport(),height=Math.max(1,Math.min(node.clientHeight||rect.height,rect.height)),before=node.scrollTop||0;
    const target=readerPageTarget({top:before,height,scrollHeight:node.scrollHeight||height,direction});
    if(target===before){status.textContent=direction<0?'已到本章开头':'已到本章末尾';return false;}
    // Native vertical scrolling remains the only paging mechanism; a tap never
    // jumps to another chapter or changes the selected original text.
    if(typeof node.scrollTo==='function')node.scrollTo({top:target,behavior:'instant'});else node.scrollTop=target;
    updateChapterEnd();
    return true;
  };
  listen(dismiss,'click',()=>setVisible(false));
  listen(screen,'pointerdown',event=>{
    cancelTap();pointers.add(event.pointerId);
    if(pointers.size!==1||event.isPrimary===false||event.button!==0||blocked(event.target)||!surface.contains(element(event.target))||selection()||modalOpen()){pointer=null;return;}
    pointer={id:event.pointerId,x:event.clientX,y:event.clientY,time:now(),target:event.target,scrolled:false};
  });
  listen(screen,'pointermove',event=>{if(pointer?.id===event.pointerId&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>8)pointer=null;},{passive:true});
  listen(screen,'pointerup',event=>{
    pointers.delete(event.pointerId);if(pointer?.id!==event.pointerId)return;
    const start=pointer;pointer=null;
    const action=readerTapAction({startX:start.x,startY:start.y,endX:event.clientX,endY:event.clientY,duration:now()-start.time,rect:viewport(),scrolled:start.scrolled,selected:selection(),blocked:blocked(event.target)||modalOpen()});
    if(action)gesture={action,target:event.target,expires:now()+700};
  });
  const cancelPointer=event=>{pointers.delete(event.pointerId);pointer=null;cancelTap();};
  listen(screen,'pointercancel',cancelPointer);listen(win,'pointercancel',cancelPointer);listen(win,'pointermove',event=>{if(pointer?.id===event.pointerId&&Math.hypot(event.clientX-pointer.x,event.clientY-pointer.y)>8)pointer=null;},{passive:true});listen(win,'pointerup',event=>{pointers.delete(event.pointerId);if(pointer?.id===event.pointerId)pointer=null;});
  listen(screen,'click',event=>{
    if(event.detail>1||!gesture||gesture.expires<now()||gesture.target!==event.target||blocked(event.target)){cancelTap();return;}
    const action=gesture.action;gesture=null;
    tapTimer=setTimeout(()=>{tapTimer=null;if(disposed||selection()||modalOpen())return;if(action==='toggle')setVisible(!visible);else pageBy(action==='previous'?-1:1);},280);
  });
  listen(screen,'dblclick',cancelTap);
  listen(doc,'selectionchange',()=>{if(selection()){pointer=null;cancelTap();if(visible)setVisible(false);}updateChapterEnd();});
  const onLayout=()=>{position();updateChapterEnd();};
  const onScroll=()=>{if(pointer)pointer.scrolled=true;cancelTap();onLayout();};
  listen(screen,'scroll',onScroll,{passive:true});listen(win,'scroll',onScroll,{passive:true});listen(win,'resize',onLayout,{passive:true});listen(win?.visualViewport,'resize',onLayout,{passive:true});listen(win?.visualViewport,'scroll',onLayout,{passive:true});
  listen(screen,'keydown',event=>{
    if(event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||blocked(event.target)||selection()||modalOpen())return;
    if(['PageUp','ArrowLeft','PageDown','ArrowRight'].includes(event.key)){event.preventDefault();pageBy(['PageUp','ArrowLeft'].includes(event.key)?-1:1);}
    else if((event.key==='Enter'||event.key===' ')&&event.target===screen){event.preventDefault();setVisible(!visible);}
  });
  listen(doc,'keydown',event=>{if((screen.contains(event.target)||portal.contains(event.target))&&event.key==='Escape'&&!event.defaultPrevented&&visible&&!selection()&&!modalOpen()&&!element(event.target)?.closest('select,input,textarea,[contenteditable]:not([contenteditable="false"])')){event.preventDefault();setVisible(false);}});
  const observer=typeof win?.ResizeObserver==='function'?new win.ResizeObserver(onLayout):null;observer?.observe(screen);observer?.observe(text);
  setVisible(initiallyVisible);
  return {setVisible,pageBy,dispose(){
    if(disposed)return;disposed=true;cancelTap();listeners.forEach(remove=>remove());observer?.disconnect();dismiss.remove();
    if(headPlace.parentNode){headPlace.replaceWith(head);if(tools&&toolsPlace.parentNode)toolsPlace.replaceWith(tools);if(nav&&navPlace.parentNode)navPlace.replaceWith(nav);}
    portal.remove();endMarker.remove();screen.classList.remove('reader-controls-enabled');delete screen.dataset.readerControls;delete screen.dataset.readerChapterEnd;
    for(const [name,value] of [['tabindex',originalTabindex],['aria-label',originalLabel],['aria-keyshortcuts',originalKeys]])if(value===null)screen.removeAttribute(name);else screen.setAttribute(name,value);
  }};
}
