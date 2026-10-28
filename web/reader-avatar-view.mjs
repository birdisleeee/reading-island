import {escapeHTML as escape} from './visual.mjs';

export function avatarData(value){
  return typeof value==='string'&&value.length<=48*1024&&/^data:image\/jpeg;base64,(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)?value:'';
}
export function readerAvatarContent(profile={}){
  const image=avatarData(profile.avatar_data);
  return image?`<img src="${image}" alt="">`:escape(Array.from(String(profile.username||'读者').trim())[0]||'读');
}
