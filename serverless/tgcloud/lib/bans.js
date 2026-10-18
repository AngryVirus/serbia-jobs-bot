import { OWNER_ID,accessRole,rank,mayBan,staffDecision } from './permissions.js';
import { positive } from './store.js';
import { button, safe } from './ui.js';
import { imageHash, renderImage } from './image-renderer.js';
import { deliveryForbidden } from './analytics.js';
const BACK=[[button('🚫 Баны','admin:bans:0')],[button('📊 Админка','admin')]];
const CONTACT={text:'💬 Связаться с @AngryVirus',url:'https://t.me/AngryVirus'};

const active=row=>row && row.active!==false;
const token=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,12);
export function moderatorSnapshot(user) {
 const actor={id:user.id};
 if(typeof user.username==='string' && /^[A-Za-z0-9_]{1,32}$/.test(user.username))actor.username=user.username;
 const name=[user.first_name,user.last_name].filter(v=>typeof v==='string').join(' ').replace(/\s+/g,' ').trim();
 if(name)actor.name=[...name].slice(0,80).join('');
 return actor;
}
const moderator=bot=>bot.actor?.id===bot.uid?bot.actor:{id:bot.uid};
const actorName=actor=>actor?.username?`${safe(actor.name||'',80)}${actor.name?' · ':''}@${safe(actor.username,32)}`:`${safe(actor?.name||'Сотрудник бота',80)} · ID ${positive(actor?.id)?actor.id:OWNER_ID}`;
export const banVersion=row=>row?.version || imageHash(JSON.stringify([row?.uid,row?.at])).slice(0,20);
export async function banRecord(store,uid) {
 const row=await store.db.get("SELECT payload FROM sjc_records WHERE kind='user_ban' AND record_key=:uid",{':uid':String(uid)});
 return row?JSON.parse(row.payload):null;
}
export function banNoticeText(row) {
 const reason=safe(row.reason||'Причина не была указана при блокировке.',300),actor=actorName(row.actor||{id:row.by||OWNER_ID});
 if(active(row))return `<b>Доступ к боту ограничен</b>\n\n<b>Причина:</b> ${reason}\n<b>Решение принял:</b> ${actor}.\n\nПока действует блокировка, функции бота недоступны.\n\nЕсли вы считаете блокировку ошибочной или хотите уточнить её причину, свяжитесь с администратором по кнопке ниже.`;
 return `<b>Доступ к боту восстановлен</b>\n\n<b>Блокировку снял:</b> ${actor}.\n<b>Заблокировал:</b> ${actorName(row.ban_actor||{id:OWNER_ID})}\n<b>Причина прежней блокировки:</b> ${reason}\n\nВы снова можете искать вакансии и пользоваться меню.\n\nЕсли остались вопросы о блокировке, свяжитесь с администратором по кнопке ниже.`;
}
// Caller holds user:<uid>. The receipt lives in the SAME row as the current moderation decision.
// Replacing the decision atomically supersedes an older pending notification.
export async function deliverBanNotice(store,api,InputFile,uid,{contact=false,now=Date.now()}={}) {
 const row=await banRecord(store,uid);
 if(!row?.notice || !positive(uid) || uid===OWNER_ID)return {state:'none'};
 let state=row.notice.state;
 if(state==='blocked' && contact)state='pending'; // Explicit 403 proved that the previous send did not happen.
 if(state!=='pending')return {state};
 if((row.notice.retry_at||0)>now)return {state:'pending'};
 if(!contact && !await store.user(uid))return {state:'waiting_contact'};
 if(typeof InputFile!=='function')return {state:'runtime_unavailable'};
 let photo;
 try {photo=new InputFile(renderImage(banNoticeText(row)).bytes,'moderation.png',{type:'image/png'});}
 catch {return {state:'render_failed'};}
 const changed=await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.notice.state','sending') WHERE kind='user_ban' AND record_key=:uid AND json_extract(payload,'$.version')=:version AND (json_extract(payload,'$.notice.state')='pending' OR (:contact=1 AND json_extract(payload,'$.notice.state')='blocked'))",{':uid':String(uid),':version':row.version,':contact':contact?1:0});
 if(changed.rowsAffected!==1)return {state:'busy'};
 let receipt;
 try {
  const result=await api.sendPhoto({chat_id:uid,photo,reply_markup:{inline_keyboard:[[CONTACT]]}});
  receipt=positive(result?.message_id)?{state:'sent',message_id:result.message_id}:{state:'uncertain'};
 }catch(error){
  if(error.code===429){const delay=Number(error.parameters?.retry_after),seconds=Number.isFinite(delay)&&delay>0?Math.ceil(delay):60;receipt={state:'pending',retry_at:now+seconds*1000};}
  else if(error.code===403){receipt={state:'blocked'};await deliveryForbidden(store,uid,error,now);}
  else receipt={state:error.code===400?'failed':'uncertain'};
 }
 // Timeout, lost acknowledgements and interrupted sending claims are never automatically replayed.
 await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.notice',json(:receipt)) WHERE kind='user_ban' AND record_key=:uid AND json_extract(payload,'$.version')=:version",{':uid':String(uid),':version':row.version,':receipt':JSON.stringify(receipt)});
 return receipt;
}
// A valid private inbound update can deliver a pre-ban or previously rejected notice once.
// It never acknowledges a callback belonging to a banned user or creates their profile.
export async function inboundBanNotice(bot,uid,chat,valid) {
 if(uid===OWNER_ID)return false;
 if(!valid || uid!==chat)return await bot.store.isBanned(uid);
 const current=await banRecord(bot.store,uid);
 if(!current || !['pending','blocked'].includes(current.notice?.state) || !await bot.store.meta('active'))return Boolean(active(current));
 const key='user:'+uid,lease='notice:'+token();
 if(!await bot.store.lock(key,lease,180))return Boolean(await bot.store.isBanned(uid));
 try {await deliverBanNotice(bot.store,bot.api,bot.InputFile,uid,{contact:true});return await bot.store.isBanned(uid);}
 finally {await bot.store.unlock(key,lease);}
}
export async function banNoticeTick(store,api,InputFile,now=Date.now()) {
 if(!await store.meta('active'))return {checked:0};
 const rows=await store.db.all("SELECT record_key FROM sjc_records WHERE kind='user_ban' AND json_extract(payload,'$.notice.state')='pending' AND COALESCE(json_extract(payload,'$.notice.retry_at'),0)<=:now AND EXISTS(SELECT 1 FROM sjc_users WHERE id=CAST(record_key AS INTEGER)) ORDER BY record_key LIMIT 5",{':now':now});
 let checked=0;
 for(const row of rows){const uid=Number(row.record_key);if(!positive(uid)||uid===OWNER_ID)continue;const lease='notice:'+token(),key='user:'+uid;if(!await store.lock(key,lease,180))continue;
  try {await deliverBanNotice(store,api,InputFile,uid,{now});checked++;}finally{await store.unlock(key,lease);}
 }
 return {checked};
}
const deliveryLabel=state=>({sent:'Уведомление доставлено.',waiting_contact:'Уведомление будет показано при первом обращении пользователя.',blocked:'Telegram запретил доставку. Уведомление будет показано, если пользователь снова обратится в бот.',pending:'Уведомление ожидает отправки после ограничения Telegram.',uncertain:'Доставка не подтверждена; автоматического повтора не будет.',sending:'Доставка не подтверждена; автоматического повтора не будет.',runtime_unavailable:'Отправка картинки пока недоступна.',render_failed:'Не удалось подготовить картинку.',failed:'Telegram отклонил уведомление.',busy:'Уведомление уже обрабатывается.'})[state]||'Уведомление уже обработано.';
async function verifiedUsername(api,uid,username) {
 try {const chat=await api.getChat({chat_id:uid});return chat.id===uid && chat.type==='private' && String(chat.username||'').toLowerCase()===username.toLowerCase();}catch{return false;}
}
export async function resolveBanUsername(store,api,username) {
 const cached=await store.db.all("SELECT id FROM sjc_users WHERE lower(json_extract(payload,'$.telegram_username'))=:username LIMIT 6",{':username':username.toLowerCase()});
 if(cached.length>5)return null;
 // Backfill lookup for profiles imported before usernames were recorded, without messages.
 const recent=await store.db.all("SELECT id FROM sjc_users ORDER BY COALESCE(json_extract(payload,'$.last_seen_day'),'') DESC,id LIMIT 30");
 const ids=[...new Set([...cached,...recent].map(r=>r.id))],found=[];
 for(const uid of ids){
  if(await verifiedUsername(api,uid,username)){found.push(uid);if(found.length>1)return null;}
  // A cached match was verified directly; no scan is needed in the normal case.
  if(found.length && cached.some(r=>r.id===uid) && cached.length===1)break;
 }
 if(found.length!==1)return null;
 await store.captureUsername(found[0],username);
 return {uid:found[0],username};
}
export async function banInput(bot,message) {
 if(!['owner_ban','owner_ban_reason'].includes(bot.s.pending_input) || message.text?.startsWith('/'))return false;
 if(!rank(await accessRole(bot))){await bot.patch({pending_input:null,ban_draft:null});await bot.panel('Прав для блокировки больше нет.',BACK);return true;}
 const value=String(message.text||'').trim();
 if(bot.s.pending_input==='owner_ban') {
  let resolved;
  if(/^@[A-Za-z0-9_]{1,32}$/.test(value)){resolved=await resolveBanUsername(bot.store,bot.api,value.slice(1));if(!resolved){await bot.panel('Не удалось однозначно найти и проверить этот @username среди известных боту пользователей. Укажите числовой ID. Telegram не позволяет найти любой личный аккаунт по тегу.',BACK);return true;}}
  const uid=resolved?.uid ?? Number(value);
  if((!resolved && !/^[1-9]\d{0,15}$/.test(value))||!positive(uid)||uid===OWNER_ID){await bot.panel('Введите положительный числовой Telegram ID или @username. Владельца забанить нельзя.',BACK);return true;}
  if(!await mayBan(bot,uid)){await bot.panel('Нельзя блокировать себя или сотрудника с равными либо более высокими правами.',BACK);return true;}
  if(await bot.store.isBanned(uid)){await bot.patch({pending_input:null,ban_target:null});await bot.panel('Пользователь уже забанен. Откройте список банов.',BACK);return true;}
  await bot.patch({pending_input:'owner_ban_reason',ban_target:uid,ban_target_username:resolved?.username||null,ban_draft:null});
  await bot.panel(`<b>Причина блокировки ${uid}${resolved?' · @'+safe(resolved.username,32):''}</b>\n\nОпишите причину понятными словами, до 300 символов. Этот текст увидит пользователь на картинке.\n\n/cancel — отмена.`,BACK);return true;
 }
 const reason=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
 if(!reason||[...reason].length>300){await bot.panel('Введите причину блокировки: от 1 до 300 символов.',BACK);return true;}
 const uid=bot.s.ban_target;if(!positive(uid)||uid===OWNER_ID){await bot.patch({pending_input:null,ban_target:null});await bot.panel('Начните ввод ID заново.',BACK);return true;}
 if(!await mayBan(bot,uid)){await bot.patch({pending_input:null,ban_draft:null});await bot.panel('Недостаточно прав для блокировки этого пользователя.',BACK);return true;}
 const current=await banRecord(bot.store,uid),draft={uid,reason,username:bot.s.ban_target_username||null,token:token(),expected:current?banVersion(current):null};
 await bot.patch({pending_input:null,ban_target:null,ban_draft:draft});
 await bot.panel(`<b>Забанить пользователя ${uid}${draft.username?' · @'+safe(draft.username,32):''}?</b>\n\n<b>Причина:</b> ${safe(reason,300)}\n<b>Исполнитель:</b> ${actorName(moderator(bot))}\n\nПользователь получит одно уведомление картинкой и кнопку связи с администратором. Затем бот перестанет отвечать на сообщения и кнопки, отправлять вакансии и рекламу.`,[[button('🚫 Подтвердить бан',`admin:bans:confirm:${draft.token}`)],...BACK]);return true;
}
export async function banPanel(bot,action) {
 const role=await accessRole(bot);
 if(!rank(role))return bot.panel('Этот раздел доступен только владельцу бота и назначенным сотрудникам.');
 if(action==='admin:bans:new'){
  await bot.patch({pending_input:'owner_ban',ban_target:null,ban_draft:null});
  return bot.panel('<b>🚫 Бан пользователя</b>\n\nВведите числовой Telegram ID или @username известного боту пользователя. Тег будет проверен через Telegram. Следующим шагом укажите причину. Можно забанить ID до первого обращения в бот.\n\n/cancel — отмена.',BACK);
 }
 let match=/^admin:bans:confirm:([a-z0-9]+)$/.exec(action),draft;
 if(match){draft=bot.s.ban_draft;if(!draft||draft.token!==match[1]||!positive(draft.uid)||draft.uid===OWNER_ID||typeof draft.reason!=='string'||!draft.reason.trim()||[...draft.reason].length>300)return bot.panel('Подтверждение устарело. Создайте бан заново.',BACK);}
 const remove=/^admin:bans:remove:([1-9]\d*):([a-z0-9]+)$/.exec(action);
 if(remove && !['owner','administrator'].includes(role))return bot.panel('Разблокировка недоступна для вашей роли.',[[button('🛡 Панель','admin')]]);
 if(match||remove){
  const uid=match?draft.uid:Number(remove[1]);if(!positive(uid)||uid===OWNER_ID)return bot.panel('Некорректный ID. Владельца забанить нельзя.',BACK);
  const key='user:'+uid,lease='ban:'+token();
  if(!await bot.store.lock(key,lease,180))return bot.panel('Пользователь сейчас обрабатывается. Повторите действие через несколько секунд.',[[button('🔄 Повторить',action)],...BACK]);
  let result,stale=false;
  try{
   if(!await mayBan(bot,uid)||(remove&&!['owner','administrator'].includes(await accessRole(bot))))return bot.panel('Недостаточно прав для изменения блокировки этого пользователя.',BACK);
   const current=await banRecord(bot.store,uid);let next;
   if(match){
    if(draft.username && !await verifiedUsername(bot.api,uid,draft.username))stale=true;
    else if(current?.version===draft.token)next=current;
    else if(active(current)||(current?banVersion(current):null)!==draft.expected)stale=true;
    else next={uid,active:true,version:draft.token,reason:draft.reason,target_username:draft.username||null,by:bot.uid,actor:moderator(bot),at:new Date().toISOString(),notice:{state:'pending'}};
   }else{
    const version=remove[2],unbanVersion='u'+version;
    if(current?.active===false && current.version===unbanVersion)next=current;
    else if(!active(current)||banVersion(current)!==version)stale=true;
    else next={uid,active:false,version:unbanVersion,reason:current.reason||null,ban_actor:current.ban_actor||current.actor||{id:current.by||OWNER_ID},by:bot.uid,actor:moderator(bot),at:new Date().toISOString(),notice:{state:'pending'}};
   }
   if(!stale){
    // State transition and its one-shot receipt are one atomic durable SQLite write.
    if(next!==current)await staffDecision(bot.store,'user_ban',uid,next,{action:match?'ban':'unban',actor:moderator(bot),actor_role:await accessRole(bot),target:uid,reason:next.reason,at:next.at});
    result=await deliverBanNotice(bot.store,bot.api,bot.InputFile,uid);
   }
  }finally{await bot.store.unlock(key,lease);}
  if(stale)return bot.panel('Список или подтверждение устарели. Откройте баны заново.',BACK);
  if(match)await bot.patch({ban_draft:null});
  return bot.panel(`${match?'Пользователь '+uid+' забанен.':'Пользователь '+uid+' разбанен.'}\n\n${deliveryLabel(result.state)}`,BACK);
 }
 match=/^admin:bans:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте раздел заново. Для нового бана нужно указать причину.',BACK);
 if(role==='moderator')return bot.panel('<b>🛡 Модератор</b>\n\nВам доступна блокировка обычных пользователей.',[[button('🚫 Забанить пользователя','admin:bans:new')],[button('🛡 Панель','admin')]]);
 await bot.patch?.({ban_draft:null,ban_target:null});
 const where="kind='user_ban' AND COALESCE(json_extract(payload,'$.active'),1)!=0"+(role==='administrator'?" AND record_key NOT IN (SELECT record_key FROM sjc_records WHERE kind='staff_role' AND json_extract(payload,'$.role')='administrator') AND record_key!='"+OWNER_ID+"'":'');
 const total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_records WHERE '+where)).n;
 const page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all('SELECT record_key,payload FROM sjc_records WHERE '+where+' ORDER BY record_key LIMIT 5 OFFSET :offset',{':offset':page*5});
 const controls=rows.map(r=>[button(`Разбанить ${JSON.parse(r.payload).target_username?'@'+JSON.parse(r.payload).target_username:r.record_key}`,`admin:bans:remove:${r.record_key}:${banVersion(JSON.parse(r.payload))}`)]),nav=[];
 if(page)nav.push(button('⬅️',`admin:bans:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:bans:${page+1}`));
 return bot.panel(`<b>🚫 Баны пользователей</b>\n\nВсего: ${total}\n\n${rows.map(r=>r.record_key+(JSON.parse(r.payload).target_username?' · @'+safe(JSON.parse(r.payload).target_username,32):'')+' · '+safe(JSON.parse(r.payload).reason||'Причина не указана',90)).join('\n')||'Список пуст.'}\n\nО блокировке и разблокировке отправляется одно уведомление картинкой. Остальные обращения забаненных игнорируются. Удаление профиля не снимает бан.`,[[button('➕ Забанить по ID / @','admin:bans:new')],...controls,...(nav.length?[nav]:[]),[button('🔄 Обновить',`admin:bans:${page}`)],[button('📊 Админка','admin')]]);
}
