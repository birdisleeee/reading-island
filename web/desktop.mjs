import { readingConfig } from './badge-appearance.mjs';
// Desktop presentation and device-local artwork only. Book data continues through
// the existing reading API; this module never writes books, notes or discussions.
const desktop = matchMedia('(min-width:641px)');
const app = document.getElementById('app');
const root = document.documentElement;
let rail, dialog, picker, imageUrl = '', groups = [], frame = 0, generation = 0;
let homeLayer = null;
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
  const run=++generation;
  let db;
  try{
    db=await openAppearanceDb();
    const tx=db.transaction('configs');
    const [global,art]=await Promise.all([request(tx.objectStore('configs').get('global-style')),request(tx.objectStore('configs').get('desktop-reading-hero'))]);
    if(run!==generation||!desktop.matches)return;
    const v=global?.values||{},ink=/^#[0-9a-f]{6}$/i.test(v.pageTextColor||'')?v.pageTextColor:'#332b22';
    root.style.setProperty('--desktop-reading-ink',ink);
    root.style.setProperty('--desktop-reading-font',fonts[v.fontFamily]||fonts.serif);
    const channels=ink.slice(1).match(/../g).map(x=>parseInt(x,16)/255);
    const light=channels.reduce((n,x,i)=>n+x*[.2126,.7152,.0722][i],0)>.5;
    root.style.setProperty('--desktop-reading-surface-rgb',light?'23,20,18':'255,253,249');
    root.style.setProperty('--desktop-reading-on-accent',contrast(v.interfaceBackgroundColor||v.selfBubbleColor||readingConfig.accent||'#6b4f8a'));
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
  if(sections.length)groups=sections.map(section=>({name:section.dataset.group,count:section.querySelectorAll('.book-tile').length}));
  const current=app.dataset.view==='group'?app.querySelector('.group-head h1')?.textContent:'';
  const list=rail.querySelector('.reading-desktop-groups');
  const signature=JSON.stringify([groups,current]);
  if(list.dataset.signature!==signature){
    list.dataset.signature=signature;
    list.innerHTML=groups.map(g=>`<button type="button" data-action="open-group" data-group="${escape(g.name)}" ${g.name===current?'aria-current="page"':''}><span>${escape(g.name)}</span><small>${g.count}</small></button>`).join('');
  }
  rail.querySelector('[data-desktop-books]').setAttribute('aria-current',app.dataset.view==='shelf'?'page':'false');
  rail.querySelector('[data-action="all-notes"]').setAttribute('aria-current',app.dataset.view==='notes'?'page':'false');
  const ai=rail.querySelector('[data-desktop-ai]');
  const aiLabel=readingConfig.aiConfigured?`${readingConfig.aiName} · AI 设置`:'连接自己的 AI';
  if(ai.textContent!==aiLabel)ai.textContent=aiLabel;
  const image=app.querySelector('.library-hero img');
  if(image){
    if(!image.dataset.desktopOriginalSrc)image.dataset.desktopOriginalSrc=image.getAttribute('src');
    const src=imageUrl||image.dataset.desktopOriginalSrc;
    if(image.getAttribute('src')!==src)image.setAttribute('src',src);
    image.setAttribute('role','button');image.tabIndex=0;image.setAttribute('aria-label','替换共读岛插图');image.title='点击替换插图';
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
    rail.innerHTML=`<div class="reading-desktop-brand">共读岛<small>READING ISLAND</small></div><nav><button type="button" data-desktop-books data-action="open-shelf">书架</button><button type="button" data-action="all-notes">全部札记</button></nav><div class="reading-desktop-group-heading">书籍分组</div><nav class="reading-desktop-groups"></nav><div class="reading-desktop-rail-foot"><button type="button" data-action="create-group">＋ 新建分组</button><button type="button" data-action="manage-groups">管理分组</button><button type="button" data-action="ai-settings" data-desktop-ai>连接自己的 AI</button><a href="${escape(readingConfig.returnUrl)}">‹ 返回首页</a></div>`;
    document.body.append(rail);
    dialog=document.createElement('dialog');dialog.className='reading-desktop-art-dialog';dialog.setAttribute('aria-labelledby','reading-art-title');
    dialog.innerHTML='<h2 id="reading-art-title">替换共读岛插图？</h2><p>选择新图片后，会替换书架上方的插图。图片仅用于当前电脑的外观。</p><div class="reading-art-actions"><button type="button" data-art="reset">恢复默认图片</button><button type="button" data-art="cancel">取消</button><button type="button" data-art="choose" class="primary">选择图片</button></div>';
    document.body.append(dialog);
    picker=document.createElement('input');picker.type='file';picker.accept='image/png,image/jpeg,image/webp';picker.hidden=true;document.body.append(picker);
    dialog.addEventListener('click',event=>{
      const action=event.target.closest('[data-art]')?.dataset.art;
      if(action==='cancel')dialog.close();
      if(action==='choose'){dialog.close();picker.value='';picker.click();}
      if(action==='reset')void saveArtwork(null).then(()=>{dialog.close();notice('已恢复默认插图');}).catch(()=>notice('图片未能保存，请重试。'));
    });
    picker.addEventListener('change',async()=>{
      const file=picker.files?.[0];if(!file||!desktop.matches)return;
      try{const blob=await normalizeArtwork(file);if(!desktop.matches)return;await saveArtwork(blob);notice('插图已替换');}
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
function openReplace(){if(!dialog.open)dialog.showModal();}
function notice(text){const el=document.getElementById('toast');el.textContent=text;el.className='toast';setTimeout(()=>{el.className='';el.textContent='';},2400);}
async function normalizeArtwork(file){
  if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>8*1024*1024)throw new Error('请选择 8 MB 以内的 PNG、JPEG 或 WebP 图片。');
  const bitmap=await createImageBitmap(file).catch(()=>{throw new Error('无法读取这张图片，请重新选择。');});
  try{
    if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>100000000)throw new Error('图片尺寸过大，请选择较小的图片。');
    const ratio=Math.min(1,1440/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('无法保存这张图片，请重新选择。');return blob;
  }finally{bitmap.close();}
}
async function saveArtwork(blob){
  const db=await openAppearanceDb();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction('configs','readwrite');if(blob)tx.objectStore('configs').put({id:'desktop-reading-hero',blob});else tx.objectStore('configs').delete('desktop-reading-hero');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  finally{db.close();}
  await loadAppearance();
}
desktop.addEventListener('change',ensureDesktop);
window.addEventListener('focus',()=>{if(desktop.matches)void loadAppearance();});
window.addEventListener('pageshow',()=>{if(desktop.matches)void loadAppearance();});
ensureDesktop();
