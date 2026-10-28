import {dismissOnOutside} from './dialog-behavior.mjs';
const escape=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const errors={catalog_daily_limit:'今天的搜书或下载次数已用完。',catalog_queue_full:'已有三个任务正在处理，请稍候。',catalog_timeout:'书源响应超时，本次没有取得结果，并不表示书库里没有这本书。可以稍后重试。',catalog_network_error:'未能连接到书源，或读取时连接中断。本次没有取得结果，可以稍后重试。',catalog_http_error:'书源返回了异常响应，本次未能完成。可展开故障信息查看 HTTP 状态。',catalog_rate_limited:'书源暂时限制了请求频率，请稍后再试。',catalog_redirect_rejected:'书源跳转到了不支持的地址，本次操作已停止。',catalog_invalid_response:'书源返回的数据无法正常读取，本次没有取得可用结果。',catalog_service_error:'共读岛服务处理失败，本次操作未完成。请稍后重试。',catalog_unavailable:'本次没有取得书源结果，具体原因未记录。可以稍后重试。',catalog_interrupted:'处理被中断，结果尚未确认。请查看书架后手动重试，同一本书不会重复导入。',catalog_file_too_large:'文件超过 10 MiB，本次未导入。',catalog_invalid_file:'书源没有返回可读取的文本。',catalog_incomplete_file:'未检测到完整原文，本次未导入。',catalog_search_expired:'搜索结果已过期，请重新搜索。',catalog_import_busy:'这本书正在导入，请查看列表。',catalog_version_unavailable:'所选版本未通过公开授权或 UTF-8 全文核验。请另选版本，或上传已有电子书。',record_quota_exceeded:'书籍额度已满，请到设置申请增加配额。',storage_quota_exceeded:'存储不足，请到设置申请增加配额。'};
const diagnosticSources={gutendex:'Gutendex 开放书目',gutenberg:'Gutenberg 正文书源',service:'共读岛服务'};
const diagnosticPhases={request:'发起请求',headers:'接收响应',body:'读取数据',decode:'解析内容',validate:'校验内容',grant_before:'开始前检查权限',search:'查询书库',import:'导入书籍',grant_after:'完成后检查权限',persist:'保存任务结果'};
const diagnosticReasons={timeout:'等待响应超时',dns:'域名解析失败',tls:'安全连接建立失败',connection:'无法连接或连接中断',http:'书源返回异常 HTTP 状态',redirect:'跳转地址不在允许范围',invalid_response:'返回数据格式无效',too_large:'文件超过允许大小',invalid_file:'文件类型或文本无效',incomplete_file:'原文完整性校验未通过',service_error:'服务处理失败',rejected:'当前操作未获允许',unknown:'具体原因未记录'};
const fixedLabel=(labels,key)=>typeof key==='string'&&Object.hasOwn(labels,key)?labels[key]:null;
const errorMessage=(code,fallback)=>fixedLabel(errors,code)||fallback;
function catalogResultNotice(result){
 return typeof result?.notice==='string'&&result.notice.trim()?result.notice.trim():result?.items?.length?'勾选想读的版本，再选择分组导入。':'书目中未匹配到版本，可调整书名、作者或语言，也可以上传已有电子书。';
}
function catalogSnapshotDate(result){
 return typeof result?.catalog_snapshot==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(result.catalog_snapshot)?result.catalog_snapshot:null;
}
function candidateLanguage(item){
 const labels={zh:'中文',en:'英文版本（非中文译本）',fr:'法文',de:'德文',ja:'日文',es:'西班牙文',it:'意大利文',ru:'俄文'};
 return [...new Set((Array.isArray(item.languages)?item.languages:[]).map(language=>fixedLabel(labels,language)||'其他语言'))].join(' / ')||'语言未标注';
}
function catalogTaskResult(job){
 const date=catalogSnapshotDate(job.result),count=job.result.items.length;
 return '<p>'+escape(catalogResultNotice(job.result))+'</p>'+(date?'<small>书目日期：'+escape(date)+'</small>':'')+(count?'<button type="button" data-result="'+escape(job.job_id)+'">查看 '+escape(count)+' 个结果</button>':'');
}
function renderCatalogDiagnostic(job){
 const diagnostic=job.diagnostic,rows=[];
 if(!diagnostic||typeof diagnostic!=='object'||Array.isArray(diagnostic))return '<details class="catalog-fault"><summary>故障信息</summary><p class="field-note">这条旧记录未保留故障细节，无法判定具体原因。</p></details>';
 for(const [label,key,labels] of [['书源','source',diagnosticSources],['阶段','phase',diagnosticPhases],['原因','reason',diagnosticReasons]]){
  const value=fixedLabel(labels,diagnostic[key]);if(value)rows.push(`${label}：${escape(value)}`);
 }
 if(Number.isInteger(diagnostic.status)&&diagnostic.status>=100&&diagnostic.status<=599)rows.push(`HTTP 状态：${escape(diagnostic.status)}`);
 if(Number.isSafeInteger(diagnostic.elapsed_ms)&&diagnostic.elapsed_ms>=0&&diagnostic.elapsed_ms<=180000)rows.push(`耗时：${escape((diagnostic.elapsed_ms/1000).toFixed(1))} 秒`);
 if(Number.isSafeInteger(job.updated_at)&&job.updated_at>=0&&job.updated_at<=8640000000000000)rows.push(`发生时间（北京时间）：${escape(new Date(job.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}`);
 return `<details class="catalog-fault"><summary>故障信息</summary><p class="field-note">${rows.length?rows.join('<br>'):'故障细节未完整记录，无法判定具体原因。'}</p></details>`;
}
async function request(body,signal){
 const response=await fetch('/api/book-catalog/jobs',{method:body?'POST':'GET',cache:'no-store',signal,headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
 const value=await response.json();if(!response.ok)throw Error(errorMessage(value.error,'暂时未能确认操作结果，请查看任务列表后重试。'));return value;
}
export function openBookCatalog({groups=[],onImported}){
 const returnFocus=document.activeElement,dialog=document.createElement('dialog'),controller=new AbortController(),formId=`catalog-search-${crypto.randomUUID()}`;dialog.className='ai-settings-dialog catalog-dialog';
 dialog.innerHTML=`<header class="dialog-head"><h2>搜书与导入</h2><button type="button" data-close aria-label="关闭搜书">×</button></header><div class="dialog-body"><p class="catalog-desktop-only">查询共读岛服务内保存的公开书目快照，不使用 AI，也不需要模型 Key。检索不逐次等待远端书目服务，导入时会检查所选书源与全文。</p><nav class="catalog-tabs catalog-desktop-only" aria-label="搜书页面"><button type="button" data-tab="search" aria-pressed="true">搜索书籍</button><button type="button" data-tab="tasks" aria-pressed="false">查询 / 导入列表</button></nav><section data-search-panel><form id="${formId}" class="catalog-search"><label>书名或作者<input name="query" required minlength="2" maxlength="120" placeholder="输入书名或作者"></label><label>语言<select name="language"><option value="">全部语言</option><option value="zh">中文</option><option value="en">英文</option></select></label><button type="submit" class="primary catalog-desktop-only" data-search-submit data-catalog-primary>搜索</button></form><p role="status" data-search-status aria-live="polite">输入书名或作者后搜索。</p><div class="catalog-results"></div><form class="catalog-import" hidden><label>导入到分组<select name="group_id"><option value="">堆放</option>${groups.map(g=>`<option value="${escape(g.group_id)}">${escape(g.name)}</option>`).join('')}</select></label></form></section><section data-task-panel hidden><p class="catalog-desktop-only">关闭窗口或退出应用后，已提交的任务仍由后端处理。这里保留最近 20 条记录；失败不会自动重试。</p><button type="button" class="catalog-desktop-only" data-refresh>刷新列表</button><p role="status" data-task-status aria-live="polite"></p><div class="catalog-tasks"></div><p class="field-note catalog-help catalog-mobile-only">关闭窗口或退出应用后，已提交的任务仍会处理。这里保留最近 20 条记录；失败不会自动重试。</p></section><details class="catalog-help-details catalog-mobile-only"><summary class="catalog-help-summary">注释：公开书目快照 · 点击查看完整说明</summary><div class="catalog-help-copy"><p>查询共读岛服务内保存的公开书目快照，不使用 AI，也不需要模型 Key。这不是全网实时搜书；检索不逐次等待 Gutendex，导入时才连接并核验所选书源、公开授权与 UTF-8 全文。书目日期会在结果中标明。中文书名也可能匹配英文版本，请先核对语言；英文版本不是中文译本。没有合适版本时，也可以自行上传已有电子书。</p><p>实际发起新检索或下载时扣次，失败也计入；缓存命中或已导入的同一版本不重复扣次。次数每日北京时间 08:00 重置，单文件最多 10 MiB，导入使用现有书籍与存储配额。请选择适合你所在地区使用的作品与版本。</p></div></details><p class="field-note catalog-help catalog-limits catalog-desktop-only">实际发起新检索或下载时扣次，失败也计入；缓存命中或已导入的同一版本不重复扣次。次数每日北京时间 08:00 重置，单文件最多 10 MiB，导入使用现有书籍与存储配额。请选择适合你所在地区使用的作品与版本。</p></div><footer class="dialog-actions catalog-footer"><p class="catalog-usage" role="status" aria-live="polite" data-usage>正在读取今日剩余次数…</p><div class="catalog-footer-actions catalog-mobile-only"><button type="button" class="catalog-secondary-action" data-tab="tasks" data-search-action>查询 / 导入列表 →</button><button type="submit" form="${formId}" class="primary" data-search-submit data-catalog-primary data-search-action>搜索书籍</button><button type="button" class="catalog-secondary-action" data-tab="search" data-task-action hidden>← 返回搜书</button><button type="button" class="primary" data-refresh data-task-action hidden>刷新列表</button></div><div class="catalog-desktop-actions catalog-desktop-only"><button type="button" data-close>暂时离开</button><button type="button" class="primary" data-shelf>刷新书架</button></div></footer>`;
 document.body.append(dialog);dismissOnOutside(dialog);dialog.showModal();
 const form=dialog.querySelector('.catalog-search'),searchButtons=dialog.querySelectorAll('[data-catalog-primary]'),status=dialog.querySelector('[data-search-status]'),results=dialog.querySelector('.catalog-results'),importForm=dialog.querySelector('.catalog-import'),taskStatus=dialog.querySelector('[data-task-status]'),usageStatus=dialog.querySelector('[data-usage]');
 let jobs=[],currentSearch=null,selected='',submitting=false,timer,refreshing=null,lastSignature='',queueRevision=0,usage=null,usageState='loading',shelfRefreshing=null,queryEdited=false;
 const syncedImports=new Set();
 const tab=name=>{const active=document.activeElement;dialog.querySelector('[data-search-panel]').hidden=name!=='search';dialog.querySelector('[data-task-panel]').hidden=name!=='tasks';dialog.querySelectorAll('[data-search-action]').forEach(b=>b.hidden=name!=='search');dialog.querySelectorAll('[data-task-action]').forEach(b=>b.hidden=name!=='tasks');dialog.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===name)));if(active?.closest('[hidden]'))[...dialog.querySelectorAll(name==='search'?'[data-search-submit]':'[data-refresh]')].find(b=>b.getClientRects().length)?.focus();};
 const matchesSearchInput=job=>job?.type==='search'&&job.args.query===form.elements.query.value.trim()&&(job.args.language||'')===form.elements.language.value;
 function selectedSearch(){
  const search=jobs.find(job=>job.job_id===currentSearch);
  return selected&&search?.status==='succeeded'&&matchesSearchInput(search)&&search.result.items.some(item=>item.candidate_id===selected)?search:null;
 }
 function updatePrimaryAction(){
  const importing=Boolean(selectedSearch());
  const queued=jobs.some(job=>['queued','running'].includes(job.status)&&(importing?job.type==='import'&&job.args.candidate_id===selected:matchesSearchInput(job)));
  form.setAttribute('aria-busy',String(submitting||queued));
  searchButtons.forEach(button=>{button.textContent=importing?'导入所选书籍':button.classList.contains('catalog-desktop-only')?'搜索':'搜索书籍';button.disabled=submitting||queued;button.dataset.catalogMode=importing?'import':'search';button.setAttribute('aria-busy',String(submitting||queued));});
 }
 function paintUsage(){
  if(!usage){usageStatus.textContent=usageState==='loading'?'正在读取今日剩余次数…':'今日剩余次数暂时无法读取，请刷新列表。';return;}
  usageStatus.textContent=`今日剩余：搜索 ${usage.searches.remaining} / ${usage.searches.limit} · 下载 ${usage.imports.remaining} / ${usage.imports.limit}${usageState==='stale'?'（暂时无法更新）':usageState==='loading'?'（更新中）':''}`;
 }
 function updateUsage(value){
  const valid=value&&['searches','imports'].every(key=>['remaining','limit','used'].every(field=>Number.isSafeInteger(value[key]?.[field])&&value[key][field]>=0));
  usage=valid?value:null;usageState=valid?'ready':'stale';paintUsage();
 }
 async function syncImported(){
  if(shelfRefreshing||!onImported)return;const completed=jobs.filter(j=>j.type==='import'&&j.status==='succeeded'&&!syncedImports.has(j.job_id));if(!completed.length)return;
  shelfRefreshing=(async()=>{try{await onImported();completed.forEach(j=>syncedImports.add(j.job_id));}catch{if(dialog.open)taskStatus.textContent='书籍已经导入，书架暂时未能刷新。关闭窗口后重新进入书架即可查看。';}finally{shelfRefreshing=null;}})();return shelfRefreshing;
 }
 function paint(){
  const signature=JSON.stringify(jobs);if(signature===lastSignature)return;lastSignature=signature;
  const search=jobs.find(j=>j.job_id===currentSearch)||jobs.find(j=>j.type==='search');
  if(search){
   if(!queryEdited&&!currentSearch&&!form.elements.query.value){form.elements.query.value=search.args.query;form.elements.language.value=search.args.language;}currentSearch=search.job_id;
   const matches=matchesSearchInput(search),ready=matches&&search.status==='succeeded',items=ready?search.result.items:[];
   status.textContent=!matches?'查询条件已修改，请重新搜索后选择版本。':ready?catalogResultNotice(search.result):search.status==='failed'?errorMessage(search.error,'查询失败，请稍后重试。'):'正在查询书目，可以关闭窗口，稍后到列表查看。';
   const snapshot=ready?catalogSnapshotDate(search.result):null;
   results.innerHTML=(snapshot?'<p class="field-note">书目日期：'+escape(snapshot)+'</p>':'')+items.map(item=>`<article class="catalog-result"><label class="catalog-choice"><input type="checkbox" name="candidate" value="${escape(item.candidate_id)}" ${selected===item.candidate_id?'checked':''}><span><strong>${escape(item.title)}</strong><small>${escape(item.author||'作者未标注')} · ${escape(candidateLanguage(item))} · ${item.metadata_snapshot===true||item.requires_verification===true?'导入时核验全文':'TXT 全文'}</small></span></label><a href="${escape(item.source_url)}" target="_blank" rel="noopener noreferrer">查看来源</a></article>`).join('');
   if(!items.some(i=>i.candidate_id===selected))selected='';importForm.hidden=!items.length;
  }
  updatePrimaryAction();
  const states={queued:'排队中',running:'处理中',succeeded:'已完成',failed:'未完成'};
  dialog.querySelector('.catalog-tasks').innerHTML=jobs.map(j=>`<article class="catalog-task"><header><strong>${j.type==='search'?'查询 · '+escape(j.args.query):'导入 · '+escape(j.result?.title||jobs.find(s=>s.job_id===j.args.search_job_id)?.result?.items.find(i=>i.candidate_id===j.args.candidate_id)?.title||'所选书籍')}</strong><span>${escape(fixedLabel(states,j.status)||'状态未知')}</span></header><small>${escape(new Date(j.created_at).toLocaleString('zh-CN'))}</small>${j.status==='failed'?'<p>'+escape(errorMessage(j.error,'任务未完成，可手动重试。'))+'</p>'+renderCatalogDiagnostic(j)+'<button type="button" data-retry="'+escape(j.job_id)+'">重试此任务</button>':''}${j.type==='search'&&j.status==='succeeded'?catalogTaskResult(j):''}${j.type==='import'&&j.status==='succeeded'?'<p>已保存到书架，关闭此窗口即可查看。</p>':''}</article>`).join('')||'<p>还没有查询或导入记录。</p>';
 }
 async function refresh(){
  if(refreshing)return refreshing;if(document.hidden)return;
  const revision=queueRevision;refreshing=(async()=>{try{const value=await request(undefined,controller.signal);if(!dialog.open||revision!==queueRevision)return;jobs=value.items;updateUsage(value.usage);paint();taskStatus.textContent='';void syncImported();}catch{if(dialog.open){taskStatus.textContent='列表暂时无法刷新，已提交的任务不受影响。';usageState='stale';paintUsage();}}finally{refreshing=null;if(dialog.open){clearTimeout(timer);if(revision!==queueRevision||jobs.some(j=>['queued','running'].includes(j.status)))timer=setTimeout(refresh,revision!==queueRevision?0:4000);else if(usage?.reset_at){const reset=Date.parse(usage.reset_at);if(reset>Date.now())timer=setTimeout(refresh,reset-Date.now()+250);}}}})();return refreshing;
 }
 async function submit(input){
  if(submitting||jobs.some(job=>['queued','running'].includes(job.status)&&(input.type==='import'?job.type==='import'&&job.args.candidate_id===input.candidate_id:job.type==='search'&&job.args.query===input.query&&(job.args.language||'')===(input.language||''))))return;
  submitting=true;updatePrimaryAction();usageState='loading';paintUsage();
  try{
   // Closing the dialog does not cancel the short enqueue request or the durable task.
   const job=await request({job_id:crypto.randomUUID(),...input});queueRevision++;if(!dialog.open)return;
   if(job.type==='search'){currentSearch=job.job_id;selected='';}else tab('tasks');jobs=[job,...jobs.filter(j=>j.job_id!==job.job_id)];paint();void refresh();
  }catch(error){if(dialog.open){status.textContent=error.message;taskStatus.textContent=error.message;void refresh();}}
  finally{submitting=false;if(dialog.open)updatePrimaryAction();}
 }
 function activatePrimary(){const search=selectedSearch();if(search)void submit({type:'import',candidate_id:selected,group_id:importForm.elements.group_id.value,search_job_id:search.job_id});else if(form.reportValidity())void submit({type:'search',query:form.elements.query.value.trim(),language:form.elements.language.value});}
 form.onsubmit=event=>{event.preventDefault();activatePrimary();};
 const searchInputChanged=event=>{if(!['query','language'].includes(event.target.name))return;queryEdited=true;selected='';lastSignature='';paint();updatePrimaryAction();};
 form.addEventListener('input',searchInputChanged);form.addEventListener('change',searchInputChanged);
 results.onchange=event=>{if(event.target.name!=='candidate')return;const search=jobs.find(job=>job.job_id===currentSearch);selected=event.target.checked&&search?.status==='succeeded'&&matchesSearchInput(search)&&search.result.items.some(item=>item.candidate_id===event.target.value)?event.target.value:'';results.querySelectorAll('input').forEach(i=>i.checked=i.value===selected);updatePrimaryAction();};
 importForm.onsubmit=event=>{event.preventDefault();activatePrimary();};
 dialog.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.hasAttribute('data-close'))dialog.close();if(b.dataset.tab)tab(b.dataset.tab);if(b.hasAttribute('data-refresh'))void refresh();if(b.dataset.result){currentSearch=b.dataset.result;const job=jobs.find(j=>j.job_id===currentSearch);if(job){form.elements.query.value=job.args.query;form.elements.language.value=job.args.language;}queryEdited=false;selected='';lastSignature='';paint();tab('search');}if(b.dataset.retry&&!submitting){const job=jobs.find(j=>j.job_id===b.dataset.retry);if(job)void submit({type:job.type,...job.args});}if(b.hasAttribute('data-shelf')){b.disabled=true;void onImported().then(()=>{if(dialog.open)dialog.close();}).catch(()=>{if(dialog.open){b.disabled=false;taskStatus.textContent='书架刷新失败，请稍后重试。';tab('tasks');}});}});
 dialog.addEventListener('close',()=>{clearTimeout(timer);controller.abort();dialog.remove();if(returnFocus?.isConnected)returnFocus.focus();},{once:true});window.addEventListener('popstate',()=>dialog.close(),{signal:controller.signal});document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();},{signal:controller.signal});void refresh();return dialog;
}
