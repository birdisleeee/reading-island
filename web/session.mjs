export async function ensureSession() {
  if ((await fetch('/api/session',{cache:'no-store'})).ok) return;
  const root=document.querySelector('#app');
  root.innerHTML='<section class="empty"><h1>共读岛</h1><p>接入自己的 AI，一起读书。</p><form id="reading-login"><label>访问密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">进入书架</button><p role="status"></p></form></section>';
  await new Promise(resolve=>root.querySelector('form').addEventListener('submit',async event=>{
    event.preventDefault(); const button=root.querySelector('button'),status=root.querySelector('[role=status]');button.disabled=true;
    try {
      const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:new FormData(event.currentTarget).get('password')})});
      if (!response.ok) {status.textContent=response.status===503?'服务尚未配置访问密码。':'密码不正确，请重试。';return;}
      resolve();
    } catch {status.textContent='连接失败，请重试。';} finally {button.disabled=false;}
  }));
}
