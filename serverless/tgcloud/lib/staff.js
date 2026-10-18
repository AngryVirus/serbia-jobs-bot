import { OWNER_ID,accessRole,rawRole,roleRecord,rank,mayManage,staffDecision,nonce,ROLE_NAMES } from './permissions.js';
import { ownerRoute } from './owner.js';
import { banPanel,resolveBanUsername,moderatorSnapshot } from './bans.js';
import { positive } from './store.js';
import { button,safe } from './ui.js';
import { belgradeOffset } from './filters.js';
const BACK=[[button('🛡 Панель','admin')],[button('🏠 Меню','menu')]];
const actor=bot=>bot.actor?.id===bot.uid?bot.actor:moderatorSnapshot({id:bot.uid});
export function staffHomeDocument(role){
 if(role==='moderator')return ['<b>🛡 Модератор</b>\n\nВы можете блокировать обычных пользователей. Разблокировка и управление сотрудниками недоступны.',[[button('🚫 Забанить пользователя','admin:bans:new')],[button('🏠 Меню','menu')]]];
 return ['<b>🛡 Администратор</b>\n\nВы можете блокировать и разблокировать пользователей, назначать и снимать модераторов.',[[button('🚫 Забанить пользователя','admin:bans:new')],[button('🔓 Баны и разблокировка','admin:bans:0')],[button('👥 Модераторы','admin:team:0')],[button('🏠 Меню','menu')]]];
}
export async function staffRoute(bot,action){
 const role=await accessRole(bot);
 if(!rank(role))return bot.panel('Этот раздел доступен только владельцу бота и назначенным сотрудникам.',[[button('🏠 Меню','menu')]]);
 if(action.startsWith('admin:team:'))return teamPanel(bot,action);
 if(action.startsWith('admin:audit:'))return auditPanel(bot,action);
 if(role==='owner')return ownerRoute(bot,action);
 if(action==='admin')return bot.panel(...staffHomeDocument(role));
 if(action.startsWith('admin:bans:'))return banPanel(bot,action);
 return bot.panel('Недостаточно прав для этого действия.',BACK);
}
export async function staffInput(bot,message){
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
 const draft={uid,desired,username:resolved?.username||null,expected:current?.version||null,token:nonce()};
 await bot.patch({pending_input:null,staff_draft:draft});
 await bot.panel(`<b>Назначить роль?</b>\n\nПользователь: ${uid}${draft.username?' · @'+safe(draft.username,32):''}\nТекущая роль: ${ROLE_NAMES[currentRole]}\nНовая роль: ${ROLE_NAMES[desired]}`,[[button('✅ Подтвердить',`admin:team:confirm:${draft.token}`)],...BACK]);return true;
}
export async function teamPanel(bot,action){
 const role=await accessRole(bot);
 if(!['owner','administrator'].includes(role))return bot.panel('Управление сотрудниками недоступно.',BACK);
 let match=/^admin:team:add:(moderator|administrator)$/.exec(action);
 if(match){if(!mayManage(role,'user',match[1]))return bot.panel('Назначать администраторов может только владелец.',BACK);
  await bot.patch({pending_input:'staff_target',staff_desired:match[1],staff_draft:null});
  return bot.panel(`<b>${match[1]==='moderator'?'Назначить модератора':'Назначить администратора'}</b>\n\nВведите числовой Telegram ID или @username известного боту пользователя. Затем подтвердите назначение.`,BACK);
 }
 const confirm=/^admin:team:confirm:([a-z0-9]+)$/.exec(action),remove=/^admin:team:remove:([1-9]\d*):([a-z0-9]+)$/.exec(action);
 if(confirm||remove){
  const draft=confirm?bot.s.staff_draft:null;
  if(confirm&&(!draft||draft.token!==confirm[1]||!['moderator','administrator'].includes(draft.desired)))return bot.panel('Подтверждение устарело.',BACK);
  const uid=confirm?draft.uid:Number(remove[1]),desired=confirm?draft.desired:'user';
  if(!positive(uid)||uid===OWNER_ID||uid===bot.uid)return bot.panel('Нельзя изменить собственные права или права владельца.',BACK);
  const key='user:'+uid,lease='role:'+nonce();
  if(!await bot.store.lock(key,lease,180))return bot.panel('Пользователь сейчас обрабатывается. Повторите действие.',[[button('🔄 Повторить',action)],...BACK]);
  let changed=false;
  try{
   const current=await roleRecord(bot.store,uid),currentRole=await rawRole(bot.store,uid),freshRole=await accessRole(bot),expected=confirm?draft.expected:remove[2];
   if((current?.version||null)!==expected||!mayManage(freshRole,currentRole,desired)||(desired!=='user'&&await bot.store.isBanned(uid)))return bot.panel('Права изменились или действие недоступно. Откройте список заново.',BACK);
   if(draft?.username){let chat;try{chat=await bot.api.getChat({chat_id:uid});}catch{}if(chat?.id!==uid||chat?.type!=='private'||String(chat.username||'').toLowerCase()!==draft.username.toLowerCase())return bot.panel('Тег изменился или не подтверждён. Укажите ID заново.',BACK);}
   if(currentRole!==desired){
    const at=new Date().toISOString(),version=confirm?draft.token:nonce(),next={uid,role:desired==='user'?null:desired,version,by:bot.uid,actor:actor(bot),at};
    await staffDecision(bot.store,'staff_role',uid,next,{action:desired==='user'?'revoke_'+currentRole:'grant_'+desired,actor:actor(bot),actor_role:freshRole,target:uid,before:currentRole,after:desired,at});
    // Stale pending input and confirmations must not survive a changed privilege level.
    await bot.store.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.settings.pending_input',NULL,'$.settings.ban_draft',NULL,'$.settings.staff_draft',NULL) WHERE id=:uid",{':uid':uid});
    changed=true;
   }
  }finally{await bot.store.unlock(key,lease);}
  await bot.patch({staff_draft:null});
  return bot.panel(changed?`Права пользователя ${uid} обновлены. Роль: ${ROLE_NAMES[desired]}.`:'Права не изменились.',BACK);
 }
 match=/^admin:team:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте раздел заново.',BACK);
 await bot.patch?.({staff_draft:null});
 const where="kind='staff_role' AND json_extract(payload,'$.role') IN ("+(role==='owner'?"'moderator','administrator'":"'moderator'")+")";
 const total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_records WHERE '+where)).n,page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all('SELECT payload FROM sjc_records WHERE '+where+' ORDER BY record_key LIMIT 5 OFFSET :offset',{':offset':page*5});
 const members=rows.map(r=>JSON.parse(r.payload)),nav=[];if(page)nav.push(button('⬅️',`admin:team:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:team:${page+1}`));
 return bot.panel(`<b>👥 ${role==='owner'?'Команда бота':'Модераторы'}</b>\n\n${members.map(m=>`${m.uid} · ${ROLE_NAMES[m.role]}`).join('\n')||'Назначений пока нет.'}`,[[button('➕ Модератор','admin:team:add:moderator')],...(role==='owner'?[[button('➕ Администратор','admin:team:add:administrator')]]:[]),...members.map(m=>[button(`Снять ${m.uid}`,`admin:team:remove:${m.uid}:${m.version}`)]),...(nav.length?[nav]:[]),...BACK]);
}
export async function auditPanel(bot,action){
 if(await accessRole(bot)!=='owner')return bot.panel('Журнал доступен только владельцу.',BACK);
 const match=/^admin:audit:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте журнал заново.',BACK);
 const total=(await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='staff_audit'")).n,page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all("SELECT payload FROM sjc_records WHERE kind='staff_audit' ORDER BY json_extract(payload,'$.at') DESC,record_key DESC LIMIT 5 OFFSET :offset",{':offset':page*5});
 const names={ban:'Бан',unban:'Разбан',grant_moderator:'Назначен модератор',grant_administrator:'Назначен администратор',revoke_moderator:'Снят модератор',revoke_administrator:'Снят администратор'};
 const text=rows.map(r=>{const e=JSON.parse(r.payload),stamp=Date.parse(e.at),date=new Date(stamp+belgradeOffset(stamp)).toISOString().replace('T',' ').slice(0,16);return `<b>${names[e.action]||'Действие'}</b> · ${date} (Белград)\nКто: ${safe(e.actor?.username?'@'+e.actor.username:e.actor?.name||'Сотрудник',80)} · ID ${e.actor.id} · ${ROLE_NAMES[e.actor_role]}\nПользователь: ${e.target}${e.reason?'\nПричина: '+safe(e.reason,140):''}`;}).join('\n\n');
 const nav=[];if(page)nav.push(button('⬅️',`admin:audit:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:audit:${page+1}`));
 return bot.panel('<b>📋 Журнал действий команды</b>\n\n'+(text||'Действий пока нет.'),[...(nav.length?[nav]:[]),[button('🔄 Обновить',`admin:audit:${page}`)],...BACK]);
}
