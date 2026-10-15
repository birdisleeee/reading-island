let currentSession = null;
export const getSession = () => currentSession;
export function updateSession(profile) {
  currentSession = { ...currentSession, ...profile };
  document.dispatchEvent(new CustomEvent('reading-session', { detail: currentSession }));
  return currentSession;
}
async function readSession(response) {
  const profile = await response.json();
  if (!profile.user_id) throw new Error('登录信息不完整，请重新登录。');
  return updateSession(profile);
}
export async function ensureSession() {
  const session = await fetch('/api/session',{cache:'no-store'});
  if (session.ok) return readSession(session);
  if (session.status !== 401) throw new Error('暂时无法确认登录状态，请重试。');
  const root=document.querySelector('#app');
  root.innerHTML='<section class="empty"><h1>共读岛</h1><p>接入自己的 AI，一起读书。</p><form id="reading-login"><label>访问密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">进入书架</button><p role="status"></p></form></section>';
  await new Promise(resolve=>root.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault(); const button=root.querySelector('button'),status=root.querySelector('[role=status]');button.disabled=true;
    try {
      const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:new FormData(event.currentTarget).get('password')})});
      if (!response.ok) {status.textContent=response.status===503?'服务尚未配置访问密码。':'密码不正确，请重试。';return;}
      const verified=await fetch('/api/session',{cache:'no-store'});
      if(!verified.ok)throw new Error('Session unavailable');
      resolve(await readSession(verified));
    } catch {status.textContent='连接失败，请重试。';} finally {button.disabled=false;}
  }));
}
