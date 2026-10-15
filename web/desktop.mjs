import {cropImage} from './image-cropper.mjs';
import { getSession } from './session.mjs';
import {createEditSessions} from './edit-session.mjs';
// Desktop presentation and device-local artwork only. Book data continues through
// the existing reading API; this module never writes books, notes or discussions.
const desktop = matchMedia('(min-width:641px)');
const app = document.getElementById('app');
const root = document.documentElement;
let rail, dialog, picker, imageUrl = '', artwork=null, artSize=100, groups = [], frame = 0, generation = 0;
let homeLayer = null,librarySummary=null;
let artEdits,artVersion=0,artSaves=Promise.resolve();
document.addEventListener('reading-library-summary',event=>{librarySummary=event.detail;schedule();});
document.addEventListener('reading-session',schedule);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fonts = {system:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',rounded:'ui-rounded,"PingFang SC","Microsoft YaHei",sans-serif',mono:'"DM Mono",ui-monospace,monospace',serif:'"Noto Serif SC","Songti SC",serif'};
const request = req => new Promise((resolve,reject) => {req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
function openAppearanceDb(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('reading-island-appearance-v1',1);
    req.onupgradeneeded=()=>{for(const store of ['configs','assets'])if(!req.result.objectStoreNames.contains(store))req.result.createObjectStore(store,{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
  });
}
async function loadAppearance(){
  if(!desktop.matches)return;
  const run=++generation,version=artVersion;
  let db;
  try{
    db=await openAppearanceDb();
    const tx=db.transaction('configs');
    const art=await request(tx.objectStore('configs').get('desktop-reading-hero'));
    if(run!==generation||!desktop.matches||version!==artVersion)return;
    artwork=art?.blob?{blob:art.blob,source:art.source||art.blob,crop:art.crop}:null;artSize=art?.size||100;
    const next=art?.blob instanceof Blob?URL.createObjectURL(art.blob):'';
    if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;
    schedule();
  }catch{/* Existing artwork remains available if local appearance storage is unavailable. */}
  finally{db?.close();}
}
function contrast(hex){
  if(!/^#[0-9a-f]{6}$/i.test(hex))return '#ffffff';
  const c=hex.slice(1).match(/../g).map(x=>{const n=parseInt(x,16)/255;return n<=.03928?n/12.92:((n+.055)/1.055)**2.4;});
  return c.reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0)>.179?'#171412':'#ffffff';
}
function schedule(){if(desktop.matches&&!frame)frame=requestAnimationFrame(refresh);}
const homeObserver=new MutationObserver(schedule);
function refresh(){
  frame=0;if(!desktop.matches||!rail)return;
  const layer=document.querySelector('body > .interface-wallpaper--root');
  if(layer!==homeLayer){homeObserver.disconnect();homeLayer=layer;if(layer)homeObserver.observe(layer,{attributes:true,attributeFilter:['style']});}
  const wallpaper=layer?.style.backgroundImage||'none';
  if(rail.style.getPropertyValue('--desktop-reading-wallpaper')!==wallpaper)rail.style.setProperty('--desktop-reading-wallpaper',wallpaper);
  const sections=[...app.querySelectorAll('.shelf-section[data-group]')];
  if(librarySummary)groups=librarySummary.groups.map(name=>{const books=librarySummary.books.filter(book=>(book.category||'堆放')===name);return {name,count:books.length,unread:books.reduce((total,book)=>total+book.unread,0)};});else if(sections.length)groups=sections.map(section=>({name:section.dataset.group,count:section.querySelectorAll('.book-tile').length}));
  const current=app.dataset.view==='group'?app.querySelector('.group-head h1')?.textContent:'';
  const list=rail.querySelector('.reading-desktop-groups');
  const signature=JSON.stringify([groups,current]);
  if(list.dataset.signature!==signature){
    list.dataset.signature=signature;
    list.innerHTML=groups.map(g=>`<button type="button" data-action="open-group" data-group="${escape(g.name)}" ${g.name===current?'aria-current="page"':''}><span>${escape(g.name)}</span><span class="group-nav-meta"><small>${g.count}</small>${g.unread?`<span class="nav-unread" aria-label="${g.unread} 条未读消息">${g.unread>99?'99+':g.unread}</span>`:''}</span></button>`).join('');
  }
  const shelfButton=rail.querySelector('[data-desktop-books]'),total=groups.reduce((value,group)=>value+(group.unread||0),0);shelfButton.querySelector('.nav-unread')?.remove();if(total){const badge=document.createElement('span');badge.className='nav-unread';badge.textContent=total>99?'99+':String(total);badge.setAttribute('aria-label',total+' 条未读消息');shelfButton.append(badge);}
  rail.querySelector('[data-desktop-books]').setAttribute('aria-current',app.dataset.view==='shelf'?'page':'false');
  rail.querySelector('[data-action="all-notes"]').setAttribute('aria-current',app.dataset.view==='notes'?'page':'false');
  const identity=getSession(),account=rail.querySelector('[data-action="reader-profile"]');
  account.hidden=!identity;
  if(identity){
    account.querySelector('[data-reader-name]').textContent=identity.username||identity.user_id;
    account.querySelector('[data-reader-id]').textContent='ID · '+identity.user_id;
    account.setAttribute('aria-label',`已登录：${identity.username||identity.user_id}，ID ${identity.user_id}，编辑登录资料`);
  }
  const image=app.querySelector('.library-hero img');
  if(image){
    if(!image.dataset.desktopOriginalSrc)image.dataset.desktopOriginalSrc=image.getAttribute('src');
    const src=imageUrl||image.dataset.desktopOriginalSrc;
    if(image.getAttribute('src')!==src)image.setAttribute('src',src);
    image.style.setProperty('--hero-size',artSize+'%');image.setAttribute('role','button');image.tabIndex=0;image.setAttribute('aria-label','替换共读岛插图');image.title='点击替换插图';
  }
}
function ensureDesktop(){
  if(!desktop.matches){
    generation++;dialog?.close();
    const image=app.querySelector('.library-hero img');
    if(image?.dataset.desktopOriginalSrc){image.src=image.dataset.desktopOriginalSrc;image.removeAttribute('role');image.removeAttribute('tabindex');image.removeAttribute('aria-label');image.removeAttribute('title');}
    return;
  }
  if(!rail){
    rail=document.createElement('aside');rail.className='reading-desktop-rail';rail.setAttribute('aria-label','共读岛导航');
    rail.innerHTML=`<div class="reading-desktop-brand">共读岛<small>READING ISLAND</small></div><nav><button type="button" data-desktop-books data-action="open-shelf">书架</button><button type="button" data-action="all-notes">全部札记</button></nav><div class="reading-desktop-group-heading">书籍分组</div><nav class="reading-desktop-groups"></nav><div class="reading-desktop-rail-foot"><button type="button" data-action="manage-groups"><span>管理分组</span><span class="group-manage-add" aria-hidden="true">＋</span></button><button type="button" data-action="settings" data-desktop-settings>设置</button><button type="button" class="reader-account" data-action="reader-profile"><span class="reader-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg></span><span class="reader-account-copy"><small class="reader-login-state">已登录</small><strong data-reader-name></strong><small data-reader-id></small></span></button></div>`;
    document.body.append(rail);
    dialog=document.createElement('dialog');dialog.className='reading-desktop-art-dialog';dialog.setAttribute('aria-labelledby','reading-art-title');
    dialog.innerHTML='<h2 id="reading-art-title">替换共读岛插图？</h2><p>选择新图片后，会替换书架上方的插图。图片仅用于当前电脑的外观。</p><label class="art-size">插图显示大小<input type="range" min="40" max="100" step="1" aria-label="插图显示大小"><output></output></label><div class="reading-art-actions"><button type="button" data-art="adjust">调整裁剪</button><button type="button" data-art="reset">恢复默认图片</button><button type="button" data-art="cancel">取消</button><button type="button" data-art="save">保存大小</button><button type="button" data-art="choose" class="primary">选择图片</button></div>';
    document.body.append(dialog);
    artEdits=createEditSessions({isOpen:()=>dialog.open&&desktop.matches,onSaving:busy=>{for(const button of dialog.querySelectorAll('[data-art=save],[data-art=reset]'))button.disabled=busy;},onSaved:job=>{const unchanged=job.unchanged();if(unchanged)dialog.close();notice(unchanged?'插图设置已保存':'已保存提交时的大小，后续调整尚未保存。');},onError:()=>notice('图片未能保存，请重试。')});
    dialog.addEventListener('cancel',()=>{artVersion++;void loadAppearance();});
    picker=document.createElement('input');picker.type='file';picker.accept='image/png,image/jpeg,image/webp';picker.hidden=true;document.body.append(picker);
    dialog.addEventListener('click',event=>{
      const action=event.target.closest('[data-art]')?.dataset.art;
      if(action==='cancel'){artVersion++;dialog.close();void loadAppearance();}
      if(action==='adjust'&&artwork){artVersion++;dialog.close();void editArtwork(artwork.source,artwork.crop).catch(error=>notice(error.message));}
      if(action==='choose'){artVersion++;dialog.close();picker.value='';picker.click();}
      if(action==='save')void artEdits.run(input=>saveArtwork(input.asset,input.size),()=>({asset:artwork,size:artSize}));
      if(action==='reset')void artEdits.run(()=>{artSize=100;artVersion++;return saveArtwork(null,100);},()=>null);
    });
    picker.addEventListener('change',async()=>{
      const file=picker.files?.[0];if(!file||!desktop.matches)return;
      try{await editArtwork(file);}
      catch(error){notice(error.message||'图片未能保存，请重试。');}
    });
    new MutationObserver(schedule).observe(app,{childList:true,subtree:true,attributes:true,attributeFilter:['data-view']});
    new MutationObserver(schedule).observe(document.body,{childList:true});
    new MutationObserver(schedule).observe(root,{attributes:true,attributeFilter:['style','data-interface-enabled']});
    app.addEventListener('click',event=>{if(desktop.matches&&event.target.matches('.library-hero img'))openReplace();});
    app.addEventListener('keydown',event=>{if(desktop.matches&&event.target.matches('.library-hero img')&&['Enter',' '].includes(event.key)){event.preventDefault();openReplace();}});
  }
  void loadAppearance();schedule();
}
function openReplace(){artVersion++;artEdits.begin({});dialog.querySelector('[data-art=adjust]').disabled=!artwork;const input=dialog.querySelector('input');input.value=artSize;dialog.querySelector('output').textContent=artSize+'%';input.oninput=()=>{artVersion++;artEdits.touch();artSize=Number(input.value);dialog.querySelector('output').textContent=artSize+'%';schedule();};if(!dialog.open)dialog.showModal();}
async function editArtwork(source,initial){const version=artVersion,asset=await cropImage(source,{title:'调整共读岛插图',aspect:310/180,initial});if(!asset||!desktop.matches||version!==artVersion)return;await saveArtwork(asset,artSize);notice('插图已替换');}
function notice(text){const el=document.getElementById('toast');el.textContent=text;el.className='toast';setTimeout(()=>{el.className='';el.textContent='';},2400);}
async function saveArtwork(asset,size){
  const version=artVersion;
  const write=artSaves.then(async()=>{
    const db=await openAppearanceDb();
    try{await new Promise((resolve,reject)=>{const tx=db.transaction('configs','readwrite');tx.objectStore('configs').put({id:'desktop-reading-hero',...(asset||{}),size});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
    finally{db.close();}
  });
  artSaves=write.catch(()=>{});await write;
  if(version===artVersion)await loadAppearance();
}
desktop.addEventListener('change',ensureDesktop);
window.addEventListener('focus',()=>{if(desktop.matches)void loadAppearance();});
window.addEventListener('pageshow',()=>{if(desktop.matches)void loadAppearance();});
ensureDesktop();
