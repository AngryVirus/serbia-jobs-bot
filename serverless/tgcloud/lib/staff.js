import {ratingsAdmin} from './ratings.js';
import { OWNER_ID,accessRole,rawRole,roleRecord,rank,mayBan as mayBanUser,mayManage,staffDecision,nonce,ROLE_NAMES } from './permissions.js';
import { ownerRoute } from './owner.js';
import { banPanel,banInput,banRecord,banVersion,resolveBanUsername,moderatorSnapshot } from './bans.js';
import { positive } from './store.js';
import { button,safe } from './ui.js';
import { belgradeOffset } from './filters.js';
const BACK=[[button('🛡 Панель','admin')],[button('🏠 Меню','menu')]];
const actor=bot=>bot.actor?.id===bot.uid?bot.actor:moderatorSnapshot({id:bot.uid});
export function roleNoticeText(before,after,by){
 const lines=[];
 if(before==='moderator'&&after==='administrator')lines.push('Вы повышены с модератора до администратора @SerbiaJobsBot.');
 else if(before==='administrator'&&after==='moderator')lines.push('Вы понижены с администратора до модератора @SerbiaJobsBot.');
 else if(after==='user')lines.push(`С вас сняты полномочия ${before==='moderator'?'модератора':'администратора'} @SerbiaJobsBot.`);
 else lines.push(`Вы назначены ${after==='moderator'?'модератором':'администратором'} @SerbiaJobsBot.`);
 if(after==='moderator')lines.push('Вы можете проверять отзывы и блокировать обычных пользователей.');
 if(after==='administrator')lines.push('Вы можете проверять отзывы, блокировать и разблокировать пользователей, назначать и снимать модераторов.');
 lines.push(`Кто изменил права: ${by?.name||'Сотрудник'}${by?.username?' · @'+by.username:''} · ID ${by?.id}.`);
 lines.push(after==='user'?'Раздел управления командой и модерацией для вас закрыт.':'Для работы откройте панель управления кнопкой ниже.');
 return lines.join('\n\n');
}
// Callers hold user:<uid>. A versioned claim precedes the API call, so a crash
// with an unknown delivery outcome cannot repeat a notification or replace a role.
export async function deliverRoleNotice(store,api,uid,now=Date.now()){
 const row=await roleRecord(store,uid),notice=row?.notice;
 if(notice?.state!=='pending'||(notice.retry_at||0)>now)return {state:notice?.state||'none'};
 const before=notice.before,after=row.role||'user';
 if(!['user','moderator','administrator'].includes(before)||!['user','moderator','administrator'].includes(after))return {state:'invalid'};
 const claimed=await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.notice.state','sending') WHERE kind='staff_role' AND record_key=:uid AND json_extract(payload,'$.version')=:version AND json_extract(payload,'$.notice.state')='pending'",{':uid':String(uid),':version':row.version});
 if(claimed.rowsAffected!==1)return {state:'busy'};
 let receipt;
 try{
  const message=await api.sendMessage({chat_id:uid,text:roleNoticeText(before,after,row.actor),reply_markup:{inline_keyboard:[[button(after==='user'?'🏠 Меню':'🛡 Панель управления',after==='user'?'menu':'admin')]]}});
  receipt=positive(message?.message_id)?{state:'sent',message_id:message.message_id}:{state:'unconfirmed'};
 }catch(error){
  if(error.code===429){const delay=Number(error.parameters?.retry_after),seconds=Number.isFinite(delay)&&delay>0?Math.ceil(delay):60;receipt={state:'pending',retry_at:now+seconds*1000};}
  else receipt={state:error.code===403?'blocked':error.code===400?'failed':'unconfirmed'};
 }
 await store.db.run("UPDATE sjc_records SET payload=json_set(payload,'$.notice',json(:notice)) WHERE kind='staff_role' AND record_key=:uid AND json_extract(payload,'$.version')=:version AND json_extract(payload,'$.notice.state')='sending'",{':uid':String(uid),':version':row.version,':notice':JSON.stringify({...receipt,before})});
 return receipt;
}
export async function roleNoticeTick(store,api,now=Date.now()){
 if(!await store.meta('active'))return {checked:0};
 const rows=await store.db.all("SELECT record_key FROM sjc_records WHERE kind='staff_role' AND json_extract(payload,'$.notice.state')='pending' AND COALESCE(json_extract(payload,'$.notice.retry_at'),0)<=:now ORDER BY record_key LIMIT 5",{':now':now});
 let checked=0;
 for(const row of rows){const uid=Number(row.record_key);if(!positive(uid)||uid===OWNER_ID)continue;
  const key='user:'+uid,lease='role-notice:'+nonce();if(!await store.lock(key,lease,180))continue;
  try{await deliverRoleNotice(store,api,uid,now);checked++;}finally{await store.unlock(key,lease);}
 }
 return {checked};
}
async function memberName(bot,uid){
 const user=await bot.store.user(uid);
 return String(uid)+(user?.telegram_username?' · @'+user.telegram_username:'');
}
async function roleDraft(bot,uid,desired,current,currentRole,username=null){
 const draft={uid,desired,username,expected:current?.version||null,token:nonce()};
 await bot.patch({pending_input:null,staff_draft:draft});
 return bot.panel(`<b>Подтвердить изменение прав?</b>\n\nПользователь: ${safe(await memberName(bot,uid),100)}\nТекущая роль: ${ROLE_NAMES[currentRole]}\nНовая роль: ${ROLE_NAMES[desired]}`,[[button('✅ Подтвердить',`admin:team:confirm:${draft.token}`)],[button('⬅️ Команда','admin:team:0')],...BACK]);
}
export function staffHomeDocument(role){
 if(role==='moderator')return ['<b>🛡 Модератор</b>\n\nВы можете проверять отзывы и блокировать обычных пользователей. Разблокировка и управление сотрудниками недоступны.',[[button('⭐ Отзывы','admin:ratings:pending:0')],[button('🚫 Забанить пользователя','admin:bans:new')],[button('🏠 Меню','menu')]]];
 return ['<b>🛡 Администратор</b>\n\nВы можете проверять отзывы, блокировать и разблокировать пользователей, назначать и снимать модераторов.',[[button('⭐ Отзывы','admin:ratings:pending:0')],[button('🚫 Забанить пользователя','admin:bans:new')],[button('🔓 Баны и разблокировка','admin:bans:0')],[button('👥 Модераторы','admin:team:0')],[button('🏠 Меню','menu')]]];
}
export async function staffRoute(bot,action){
 const role=await accessRole(bot);
 if(!rank(role))return bot.panel('Этот раздел доступен только владельцу бота и назначенным сотрудникам.',[[button('🏠 Меню','menu')]]);
 if(action.startsWith('admin:ratings:'))return ratingsAdmin(bot,action);
 if(action.startsWith('admin:people:'))return usersPanel(bot,action);
 if(action.startsWith('admin:team:'))return teamPanel(bot,action);
 if(action.startsWith('admin:audit:'))return auditPanel(bot,action);
 if(role==='owner')return ownerRoute(bot,action);
 if(action==='admin')return bot.panel(...staffHomeDocument(role));
 if(action.startsWith('admin:bans:'))return banPanel(bot,action);
 return bot.panel('Недостаточно прав для этого действия.',BACK);
}
export async function staffInput(bot,message){
 if(bot.s.pending_input==='owner_user_find')return usersInput(bot,message);
 if(bot.s.pending_input!=='staff_target'||message.text?.startsWith('/'))return false;
 const role=await accessRole(bot),desired=bot.s.staff_desired;
 if(!['moderator','administrator'].includes(desired)||!mayManage(role,'user',desired)){await bot.patch({pending_input:null,staff_draft:null});await bot.panel('Прав для назначения этой роли больше нет.',BACK);return true;}
 const value=String(message.text||'').trim();let resolved;
 if(/^@[A-Za-z0-9_]{1,32}$/.test(value)){resolved=await resolveBanUsername(bot.store,bot.api,value.slice(1));if(!resolved){await bot.panel('Не удалось проверить @username. Укажите числовой ID известного вам пользователя.',BACK);return true;}}
 const uid=resolved?.uid??Number(value);
 if((!resolved&&!/^[1-9]\d{0,15}$/.test(value))||!positive(uid)||uid===OWNER_ID||uid===bot.uid){await bot.panel('Укажите ID или проверяемый @username другого пользователя. Права владельца изменять нельзя.',BACK);return true;}
 const currentRole=await rawRole(bot.store,uid),current=await roleRecord(bot.store,uid);
 if(!mayManage(role,currentRole,desired)||await bot.store.isBanned(uid)){await bot.panel('Этому пользователю нельзя выдать выбранную роль: проверьте его текущие права и блокировку.',BACK);return true;}
 if(currentRole===desired){await bot.patch({pending_input:null});await bot.panel('Эта роль у пользователя уже есть.',BACK);return true;}
 await roleDraft(bot,uid,desired,current,currentRole,resolved?.username||null);return true;
}
const USERS_BACK=[[button('⬅️ Пользователи','admin:users')]];
const userLabel=(uid,user)=>user?.telegram_username?'@'+user.telegram_username+' · '+uid:String(uid);
async function userCard(bot,uid,page=0){
 const user=await bot.store.user(uid);
 if(!user)return bot.panel('Профиль больше не найден. Возможно, пользователь удалил свои данные.',[[button('⬅️ К списку',`admin:people:${page}`)]]);
 const role=await rawRole(bot.store,uid),ban=await banRecord(bot.store,uid),isBanned=await bot.store.isBanned(uid),rows=[];
 if(await mayBanUser(bot,uid)){
  rows.push([button(isBanned?'✅ Разблокировать':'🚫 Заблокировать',isBanned?`admin:bans:remove:${uid}:${banVersion(ban)}`:`admin:people:ban:${uid}`)]);
 }
 if(uid!==OWNER_ID){
  if(role==='user'&&!isBanned)rows.push([button('Назначить модератором',`admin:people:role:${uid}:moderator`)],[button('Назначить администратором',`admin:people:role:${uid}:administrator`)]);
  else if(role!=='user')rows.push([button('🛡 Изменить полномочия',`admin:team:view:${uid}`)]);
 }
 const delivery=user.delivery_status==='blocked'?'пользователь заблокировал бота':user.delivery_status==='deactivated'?'аккаунт деактивирован':user.settings?.bot_blocked?'сообщения недоступны':'отказов доставки не зафиксировано';
 return bot.panel(`<b>👤 Пользователь</b>\n\n${safe(userLabel(uid,user),100)}\nРоль: ${ROLE_NAMES[role]}\nДоступ: ${isBanned?'заблокирован командой':'открыт'}${isBanned?'\nПричина: '+safe(ban?.reason||'не указана',300):''}\nДоставка: ${delivery}\nПоследнее обращение (UTC): ${safe(user.last_seen_day||'нет данных',20)}`,[...rows,[button('⬅️ К списку',`admin:people:${page}`)]]);
}
export async function usersInput(bot,message){
 if(bot.s.pending_input!=='owner_user_find'||message.text?.startsWith('/'))return false;
 if(await accessRole(bot)!=='owner'){
  await bot.patch({pending_input:null});await bot.panel('Список пользователей доступен только владельцу.',[[button('🏠 Меню','menu')]]);return true;
 }
 const value=String(message.text||'').trim();let uid;
 if(/^@[A-Za-z0-9_]{1,32}$/.test(value))uid=(await resolveBanUsername(bot.store,bot.api,value.slice(1)))?.uid;
 else if(/^[1-9]\d{0,15}$/.test(value)&&positive(Number(value)))uid=Number(value);
 if(!uid||!await bot.store.user(uid)){
  await bot.panel('Пользователь не найден. Введите ID или @username человека, который уже открывал бот. Тег должен подтверждаться Telegram; можно указать числовой ID.',[[button('⬅️ К списку','admin:people:0')]]);return true;
 }
 await bot.patch({pending_input:null});await userCard(bot,uid);return true;
}
export async function usersPanel(bot,action){
 // Check the numeric owner and private chat even for forged direct callbacks.
 if(await accessRole(bot)!=='owner')return bot.panel('Список пользователей доступен только владельцу.',[[button('🏠 Меню','menu')]]);
 if(action==='admin:people:find'){
  await bot.patch({pending_input:'owner_user_find',ban_draft:null,staff_draft:null});
  return bot.panel('<b>🔎 Найти пользователя</b>\n\nВведите Telegram ID или @username человека, который уже открывал бот.\n\n/cancel — отменить.',[[button('⬅️ К списку','admin:people:0')]]);
 }
 let match=/^admin:people:view:([1-9]\d{0,15}):(\d{1,6})$/.exec(action);
 if(match&&positive(Number(match[1])))return userCard(bot,Number(match[1]),Number(match[2]));
 match=/^admin:people:ban:([1-9]\d{0,15})$/.exec(action);
 if(match&&positive(Number(match[1]))&&await bot.store.user(Number(match[1]))){
  // Reuse the existing permission, reason, confirmation and one-shot notice flow.
  await bot.patch({pending_input:'owner_ban',ban_draft:null});
  return banInput(bot,{text:match[1]});
 }
 match=/^admin:people:role:([1-9]\d{0,15}):(moderator|administrator)$/.exec(action);
 if(match){
  const uid=Number(match[1]),desired=match[2],role=await rawRole(bot.store,uid);
  if(!positive(uid)||uid===OWNER_ID||!await bot.store.user(uid)||role!=='user'||await bot.store.isBanned(uid))return bot.panel('Профиль или права изменились. Откройте карточку заново.',USERS_BACK);
  return roleDraft(bot,uid,desired,await roleRecord(bot.store,uid),role);
 }
 match=/^admin:people:(\d{1,6})$/.exec(action);
 if(!match)return bot.panel('Откройте список пользователей заново.',USERS_BACK);
 if(!bot.readOnly)await bot.patch({pending_input:null,ban_draft:null,staff_draft:null});
 const total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_users')).n,page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 // Bounded page, ordered by the indexed numeric ID. No catalog or Telegram calls.
 const users=await bot.store.db.all('SELECT id,json_extract(payload,\'$.telegram_username\') AS username FROM sjc_users ORDER BY id LIMIT 5 OFFSET :offset',{':offset':page*5});
 const rows=users.map(u=>[button(userLabel(u.id,{telegram_username:u.username}),`admin:people:view:${u.id}:${page}`)]),nav=[];
 if(page)nav.push(button('⬅️',`admin:people:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:people:${page+1}`));
 return bot.panel(`<b>🔎 Список пользователей</b>\n\nВсего: ${total}${total?' · Страница '+(page+1)+' из '+Math.ceil(total/5):''}\n\n${total?'Выберите пользователя: откроются его роль, статус и доступные действия.':'Пользователей пока нет.'}`, [...rows,...(nav.length?[nav]:[]),[button('🔎 Найти по ID / @','admin:people:find')],...USERS_BACK]);
}
export async function teamPanel(bot,action){
 const role=await accessRole(bot);
 if(!['owner','administrator'].includes(role))return bot.panel('Управление сотрудниками недоступно.',BACK);
 let match=/^admin:team:add:(moderator|administrator)$/.exec(action);
 if(match){if(!mayManage(role,'user',match[1]))return bot.panel('Назначать администраторов может только владелец.',BACK);
  await bot.patch({pending_input:'staff_target',staff_desired:match[1],staff_draft:null});
  return bot.panel(`<b>${match[1]==='moderator'?'Назначить модератора':'Назначить администратора'}</b>\n\nВведите числовой Telegram ID или @username известного боту пользователя. Затем подтвердите назначение.`,BACK);
 }
 const view=/^admin:team:view:([1-9]\d*)$/.exec(action),edit=/^admin:team:set:([1-9]\d*):([a-z0-9]+):(moderator|administrator|user)$/.exec(action);
 if(view||edit){
  const uid=Number((view||edit)[1]),current=await roleRecord(bot.store,uid),currentRole=await rawRole(bot.store,uid);
  if(!positive(uid)||uid===OWNER_ID||uid===bot.uid||!['moderator','administrator'].includes(currentRole)||!mayManage(role,currentRole,'user'))return bot.panel('Управление этим сотрудником недоступно.',BACK);
  if(edit){
   const desired=edit[3];
   if(current?.version!==edit[2]||currentRole===desired||!mayManage(role,currentRole,desired)||(desired!=='user'&&await bot.store.isBanned(uid)))return bot.panel('Права изменились или действие недоступно. Откройте карточку заново.',[[button('⬅️ Команда','admin:team:0')],...BACK]);
   return roleDraft(bot,uid,desired,current,currentRole);
  }
  await bot.patch({pending_input:null,staff_draft:null});
  const rows=[];
  if(role==='owner')rows.push([button(currentRole==='moderator'?'⬆️ Повысить до администратора':'⬇️ Понизить до модератора',`admin:team:set:${uid}:${current.version}:${currentRole==='moderator'?'administrator':'moderator'}`)]);
  rows.push([button('❌ Снять полномочия',`admin:team:set:${uid}:${current.version}:user`)]);
  return bot.panel(`<b>👤 Сотрудник</b>\n\n${safe(await memberName(bot,uid),100)}\nРоль: ${ROLE_NAMES[currentRole]}`, [...rows,[button('⬅️ Команда','admin:team:0')],...BACK]);
 }
 const confirm=/^admin:team:confirm:([a-z0-9]+)$/.exec(action),remove=/^admin:team:remove:([1-9]\d*):([a-z0-9]+)$/.exec(action);
 if(remove){
  const uid=Number(remove[1]),current=await roleRecord(bot.store,uid),currentRole=await rawRole(bot.store,uid);
  if(!positive(uid)||uid===OWNER_ID||uid===bot.uid||current?.version!==remove[2]||!['moderator','administrator'].includes(currentRole)||!mayManage(role,currentRole,'user'))return bot.panel('Права изменились или действие недоступно. Откройте список заново.',BACK);
  return roleDraft(bot,uid,'user',current,currentRole);
 }
 if(confirm||remove){
  const draft=confirm?bot.s.staff_draft:null;
  if(confirm&&(!draft||draft.token!==confirm[1]||!['moderator','administrator','user'].includes(draft.desired)))return bot.panel('Подтверждение устарело.',BACK);
  const uid=confirm?draft.uid:Number(remove[1]),desired=confirm?draft.desired:'user';
  if(!positive(uid)||uid===OWNER_ID||uid===bot.uid)return bot.panel('Нельзя изменить собственные права или права владельца.',BACK);
  const key='user:'+uid,lease='role:'+nonce();
  if(!await bot.store.lock(key,lease,180))return bot.panel('Пользователь сейчас обрабатывается. Повторите действие.',[[button('🔄 Повторить',action)],...BACK]);
  let changed=false,noticeState='none';
  try{
   const current=await roleRecord(bot.store,uid),currentRole=await rawRole(bot.store,uid),freshRole=await accessRole(bot),expected=confirm?draft.expected:remove[2];
   if((current?.version||null)!==expected||!mayManage(freshRole,currentRole,desired)||(desired!=='user'&&await bot.store.isBanned(uid)))return bot.panel('Права изменились или действие недоступно. Откройте список заново.',BACK);
   if(draft?.username){let chat;try{chat=await bot.api.getChat({chat_id:uid});}catch{}if(chat?.id!==uid||chat?.type!=='private'||String(chat.username||'').toLowerCase()!==draft.username.toLowerCase())return bot.panel('Тег изменился или не подтверждён. Укажите ID заново.',BACK);}
   if(currentRole!==desired){
    // Persist the unattempted notice with the decision; the delivery claim is CAS.
    const at=new Date().toISOString(),version=confirm?draft.token:nonce(),next={uid,role:desired==='user'?null:desired,version,by:bot.uid,actor:actor(bot),at,notice:{state:'pending',before:currentRole}};
    await staffDecision(bot.store,'staff_role',uid,next,{action:desired==='user'?'revoke_'+currentRole:currentRole==='moderator'&&desired==='administrator'?'promote':currentRole==='administrator'&&desired==='moderator'?'demote':'grant_'+desired,actor:actor(bot),actor_role:freshRole,target:uid,before:currentRole,after:desired,at});
    // Stale pending input and confirmations must not survive a changed privilege level.
    await bot.store.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.settings.pending_input',NULL,'$.settings.ban_draft',NULL,'$.settings.staff_draft',NULL) WHERE id=:uid",{':uid':uid});
    changed=true;
    noticeState=(await deliverRoleNotice(bot.store,bot.api,uid)).state;
   }
  }finally{await bot.store.unlock(key,lease);}
  await bot.patch({staff_draft:null});
  return bot.panel(changed?`Права пользователя ${uid} обновлены. Роль: ${ROLE_NAMES[desired]}.\n${noticeState==='sent'?'Уведомление пользователю отправлено.':noticeState==='pending'?'Telegram временно ограничил отправку. Уведомление будет отправлено позже.':'Доставка уведомления не подтверждена. Пользователь мог не запускать бота или заблокировать его.'}`:'Права не изменились.',BACK);
 }
 match=/^admin:team:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте раздел заново.',BACK);
 await bot.patch?.({staff_draft:null});
 const where="kind='staff_role' AND json_extract(payload,'$.role') IN ("+(role==='owner'?"'moderator','administrator'":"'moderator'")+")";
 const total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_records WHERE '+where)).n,page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all('SELECT payload FROM sjc_records WHERE '+where+' ORDER BY record_key LIMIT 5 OFFSET :offset',{':offset':page*5});
 const members=rows.map(r=>JSON.parse(r.payload)),labels=await Promise.all(members.map(m=>memberName(bot,m.uid))),nav=[];if(page)nav.push(button('⬅️',`admin:team:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:team:${page+1}`));
 return bot.panel(`<b>👥 ${role==='owner'?'Команда бота':'Модераторы'}</b>\n\n${members.map((m,i)=>`${safe(labels[i],100)} · ${ROLE_NAMES[m.role]}`).join('\n')||'Назначений пока нет.'}`,[[button('➕ Модератор','admin:team:add:moderator')],...(role==='owner'?[[button('➕ Администратор','admin:team:add:administrator')]]:[]),...members.map((m,i)=>[button(`${ROLE_NAMES[m.role]} · ${labels[i]}`,`admin:team:view:${m.uid}`)]),...(nav.length?[nav]:[]),...BACK]);
}
export async function auditPanel(bot,action){
 if(await accessRole(bot)!=='owner')return bot.panel('Журнал доступен только владельцу.',BACK);
 const match=/^admin:audit:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте журнал заново.',BACK);
 if(!bot.readOnly)await bot.store.pruneStaffAudit();
 const total=(await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='staff_audit'")).n,page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all("SELECT payload FROM sjc_records WHERE kind='staff_audit' ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 5 OFFSET :offset",{':offset':page*5});
 const names={review_publish:'Отзыв опубликован',review_delete:'Отзыв удалён',promote:'Повышен до администратора',demote:'Понижен до модератора',ban:'Бан',unban:'Разбан',grant_moderator:'Назначен модератор',grant_administrator:'Назначен администратор',revoke_moderator:'Снят модератор',revoke_administrator:'Снят администратор'};
 const text=rows.map(r=>{const e=JSON.parse(r.payload),stamp=Date.parse(e.at),date=new Date(stamp+belgradeOffset(stamp)).toISOString().replace('T',' ').slice(0,16);return `<b>${names[e.action]||'Действие'}</b> · ${date} (Белград)\nКто: ${safe(e.actor?.username?'@'+e.actor.username:e.actor?.name||'Сотрудник',80)} · ID ${e.actor.id} · ${ROLE_NAMES[e.actor_role]}\nПользователь: ${e.target}${e.reason?'\nПричина: '+safe(e.reason,140):''}`;}).join('\n\n');
 const nav=[];if(page)nav.push(button('⬅️',`admin:audit:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:audit:${page+1}`));
 return bot.panel('<b>📋 Журнал действий команды</b>\nХранятся последние 10 дней.\n\n'+(text||'Действий пока нет.'),[...(nav.length?[nav]:[]),[button('🔄 Обновить',`admin:audit:${page}`)],...BACK]);
}
