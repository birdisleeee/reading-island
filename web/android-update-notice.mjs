export function needsAndroidBootstrap(userAgent){return /Android/i.test(userAgent)&&/\bwv\b/i.test(userAgent)&&!/ReadingIslandAndroid\/\d+/.test(userAgent);}
export function validAndroidRelease(info,origin){return info?.schemaVersion===1&&info.packageName==='site.nyachu.reading'&&Number.isSafeInteger(info.versionCode)&&info.versionCode>=2&&typeof info.versionName==='string'&&/^[0-9A-Za-z][0-9A-Za-z. _-]{0,39}$/.test(info.versionName)&&info.apkUrl===`${origin}/download/app.apk?version=${info.versionCode}`&&Number.isSafeInteger(info.bytes)&&info.bytes>0&&info.bytes<=32*1048576&&/^[a-f0-9]{64}$/.test(info.sha256);}
export async function maybeShowAndroidUpdate({userAgent=navigator.userAgent,fetchImpl=fetch,doc=document,origin=location.origin,storage,now=Date.now()}={}){
  if(!needsAndroidBootstrap(userAgent)||doc.querySelector('#android-update-notice'))return;
  try{
    try{storage??=globalThis.localStorage;}catch{}
    const response=await fetchImpl('/download/android-update.json',{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
    if(!response.ok)return;const info=await response.json();if(!validAndroidRelease(info,origin))return;
    const key='ri-android-update-later-'+info.versionCode;let later=0;try{later=Number(storage?.getItem(key)||0);}catch{}
    if(later&&now>=later&&now-later<86400000)return;
    if(doc.querySelector('#android-update-notice'))return;
    const box=doc.createElement('aside');box.id='android-update-notice';box.setAttribute('aria-label','Android 新版提示');
    box.style.cssText='position:fixed;z-index:2000;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));bottom:calc(12px + env(safe-area-inset-bottom));max-width:440px;margin-left:auto;padding:16px;background:#fff8e9;color:#30291f;border:1px solid #b99869;border-radius:18px;box-shadow:0 6px 24px #0003;font:16px/1.5 sans-serif;box-sizing:border-box';
    const title=doc.createElement('strong');title.textContent=`Android 新版 ${info.versionName} 可下载`;
    const text=doc.createElement('p');text.textContent='更新一次后，可在应用内检查并下载安装新版。下载完成后打开安装包覆盖安装，无需卸载。';text.style.cssText='margin:8px 0 12px';
    const link=doc.createElement('a');link.href=info.apkUrl;link.textContent='下载新版 APK';link.style.cssText='display:inline-block;padding:8px 14px;border-radius:22px;background:#855f3c;color:white;text-decoration:none;margin-right:10px';
    const laterButton=doc.createElement('button');laterButton.type='button';laterButton.textContent='稍后';laterButton.style.cssText='font:inherit;padding:8px 12px;border:1px solid #b99869;border-radius:22px;background:transparent;color:#30291f';
    laterButton.onclick=()=>{try{storage?.setItem(key,String(now));}catch{}box.remove();};box.append(title,text,link,laterButton);doc.body.append(box);
  }catch{/* Optional native bootstrap must never block reading or account forms. */}
}
