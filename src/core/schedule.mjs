// Civil-time schedules, independent of the browser and host machine timezone.
export function normalizeSchedule(input) {
  if(typeof input.enabled!=='boolean'||!['daily','weekly'].includes(input.frequency)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time||''))throw new Error('invalid_schedule');
  if(!Number.isInteger(input.weekday)||input.weekday<0||input.weekday>6)throw new Error('invalid_schedule');
  const timezone=String(input.timezone||'Asia/Shanghai');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new Error('invalid_timezone');}
  const scope=input.scope||'all';if(!['all','group','books','reading'].includes(scope))throw new Error('invalid_scope');
  if(!Array.isArray(input.book_ids||[]))throw new Error('invalid_scope');
  const ids=[...new Set(input.book_ids||[])];if(ids.length>100||ids.some(id=>typeof id!=='string'||!/^[\w-]{1,100}$/.test(id)))throw new Error('invalid_scope');
  const group_id=String(input.group_id||'');if(scope==='group'&&group_id&&!/^[\w-]{1,100}$/.test(group_id))throw new Error('invalid_scope');
  if(input.enabled&&scope==='books'&&!ids.length)throw new Error('empty_book_scope');
  const instruction=String(input.instruction||'请先读取这本书的原文，提出一个具体、值得一起讨论的问题，说明你为何想聊它，邀请我回应。');
  if(!instruction.trim()||instruction.length>2000||!instruction.isWellFormed())throw new Error('invalid_instruction');
  return {enabled:input.enabled,frequency:input.frequency,time:input.time,weekday:input.weekday,timezone,scope,group_id,book_ids:ids,instruction};
}
export function nextOccurrence(schedule,after=Date.now()) {
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:schedule.timezone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});
  const parts=ms=>Object.fromEntries(formatter.formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const local=parts(after),base=Date.UTC(local.year,local.month-1,local.day),[hour,minute]=schedule.time.split(':').map(Number);
  for(let day=0;day<10;day++){
    const civil=new Date(base+day*86400000);if(schedule.frequency==='weekly'&&civil.getUTCDay()!==schedule.weekday)continue;
    const target=Date.UTC(civil.getUTCFullYear(),civil.getUTCMonth(),civil.getUTCDate(),hour,minute);let candidate=target;
    for(let i=0;i<4;i++){const p=parts(candidate),delta=target-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);candidate+=delta;if(!delta)break;}
    // Skip nonexistent local minutes; on fall-back use only the first occurrence.
    const options=[-4,-3,-2,-1,0,1,2,3,4].map(offset=>candidate+offset*1800000).filter(ms=>{const p=parts(ms);return p.year===civil.getUTCFullYear()&&p.month===civil.getUTCMonth()+1&&p.day===civil.getUTCDate()&&p.hour===hour&&p.minute===minute;}).sort((a,b)=>a-b);
    if(options.length&&options[0]>after)return options[0];
  }
  throw new Error('invalid_schedule');
}
