import {readerAvatarContent} from './reader-avatar-view.mjs';
const escape=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function startupView(profile=null,message='正在确认登录状态…',retry=false){
  return `<section class="startup-center" aria-label="个人中心加载"><div class="startup-identity"><div class="startup-avatar" aria-hidden="true">${profile?readerAvatarContent(profile):'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="24" cy="17" r="8"/><path d="M9 42v-4a15 15 0 0 1 30 0v4"/></svg>'}</div><h1>${escape(profile?.username)||'个人中心'}</h1>${profile?`<p class="startup-id">ID · ${escape(profile.login_id||profile.user_id)}</p>`:''}<p class="startup-status" role="status">${escape(message)}</p>${retry?'<button class="primary" type="button">重新加载</button>':''}</div></section>`;
}

// A bounded decode gate avoids revealing the first frame with undecoded wallpaper.
export async function prepareInitialArtwork(urls,{ImageClass=globalThis.Image,timeout=1200}={}){
  if(!ImageClass)return;
  let timer;
  const seen=new Set();
  const images=urls.filter(Boolean).map(async source=>{try{const value=await source;await Promise.all((Array.isArray(value)?value:[value]).filter(Boolean).map(async src=>{if(seen.has(src))return;seen.add(src);const image=new ImageClass();image.src=src;await image.decode();}));}catch{/* The UI remains usable when optional artwork cannot be loaded or decoded. */}});
  try{await Promise.race([Promise.all(images),new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);}finally{clearTimeout(timer);}
}
