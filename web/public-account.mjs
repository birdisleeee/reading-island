const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=[['books','书籍上限'],['threads','议题上限'],['bytes','存储（MiB）'],['requestsPerDay','每日服务请求上限']];
export async function openPublicAccount(drawer,onBack){
  const dialog=drawer('账户与配额',onBack),body=dialog.querySelector('.settings-body');body.innerHTML='<p role="status">正在读取账户…</p>';
  try{
    const response=await fetch('/service/api/me',{cache:'no-store'});if(!response.ok)throw Error('账户暂时无法读取。');
    const {user}=await response.json();if(!dialog.open)return;
    body.innerHTML=`<h3>${escape(user.name)}</h3><p>ID · ${escape(user.username)}</p><dl class="account-quota">${fields.map(([key,label])=>`<div><dt>${label}</dt><dd>${key==='bytes'?user.quota[key]/1048576+' MiB':user.quota[key]}</dd></div>`).join('')}</dl><p>AI 使用你自己的 Key，不设累计调用次数上限。每日服务限流与模型供应商余额分别计算。</p><h3>申请增加配额</h3><p>填写希望获得的总额度，审核期间保留当前额度。</p><form>${fields.map(([key,label])=>`<label>${label}<input type="number" name="${key}" min="0" step="1" required value="${key==='bytes'?user.quota[key]/1048576:user.quota[key]}"></label>`).join('')}<label>扩容说明<textarea name="reason" required maxlength="500"></textarea></label><p role="status"></p><footer><button class="primary" type="submit">提交申请</button></footer></form>`;
    body.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),status=form.querySelector('[role=status]'),data=new FormData(form);button.disabled=true;try{const result=await fetch('/service/api/quota-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quota:Object.fromEntries(fields.map(([key])=>[key,Number(data.get(key))*(key==='bytes'?1048576:1)])),reason:data.get('reason')})});if(!result.ok)throw Error((await result.json()).error||'提交失败');if(dialog.open)status.textContent='已提交，等待审核。';}catch(error){if(dialog.open)status.textContent=error.message;}finally{if(dialog.open)button.disabled=false;}};
  }catch(error){if(dialog.open)body.textContent=error.message;}
}
