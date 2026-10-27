import {OWNER_ID,accessRole,nonce} from './permissions.js';
import {groupJobs,includesId} from './catalog.js';
import {button,safe} from './ui.js';
const BACK=[[button('🔎 Найти вакансии','search:0')],[button('⬅️ Главное меню','menu')]];
const allowedRole=role=>['owner','administrator'].includes(role);
const actor=bot=>bot.actor?.id===bot.uid?bot.actor:{id:bot.uid};
const staffSql=`(:uid=${OWNER_ID} OR (EXISTS(SELECT 1 FROM sjc_records WHERE kind='staff_role' AND record_key=:actor_key AND json_extract(payload,'$.role')='administrator') AND NOT EXISTS(SELECT 1 FROM sjc_records WHERE kind='user_ban' AND record_key=:actor_key AND COALESCE(json_extract(payload,'$.active'),1)!=0)))`;

// Confirmation, current privileges and duplicate-group closure are checked in
// the same SQLite statement as the moderation record and ten-day team audit.
export async function closeVacancy(bot,token){
 const role=await accessRole(bot);if(!allowedRole(role)||!/^[a-z0-9]{8,40}$/.test(token))return false;
 const previous=await bot.store.db.get("SELECT payload FROM sjc_records WHERE kind='moderation' AND json_extract(payload,'$.reason')='manual_closed' AND json_extract(payload,'$.version')=:token AND json_extract(payload,'$.closed_by')=:uid AND json_extract(payload,'$.blocked')=1",{':token':token,':uid':bot.uid});
 if(previous)return {already:true};
 const draft=(await bot.store.user(bot.uid))?.settings?.vacancy_close_draft;
 if(!draft||draft.token!==token||draft.expires<=Date.now())return false;
 const group=groupJobs(await bot.store.jobs()).find(g=>includesId(g,draft.id));
 if(!group||group.members.some(j=>j._moderated))return false;
 const ids=group.members.map(j=>j.id),id=Math.min(...ids),at=new Date().toISOString(),title=group.members[0].title;
 const rows=[{kind:'moderation',key:String(id),payload:JSON.stringify({ids,blocked:true,reason:'manual_closed',closed_by:bot.uid,version:token,updated_at:at})},
  {kind:'staff_audit',key:'vacancy_close:'+id+':'+token,payload:JSON.stringify({at,action:'vacancy_close',actor:actor(bot),actor_role:role,job_id:id,title})}];
 await bot.store.pruneStaffAudit();
 const result=await bot.store.db.run(`WITH allowed AS MATERIALIZED (
  SELECT 1 FROM sjc_users WHERE id=:uid AND json_extract(payload,'$.settings.vacancy_close_draft.token')=:token
  AND json_extract(payload,'$.settings.vacancy_close_draft.id')=:id AND json_extract(payload,'$.settings.vacancy_close_draft.expires')>:now
  AND ${staffSql} AND NOT EXISTS(SELECT 1 FROM sjc_records m,json_each(m.payload,'$.ids') ids WHERE m.kind='moderation' AND json_extract(m.payload,'$.blocked')=1 AND ids.value IN (SELECT value FROM json_each(:ids))))
  INSERT INTO sjc_records(kind,record_key,payload) SELECT json_extract(value,'$.kind'),json_extract(value,'$.key'),json_extract(value,'$.payload') FROM json_each(:rows) CROSS JOIN allowed WHERE 1
  ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload`,{':uid':bot.uid,':actor_key':String(bot.uid),':id':draft.id,':token':token,':now':Date.now(),':ids':JSON.stringify(ids),':rows':JSON.stringify(rows)});
 return result.rowsAffected===2?{closed:true}:false;
}
export async function vacancyModerationRoute(bot,action){
 if(!allowedRole(await accessRole(bot)))return bot.panel('Закрывать вакансии могут только владелец и администраторы.',[[button('⬅️ Главное меню','menu')]]);
 let match;
 if((match=/^admin:close:confirm:([a-z0-9]{8,40})$/.exec(action))){
  const result=await closeVacancy(bot,match[1]);
  if(bot.s.vacancy_close_draft?.token===match[1])await bot.patch({vacancy_close_draft:null});
  return bot.panel(result?'<b>🔒 Вакансия закрыта</b>\n\nОна и распознанные копии убраны из общего поиска и новых уведомлений. Действие записано в журнал команды.':'Подтверждение устарело, вакансия уже снята с выдачи или ваши права изменились. Откройте актуальную карточку.',BACK);
 }
 match=/^admin:close:([1-9]\d{0,15}):(-1|\d{1,7}):(s|f|rs|rf)(?::([a-z0-9]{8}))?$/.exec(action);
 if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[2])>1000000)return bot.panel('Откройте действия с вакансией заново.',BACK);
 const id=Number(match[1]),group=groupJobs(await bot.store.jobs()).find(g=>includesId(g,id));
 if(!group||group.members.some(j=>j._moderated))return bot.panel('Вакансия уже недоступна или снята с выдачи.',BACK);
 const back=match[4]?`discover:${match[4]}:${id}:${match[2]}:show:${match[3]}`:match[2]==='-1'?`job:${id}:${match[3].startsWith('r')?'ru_':''}${match[3].endsWith('f')?'full':'short'}`:`view:${id}:${match[2]}:show:${match[3]}`;
 const draft={id,token:nonce().slice(-12),expires:Date.now()+600000};await bot.patch({vacancy_close_draft:draft});
 return bot.panel('<b>Закрыть вакансию для всех?</b>\n\n'+safe(group.members[0].title,140)+'\n\nОна и распознанные копии исчезнут из поиска и новых уведомлений. Автоматический сбор не снимет это ограничение. Вернуть вакансию сможет владелец через список снятых.',[[button('🔒 Подтвердить закрытие','admin:close:confirm:'+draft.token)],[button('⬅️ Отмена',back)]]);
}
