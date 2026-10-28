import {cropImage} from './image-cropper.mjs';
import {avatarData,readerAvatarContent} from './reader-avatar-view.mjs';

const encodeBlob=blob=>new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('头像无法读取，请重新选择。'));reader.readAsDataURL(blob);
});
function imageBlob(data){
  if(!avatarData(data))return null;
  const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));
  return new Blob([bytes],{type:'image/jpeg'});
}

// Each asynchronous crop belongs only to the draft and selection that started it.
export function createAvatarDraft({initialData='',isCurrent,onPreview,onTouch,onError,onBusy,crop=cropImage,encode=encodeBlob}){
  let source=imageBlob(initialData),position,run=0,disposed=false,abort;
  async function select(file,initial){
    if(disposed||!isCurrent())return false;
    abort?.abort();const selection=++run;abort=new AbortController();
    const current=()=>!disposed&&selection===run&&isCurrent();
    onTouch();
    onBusy(true);
    try{
      const result=await crop(file,{title:'调整头像',aspect:1,shape:'circle',lockedAspect:true,maxOutputSize:256,outputType:'image/jpeg',outputQuality:.82,maxOutputBytes:35000,initial,signal:abort.signal});
      if(!result||!current())return false;
      const data=await encode(result.blob);
      if(!current())return false;
      if(!avatarData(data))throw new Error('头像无法保存，请重新选择图片。');
      source=file;position=result.crop;onPreview(data);onTouch();return true;
    }catch(error){if(current())onError(error.message||'头像无法读取，请重新选择。');return false;}
    finally{if(current())onBusy(false);}
  }
  return {
    select,
    adjust:()=>source?select(source,position):Promise.resolve(false),
    clear(){if(disposed||!isCurrent())return;run++;abort?.abort();source=null;position=undefined;onPreview('');onTouch();onBusy(false);},
    dispose(){disposed=true;run++;abort?.abort();source=null;position=undefined;},
  };
}

export function bindReaderAvatarEditor(sheet,{profile,isCurrent,onTouch,onError,onBusy,crop,encode}){
  const picker=sheet.querySelector('[data-avatar-file]'),choose=sheet.querySelector('[data-avatar-choose]'),adjust=sheet.querySelector('[data-avatar-adjust]'),replace=sheet.querySelector('[data-avatar-replace]'),menu=sheet.querySelector('[data-avatar-menu]'),control=sheet.querySelector('.profile-avatar-control'),hint=sheet.querySelector('[data-avatar-hint]'),value=sheet.querySelector('[name=avatar_data]'),document=sheet.ownerDocument;
  let disposed=false;
  const current=()=>!disposed&&isCurrent();
  const closeMenu=(focus=false)=>{menu.hidden=true;choose.setAttribute('aria-expanded','false');if(focus&&current())choose.focus();};
  const openMenu=(last=false)=>{if(!current()||!avatarData(value.value))return;menu.hidden=false;choose.setAttribute('aria-expanded','true');(last?replace:adjust).focus();};
  const pick=()=>{if(!current())return;closeMenu(true);picker.value='';picker.click();};
  const refresh=()=>{const hasImage=Boolean(avatarData(value.value));choose.setAttribute('aria-label',hasImage?'调整或更换头像':'选择头像图片');if(hasImage)choose.setAttribute('aria-haspopup','menu');else choose.removeAttribute('aria-haspopup');hint.textContent=hasImage?'点击头像，调整或更换':'点击头像，从相册选图';};
  const draft=createAvatarDraft({initialData:value.value,isCurrent:current,onTouch,onError,onBusy,crop,encode,onPreview:data=>{
    value.value=data;choose.querySelector('[data-avatar-preview]').innerHTML=readerAvatarContent({...profile,avatar_data:data});closeMenu();refresh();
  }});
  choose.onclick=()=>{if(!current())return;if(!avatarData(value.value))pick();else if(menu.hidden)openMenu();else closeMenu(true);};
  picker.onchange=()=>{const file=picker.files?.[0];if(file&&current())void draft.select(file);};
  adjust.onclick=()=>{if(!current())return;closeMenu(true);void draft.adjust();};replace.onclick=pick;
  const outside=event=>{if(!menu.hidden&&!control.contains(event.target))closeMenu();};
  const keys=event=>{
    if(!current())return;
    if(menu.hidden){if(event.target===choose&&['ArrowDown','ArrowUp'].includes(event.key)&&avatarData(value.value)){event.preventDefault();openMenu(event.key==='ArrowUp');}return;}
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);}
    else if(event.key==='Tab')closeMenu(true);
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const first=event.key==='Home'||event.key!=='End'&&document.activeElement===replace;(first?adjust:replace).focus();}
  };
  const dispose=()=>{if(disposed)return;closeMenu();disposed=true;draft.dispose();choose.onclick=picker.onchange=adjust.onclick=replace.onclick=null;document.removeEventListener('pointerdown',outside);sheet.removeEventListener('keydown',keys);sheet.removeEventListener('close',dispose);};
  document.addEventListener('pointerdown',outside);sheet.addEventListener('keydown',keys);sheet.addEventListener('close',dispose,{once:true});refresh();return {dispose};
}
