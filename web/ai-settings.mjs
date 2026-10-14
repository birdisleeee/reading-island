const escape=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const PRESET={api_url:'https://api.deepseek.com/chat/completions',model:'deepseek-flash'};
async function request(path,method='GET',body){const response=await fetch(path,{method,cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok)throw new Error(value.message||'暂时无法读取配置，请重新登录或重试。');return value;}
export async function openAISettings(onSaved){
  let saved;try{saved=await request('/api/ai-settings');}catch(error){alert(error.message);return;}
  const dialog=document.createElement('dialog');dialog.className='ai-settings-dialog';
  dialog.innerHTML=`<form class="ai-settings-form"><header class="dialog-head"><h2>连接自己的 AI</h2><button type="button" data-close aria-label="关闭 AI 接入">×</button></header><div class="dialog-body"><p>部署在你自己的账户，使用你自己的 API Key。</p><label>接口类型<select name="provider"><option value="deepseek">DeepSeek</option><option value="compatible">其他兼容 Chat Completions 的接口</option></select></label><label>API Key<input name="api_key" type="password" autocomplete="off" placeholder="${saved.has_key?'已保存 Key，留空沿用':'填写你自己的 API Key'}"></label><label>阅读伙伴的称呼<input name="name" value="${escape(saved.name)}" maxlength="60" required></label><details class="ai-endpoint"><summary>接口与模型（已预填）</summary><label>完整接口地址<input name="api_url" type="url" value="${escape(saved.api_url)}" required></label><label>模型名称<input name="model" value="${escape(saved.model)}" required maxlength="100"></label></details><details class="persona-preset"><summary>人物预设（可选）</summary><label>身份、性格与回复形式<textarea name="persona" maxlength="12000" placeholder="例如：你是一位温柔但有独立见解的共读伙伴，使用自然对话，先回应我的感受，再提出一个值得讨论的问题。">${escape(saved.persona)}</textarea></label><p class="field-note">每次讨论先采用此预设，再读取议题资料。预设不会改写已有 Agent 的人格或记忆。</p></details><details><summary>共读风格（可选）</summary><label>希望怎样一起讨论<textarea name="system_prompt" maxlength="4000" placeholder="例如：温柔自然地交流，愿意提出不同看法。">${escape(saved.system_prompt)}</textarea></label></details><p class="field-note ai-test-note">测试会用一段示例短文验证文字回复和原文工具，发起少量 API 请求，使用你自己的余额。不会发送书库内容。</p><p role="status" class="ai-settings-status">${saved.configured?'已有通过测试的配置。修改后请重新测试。':'先测试连接，成功后再保存。'}</p></div><footer class="dialog-actions"><button type="button" data-test>测试连接</button><button type="submit" class="primary" disabled>保存并开始共读</button></footer></form>`;
  document.body.append(dialog);const form=dialog.querySelector('form'),provider=form.elements.provider,url=form.elements.api_url,test=dialog.querySelector('[data-test]'),save=dialog.querySelector('[type=submit]'),status=dialog.querySelector('[role=status]');
  provider.value=saved.provider;url.readOnly=provider.value==='deepseek';dialog.querySelector('.ai-endpoint').open=provider.value==='compatible';let proof=null,busy=false,version=0;
  const invalidate=()=>{version++;proof=null;save.disabled=true;if(!busy)status.textContent='配置已修改，请重新测试。';};
  form.addEventListener('input',invalidate);
  provider.addEventListener('change',()=>{if(provider.value==='deepseek'){url.value=PRESET.api_url;form.elements.model.value=PRESET.model;}url.readOnly=provider.value==='deepseek';dialog.querySelector('.ai-endpoint').open=provider.value==='compatible';invalidate();});
  const values=()=>Object.fromEntries(new FormData(form));
  test.addEventListener('click',async()=>{
    if(busy||!form.reportValidity())return;busy=true;test.disabled=true;save.disabled=true;proof=null;const testedVersion=version;status.textContent='正在测试文字回复和原文工具…';
    try{const result=await request('/api/ai-settings/test','POST',values());if(version!==testedVersion){status.textContent='测试期间配置已修改，请重新测试。';return;}proof=result.proof;save.disabled=false;status.textContent=result.message;}
    catch(error){status.textContent=error.message;}finally{busy=false;test.disabled=false;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!proof||busy)return;busy=true;test.disabled=true;save.disabled=true;status.textContent='正在安全保存…';
    try{saved=await request('/api/ai-settings','PUT',{...values(),proof,revision:saved.revision});form.elements.api_key.value='';dialog.close();await onSaved();}
    catch(error){status.textContent=error.message;proof=null;}finally{busy=false;test.disabled=false;}
  });
  dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{form.elements.api_key.value='';dialog.remove();},{once:true});dialog.showModal();
}
