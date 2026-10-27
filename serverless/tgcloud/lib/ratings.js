import {OWNER_ID,accessRole,rank,nonce} from './permissions.js';
import {moderatorSnapshot} from './bans.js';
import {groupJobs,includesId} from './catalog.js';
import {positive} from './store.js';
import {button,safe} from './ui.js';
import {REVIEW_SCOPE,publicReviews,ratingSummary,ratingLine} from './rating-data.js';
const BACK=[[button('🛡 Панель','admin')]];
const actor=bot=>bot.actor?.id===bot.uid?bot.actor:moderatorSnapshot({id:bot.uid});
const load=async(store,key)=>{const r=await store.db.get("SELECT payload FROM sjc_records WHERE kind='vacancy_review' AND record_key=:key",{':key':key});return r?JSON.parse(r.payload):null;};
const staffSql=`(:actor=${OWNER_ID} OR (EXISTS(SELECT 1 FROM sjc_records WHERE kind='staff_role' AND record_key=:actor_key AND json_extract(payload,'$.role') IN ('moderator','administrator')) AND NOT EXISTS(SELECT 1 FROM sjc_records WHERE kind='user_ban' AND record_key=:actor_key AND COALESCE(json_extract(payload,'$.active'),1)!=0)))`;
const entry=(kind,key,value)=>({kind,key,payload:JSON.stringify(value)});
async function group(bot,id){return groupJobs(await bot.store.jobs()).find(g=>includesId(g,id));}
const idsOf=g=>g.members.map(j=>j.id);
const backJob=id=>[[button('↩️ К вакансии',`job:${id}:short`)]];

export async function submitReview(bot,draft,text){
 if(!positive(bot.uid)||bot.uid!==bot.chat||await bot.store.isBanned(bot.uid))return false;
 const g=await group(bot,draft.job_id);if(!g||g.members.some(j=>j._moderated))return false;
 const ids=idsOf(g),key=Math.min(...ids)+':'+bot.uid,at=new Date().toISOString();
 const review={key,job_id:Math.min(...ids),uid:bot.uid,author:actor(bot),title:g.members[0].title,stars:draft.stars,text,state:'pending',version:draft.token,at};
 if(!Number.isInteger(review.stars)||review.stars<1||review.stars>5||typeof text!=='string'||[...text].length<5||[...text].length>800||!/^[a-z0-9]{8,40}$/.test(draft.token))return false;
 const staff=await bot.store.db.all("SELECT record_key FROM sjc_records WHERE kind='staff_role' AND json_extract(payload,'$.role') IN ('moderator','administrator')");
 const recipients=[...new Set([OWNER_ID,...staff.map(r=>Number(r.record_key)).filter(positive)])];
 const rows=[entry('vacancy_review',key,review),...recipients.map(uid=>entry('review_notice',key+':'+draft.token+':'+uid,{uid,key,version:draft.token,type:'pending',state:'pending',at}))];
 const r=await bot.store.db.run(`WITH allowed AS MATERIALIZED (SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sjc_records WHERE ${REVIEW_SCOPE} AND json_extract(payload,'$.uid')=:uid))
 INSERT INTO sjc_records(kind,record_key,payload) SELECT json_extract(value,'$.kind'),json_extract(value,'$.key'),json_extract(value,'$.payload') FROM json_each(:rows) CROSS JOIN allowed WHERE 1 ON CONFLICT(kind,record_key) DO NOTHING`,{':ids':JSON.stringify(ids),':uid':bot.uid,':rows':JSON.stringify(rows)});
 return r.rowsAffected>0;
}

// State, audit event and durable author notice commit together. The role and
// version are checked by SQLite again, including revoked or forged callbacks.
export async function decideReview(bot,key,version,state){
 const role=await accessRole(bot);if(!rank(role)||!['published','deleted'].includes(state))return false;
 const old=await load(bot.store,key);
 if(!old||old.uid===bot.uid||old.version!==version||!['pending','published'].includes(old.state)||old.state===state)return false;
 const at=new Date().toISOString(),next={...old,state,version:nonce().slice(-12),decided_at:at,moderator:actor(bot)};
 const event={at,action:state==='published'?'review_publish':'review_delete',actor:actor(bot),actor_role:role,target:old.uid,review:key,job_id:old.job_id,stars:old.stars,from:old.state,to:state};
 const rows=[entry('vacancy_review',key,next),entry('staff_audit','review:'+key+':'+next.version,event),entry('review_notice',key+':'+next.version+':'+old.uid,{uid:old.uid,key,version:next.version,type:state,state:'pending',at})];
 await bot.store.pruneStaffAudit();
 const r=await bot.store.db.run(`WITH allowed AS MATERIALIZED (SELECT 1 FROM sjc_records WHERE kind='vacancy_review' AND record_key=:key AND payload=:old AND ${staffSql})
 INSERT INTO sjc_records(kind,record_key,payload) SELECT json_extract(value,'$.kind'),json_extract(value,'$.key'),json_extract(value,'$.payload') FROM json_each(:rows) CROSS JOIN allowed WHERE 1 ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload`,{':key':key,':old':JSON.stringify(old),':actor':bot.uid,':actor_key':String(bot.uid),':rows':JSON.stringify(rows)});
 return r.rowsAffected===3;
}

export async function reviewNoticeTick(store,api,now=Date.now(),recipient=null){
 if(!await store.meta('active'))return {checked:0};
 const rows=await store.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='review_notice' AND json_extract(payload,'$.state')='pending' AND COALESCE(json_extract(payload,'$.retry_at'),0)<=:now AND (:uid IS NULL OR json_extract(payload,'$.uid')=:uid) ORDER BY record_key LIMIT 5",{':now':now,':uid':recipient});
 let checked=0;
 for(const row of rows){
  const notice=JSON.parse(row.payload),lease='review:'+nonce(),lock='user:'+notice.uid;
  if(!await store.lock(lock,lease,180))continue;
  try{
   const review=await load(store,notice.key),allowed=review&&await store.user(notice.uid)&&!await store.isBanned(notice.uid)&&(notice.type!=='pending'||review.state==='pending'&&review.version===notice.version&&rank(await accessRole({uid:notice.uid,chat:notice.uid,store})));
   if(!allowed){await store.db.run("DELETE FROM sjc_records WHERE kind='review_notice' AND record_key=:key AND payload=:old",{':key':row.record_key,':old':row.payload});continue;}
   const claimed=await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.state','sending') WHERE kind='review_notice' AND record_key=:key AND payload=:old",{':key':row.record_key,':old':row.payload});
   if(claimed.rowsAffected!==1)continue;
   let state='sent',retry=0;
   const pending=notice.type==='pending';
   const text=pending?`<b>⭐ Новый отзыв на проверке</b>\n${safe(review.title,140)}\n${review.stars}/5\nАвтор: ${safe(review.author.name,80)}${review.author.username?' · @'+safe(review.author.username,32):''} · ID ${review.uid}\n\n${safe(review.text,800)}`:`Ваш отзыв о вакансии «${safe(review.title,140)}» (${review.stars}/5) ${notice.type==='published'?'опубликован и учтён в рейтинге':'удалён после проверки и не учитывается в рейтинге'}.`;
   try{const sent=await api.sendMessage({chat_id:notice.uid,text,parse_mode:'HTML',reply_markup:{inline_keyboard:pending?[[button('Проверить отзыв',`admin:ratings:view:${notice.key}`)]]:backJob(review.job_id)}});if(!positive(sent?.message_id))state='uncertain';}
   catch(e){state=e.code===429?'pending':e.code===403?'blocked':e.code===400?'failed':'uncertain';if(e.code===429)retry=now+Math.min(3600,Math.max(5,Number(e.parameters?.retry_after)||60))*1000;}
   await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.state',:state,'$.retry_at',:retry) WHERE kind='review_notice' AND record_key=:key AND json_extract(payload,'$.state')='sending'",{':key':row.record_key,':state':state,':retry':retry});checked++;
  }finally{await store.unlock(lock,lease);}
 }
 return {checked};
}

export async function ratingRoute(bot,action){
 let m=/^ratings:([1-9]\d*):(list|start|[1-5])(?::(\d{1,6}))?$/.exec(action);
 if(!m||!positive(Number(m[1])))return bot.home();
 const id=Number(m[1]),g=await group(bot,id);if(!g||g.members.some(j=>j._moderated))return bot.panel('Вакансия недоступна.',[[button('🏠 Меню','menu')]]);
 const ids=idsOf(g),params={':ids':JSON.stringify(ids)},back=backJob(id);
 if(m[2]!=='list'){
  const existing=await bot.store.db.get(`SELECT 1 AS n FROM sjc_records WHERE ${REVIEW_SCOPE} AND json_extract(payload,'$.uid')=:uid`,{...params,':uid':bot.uid});
  if(existing)return bot.panel('Вы уже оставили отзыв на эту вакансию. Повторная оценка не учитывается.',[[button('⭐ Отзывы',`ratings:${id}:list`)],...back]);
  if(m[2]==='start')return bot.panel('<b>Отзыв о вакансии</b>\n\nЕсли вы работали по этой вакансии или проходили собеседование у работодателя, поделитесь своим опытом.\n\nКаждый отзыв проходит ручную проверку перед публикацией. Команда бота может связаться с вами, чтобы уточнить детали и попросить подтверждающие материалы.\n\nКоманда увидит ваше имя, @username и ID. Публично показываются только оценка и текст отзыва.\n\nВыберите оценку: 1 — очень плохо, 5 — отлично.',[[1,2,3,4,5].map(n=>button(n+' ⭐',`ratings:${id}:${n}`)),...back]);
  await bot.patch({pending_input:'vacancy_review',review_draft:{job_id:id,stars:Number(m[2]),token:nonce().slice(-12)}});
  return bot.panel(`<b>Ваша оценка: ${m[2]}/5</b>\n\nНапишите отзыв от 5 до 800 символов о личном опыте работы или собеседования. Перед публикацией его проверит команда; при необходимости с вами свяжутся для уточнений. Не указывайте чужие контакты и личные данные.\n\n/cancel — отменить.`,back);
 }
 const summary=await ratingSummary(bot.store,ids),page=Math.min(Number(m[3]||0),Math.max(0,Math.ceil(summary.count/3)-1));
 const rows=await bot.store.db.all(`SELECT payload FROM (${publicReviews}) WHERE position=1 ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 3 OFFSET :offset`,{...params,':offset':page*3});
 const text='<b>⭐ Отзывы о вакансии</b>\n'+ratingLine(summary)+'\n\n'+(rows.map(r=>{const v=JSON.parse(r.payload);return '⭐'.repeat(v.stars)+'\n'+safe(v.text,800);}).join('\n\n')||'Отзывов пока нет.');
 const nav=[];if(page)nav.push(button('⬅️',`ratings:${id}:list:${page-1}`));if((page+1)*3<summary.count)nav.push(button('➡️',`ratings:${id}:list:${page+1}`));
 return bot.panel(text,[[button('✍️ Оставить отзыв',`ratings:${id}:start`)],...(nav.length?[nav]:[]),...back],bot.mid,false);
}
export async function ratingInput(bot,message){
 if(bot.s.pending_input!=='vacancy_review'||message.text?.startsWith('/'))return false;
 const text=String(message.text||'').trim(),draft=bot.s.review_draft;
 if(!draft){await bot.patch({pending_input:null});await bot.panel('Откройте оценку вакансии заново.');return true;}
 if([...text].length<5||[...text].length>800){await bot.panel('Напишите текст от 5 до 800 символов.',backJob(draft.job_id));return true;}
 const wait=await bot.store.rate(bot.uid+':review',5,3600);
 if(wait){await bot.panel(`Слишком много отзывов. Повторите через ${Math.ceil(wait/60)} мин.`,backJob(draft.job_id));return true;}
 const saved=await submitReview(bot,draft,text);
 await bot.patch({pending_input:null,review_draft:null});
 await bot.panel(saved?'Спасибо! Отзыв отправлен на проверку. После публикации или удаления бот пришлёт уведомление.':'Новый отзыв не добавлен: вы уже оценили вакансию либо она больше недоступна.',backJob(draft.job_id));
 if(saved)try{await reviewNoticeTick(bot.store,bot.api);}catch{/* durable queue resumes in background */}
 return true;
}

export async function ratingsAdmin(bot,action){
 const role=await accessRole(bot);if(!rank(role))return bot.panel('Недостаточно прав.',BACK);
 let m;
 if((m=/^admin:ratings:(p|d|c):([1-9]\d*:[1-9]\d*):([a-z0-9]{8,40})$/.exec(action))){
  if(m[1]==='d')return bot.panel('Удалить отзыв? Он перестанет влиять на рейтинг. Автор получит уведомление.',[[button('🗑 Удалить',`admin:ratings:c:${m[2]}:${m[3]}`)],[button('⬅️ Назад',`admin:ratings:view:${m[2]}`)]]);
  const done=await decideReview(bot,m[2],m[3],m[1]==='p'?'published':'deleted');
  if(done)try{const r=await load(bot.store,m[2]);await reviewNoticeTick(bot.store,bot.api,Date.now(),r.uid);}catch{/* durable author notice remains queued */}
  return bot.panel(done?'Решение сохранено. Уведомление автору поставлено в очередь.':'Отзыв уже изменён, права изменились или вы проверяете свой отзыв.',[[button('⭐ На проверке','admin:ratings:pending:0')],...BACK]);
 }
 if((m=/^admin:ratings:view:([1-9]\d*:[1-9]\d*)$/.exec(action))){
  const r=await load(bot.store,m[1]);if(!r)return bot.panel('Отзыв больше не найден.',BACK);
  const rows=[];if(r.uid!==bot.uid){if(r.state==='pending')rows.push([button('✅ Опубликовать',`admin:ratings:p:${r.key}:${r.version}`)]);if(r.state!=='deleted')rows.push([button('🗑 Удалить',`admin:ratings:d:${r.key}:${r.version}`)]);}
  return bot.panel(`<b>⭐ Проверка отзыва · ${r.stars}/5</b>\n${safe(r.title,140)}\nСтатус: ${{pending:'на проверке',published:'опубликован',deleted:'удалён'}[r.state]}\nАвтор: ${safe(r.author.name,80)}${r.author.username?' · @'+safe(r.author.username,32):''}\nID: ${r.uid}\n\n${safe(r.text,800)}`,[...rows,[{text:'👤 Автор',url:'tg://user?id='+r.uid}],[button('⭐ На проверке','admin:ratings:pending:0')],...BACK],bot.mid,false);
 }
 if((m=/^admin:ratings:log:(\d{1,6})$/.exec(action))){
  if(role!=='owner')return bot.panel('Выгрузка журнала доступна только владельцу.',BACK);
  await bot.store.pruneStaffAudit();
  const page=Number(m[1]),rows=await bot.store.db.all("SELECT payload FROM sjc_records WHERE kind='staff_audit' AND json_extract(payload,'$.action') IN ('review_publish','review_delete') ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 100 OFFSET :offset",{':offset':page*100});
  if(rows.length){const bytes=new Uint8Array((encodeURIComponent(rows.map(r=>r.payload).join('\n')+'\n').match(/%[0-9A-F]{2}|[^%]/g)||[]).map(c=>c[0]==='%'?parseInt(c.slice(1),16):c.charCodeAt(0)));await bot.api.sendDocument({chat_id:bot.uid,document:new bot.InputFile(bytes,`reviews-log-${page+1}.jsonl`,{type:'application/x-ndjson'})});}
  return bot.panel(rows.length?`Файл журнала отправлен: ${rows.length} событий. Хранение — 10 дней.`:'В журнале пока нет событий.',[...(rows.length===100?[[button('Следующий файл',`admin:ratings:log:${page+1}`)]]:[]),...BACK]);
 }
 m=/^admin:ratings:(pending|published|deleted):(\d{1,6})$/.exec(action);if(!m)return bot.panel('Откройте отзывы заново.',BACK);
 const state=m[1],where="kind='vacancy_review' AND json_extract(payload,'$.state')=:state",total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_records WHERE '+where,{':state':state})).n,page=Math.min(Number(m[2]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all('SELECT record_key,payload FROM sjc_records WHERE '+where+' ORDER BY record_key LIMIT 5 OFFSET :offset',{':state':state,':offset':page*5});
 const nav=[];if(page)nav.push(button('⬅️',`admin:ratings:${state}:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:ratings:${state}:${page+1}`));
 return bot.panel(`<b>⭐ Отзывы · ${{pending:'на проверке',published:'опубликованные',deleted:'удалённые'}[state]}</b>\nВсего: ${total}`, [...rows.map(r=>{const v=JSON.parse(r.payload);return [button(`${v.stars} ⭐ · ${String(v.title).slice(0,35)}`,`admin:ratings:view:${r.record_key}`)];}),...(nav.length?[nav]:[]),...['pending','published','deleted'].filter(s=>s!==state).map(s=>[button({pending:'На проверке',published:'Опубликованные',deleted:'Удалённые'}[s],`admin:ratings:${s}:0`)]),...(role==='owner'?[[button('📥 Журнал отзывов (.jsonl)','admin:ratings:log:0')]]:[]),...BACK]);
}
