import { defaults, normalize } from './filters.js';
import { groupJobs, visibleJobs } from './catalog.js';
import { SOURCE_NAMES } from './config.js';
import { sourceEnabled } from './source-policy.js';
import { safe, button } from './ui.js';
const BACK=[[button('📊 Админка','admin')]];
export async function usage(store,field,now=Date.now()) {
 if(!['searches','empty','translations'].includes(field))throw Error('Unknown usage counter');
 const day=new Date(now).toISOString().slice(0,10);
 await store.db.run(`INSERT INTO sjc_records(kind,record_key,payload) VALUES('usage',:day,json_object('${field}',1)) ON CONFLICT(kind,record_key) DO UPDATE SET payload=json_set(payload,'$.${field}',COALESCE(json_extract(payload,'$.${field}'),0)+1)`,{':day':day});
}
export async function activity(store,uid,now=Date.now()) {
 const day=new Date(now).toISOString().slice(0,10);
 await store.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.last_seen_day',:day,'$.settings.bot_blocked',json('false'),'$.delivery_status','reachable') WHERE id=:uid AND (COALESCE(json_extract(payload,'$.last_seen_day'),'')!=:day OR COALESCE(json_extract(payload,'$.settings.bot_blocked'),0)!=0 OR COALESCE(json_extract(payload,'$.delivery_status'),'')!='reachable')",{':day':day,':uid':uid});
}
// Only Telegram's explicit blocked description is evidence of a user blocking the bot.
// No raw error descriptions or personal event logs are retained.
export async function deliveryForbidden(store,uid,error,now=Date.now()) {
 if(error?.code!==403)return;
 const description=String(error.description||error.message||'');
 const status=/bot was blocked by the user/i.test(description)?'blocked':/user is deactivated/i.test(description)?'deactivated':'forbidden';
 await store.db.run("UPDATE sjc_users SET payload=json_set(payload,'$.settings.bot_blocked',json('true'),'$.delivery_status',:status,'$.delivery_status_day',:day,'$.ever_confirmed_blocked',CASE WHEN :status='blocked' THEN 1 ELSE COALESCE(json_extract(payload,'$.ever_confirmed_blocked'),0) END) WHERE id=:uid",{':uid':uid,':status':status,':day':new Date(now).toISOString().slice(0,10)});
}
export async function userStatistics(store,now=Date.now()) {
 const today=new Date(now).toISOString().slice(0,10),week=new Date(now-6*86400000).toISOString().slice(0,10),month=new Date(now-29*86400000).toISOString().slice(0,10);
 const row=await store.db.get(`SELECT COUNT(*) AS total,
 COALESCE(SUM(json_extract(payload,'$.last_seen_day') IS NOT NULL),0) AS observed,
 COALESCE(SUM(json_extract(payload,'$.last_seen_day')>=:today),0) AS active_today,
 COALESCE(SUM(json_extract(payload,'$.last_seen_day')>=:week),0) AS active_week,
 COALESCE(SUM(json_extract(payload,'$.last_seen_day')>=:month),0) AS active_month,
 COALESCE(SUM(substr(json_extract(payload,'$.created_at'),1,10)>=:today),0) AS new_today,
 COALESCE(SUM(substr(json_extract(payload,'$.created_at'),1,10)>=:week),0) AS new_week,
 COALESCE(SUM(substr(json_extract(payload,'$.created_at'),1,10)>=:month),0) AS new_month,
 COALESCE(SUM(json_extract(payload,'$.settings.notifications') IS NOT NULL AND json_extract(payload,'$.settings.notifications')!='off'),0) AS subscribed,
 COALESCE(SUM(COALESCE(json_extract(payload,'$.settings.bot_blocked'),0)!=0),0) AS unavailable,
 COALESCE(SUM(json_extract(payload,'$.delivery_status')='blocked'),0) AS blocked,
 COALESCE(SUM(json_extract(payload,'$.delivery_status')='deactivated'),0) AS deactivated,
 COALESCE(SUM(json_extract(payload,'$.ever_confirmed_blocked')=1),0) AS ever_blocked
 FROM sjc_users`,{':today':today,':week':week,':month':month});
 return row;
}
export async function freshness(store,now=Date.now()) {
 const run=await store.meta('last_collection');
 const value=await store.meta('last_successful_collection') || (!run?.failed && run?.totals?.sources>0 ? run.finished_at : null);
 const stamp=Date.parse(value),age=now-stamp;
 if(!Number.isFinite(stamp))return '<i>⚠️ Свежесть базы пока не подтверждена. Проверяйте актуальность у работодателя.</i>\n\n';
 if(age<=7200000)return '';
 const hours=Math.floor(age/3600000),when=hours<24?`${hours} ч назад`:`${Math.floor(hours/24)} дн назад`;
 return `<i>⚠️ Последний успешный сбор — ${when}. Новые вакансии могут отсутствовать, а часть объявлений — устареть.</i>\n\n`;
}
export async function sourceHistory(store,owner,started,now=Date.now()) {
 for(const row of await store.records('source_status')) {
  if(!Object.hasOwn(SOURCE_NAMES,row.source) || !sourceEnabled(row.source) || !(Date.parse(row.payload?.checked_at)>=Date.parse(started)))continue;
  const healthy=['ok','empty'].includes(row.payload.state);
  await store.db.run(`INSERT INTO sjc_records(kind,record_key,payload) VALUES('source_health',:source,json_object('checks',1,'failures',:bad,'streak',:bad,'last_run',:owner,'last_ok',:ok,'state',:state))
   ON CONFLICT(kind,record_key) DO UPDATE SET payload=json_object('checks',json_extract(payload,'$.checks')+1,'failures',json_extract(payload,'$.failures')+:bad,'streak',CASE WHEN :bad=0 THEN 0 ELSE json_extract(payload,'$.streak')+1 END,'last_run',:owner,'last_ok',CASE WHEN :bad=0 THEN :ok ELSE json_extract(payload,'$.last_ok') END,'state',:state)
   WHERE json_extract(payload,'$.last_run')!=:owner`,{':source':row.source,':bad':healthy?0:1,':owner':owner,':ok':healthy?new Date(now).toISOString():null,':state':row.payload.state});
 }
 await store.db.run("DELETE FROM sjc_records WHERE kind='menu_image' AND json_extract(payload,'$.expires')<=:now",{':now':now});
 // Anonymous totals are sufficient; no request text, filter values or event-level IDs.
 await store.db.run("DELETE FROM sjc_records WHERE kind='usage' AND record_key<:before",{':before':new Date(now-90*86400000).toISOString().slice(0,10)});
}
export function qualitySummary(jobs,groups=groupJobs(jobs),now=Date.now()) {
 const available=new Set(visibleJobs(groups,defaults(),now).map(j=>Math.min(...j._duplicate_ids)));
 const expired=j=>j._cloud?.quality?.reason==='closed' || j._withdrawn_at || (j._cloud?.expires_ms!=null && j._cloud.expires_ms<=now);
 const old=j=>Number.isFinite(j._cloud?.published_ms) && now-j._cloud.published_ms>30*86400000;
 const reasons={};for(const j of jobs)if(j._cloud?.quality?.reason)reasons[j._cloud.quality.reason]=(reasons[j._cloud.quality.reason]||0)+1;
 const sources=Object.keys(SOURCE_NAMES).filter(sourceEnabled).map(source=>{
  const records=jobs.filter(j=>j.source===source),found=groups.filter(g=>available.has(g.id) && g.members.some(j=>j.source===source));
  return {source,stored:records.length,visible:found.length,exclusive:found.filter(g=>g.members.every(j=>j.source===source)).length,duplicates:records.length-groups.filter(g=>g.members.some(j=>j.source===source)).length,expired:records.filter(expired).length};
 });
 // Review candidates only: matching role/company/city is insufficient for automatic merging.
 const buckets=new Map();
 for(const g of groups) {
  if(!available.has(g.id))continue;
  const j=g.members[0];if(!j.company || !j.location || String(j.description||'').length<80)continue;
  const key=[j.title,j.company,j.location].map(normalize).join('|');
  if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(g);
 }
 const candidates=[...buckets.values()].filter(v=>v.length>1).slice(0,50);
 return {total:jobs.length,groups:groups.length,visible:available.size,merged:jobs.length-groups.length,expired:jobs.filter(expired).length,old:jobs.filter(old).length,undated:jobs.filter(j=>j._cloud?.published_ms==null).length,reasons,sources,candidates};
}
export async function analyticsPanel(bot,action,data) {
 if(action==='admin:stats') {
  const banned=(await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='user_ban' AND COALESCE(json_extract(payload,'$.active'),1)!=0")).n;
  const s=await userStatistics(bot.store),started=await bot.store.meta('analytics_started');
  return bot.panel(`<b>👥 Пользователи бота</b>\n\n<b>Всего в базе:</b> ${s.total}\nВоспользовались за время учёта: ${s.observed}\n\n<b>Активные пользователи · UTC</b>\nСегодня: ${s.active_today}\nЗа 7 дней: ${s.active_week}\nЗа 30 дней: ${s.active_month}\n\n<b>Новые пользователи · UTC</b>\nСегодня: ${s.new_today}\nЗа 7 дней: ${s.new_week}\nЗа 30 дней: ${s.new_month}\n\n<b>Уведомления включены:</b> ${s.subscribed}\n<b>Не принимают сообщения (403):</b> ${s.unavailable}\nПодтверждённо заблокировали бота: ${s.blocked}\nЗабанены владельцем: ${banned}\n\n<i>Активность учитывается с ${safe(started||'первого обращения',30)}. Данные об удалённых профилях сюда не входят; возвращение после удаления считается новой регистрацией.</i>`,[[button('🚫 Блокировки и доставка','admin:stats:delivery')],[button('📈 Поиски и переводы','admin:stats:usage')],[button('🔄 Обновить','admin:stats')],...BACK]);
 }
 if(action==='admin:stats:delivery') {
  const s=await userStatistics(bot.store);
  return bot.panel(`<b>🚫 Блокировки и доставка</b>\n\n<b>Не принимают сообщения (403):</b> ${s.unavailable}\nБлокировка подтверждена Telegram: ${s.blocked}\nАккаунт деактивирован: ${s.deactivated}\nПрочие / старые отказы: ${Math.max(0,s.unavailable-s.blocked-s.deactivated)}\n\nБлокировали хотя бы раз за время наблюдения: ${s.ever_blocked}\n\n<i>Это пользователи, а не число ошибок отправки. Учитываются только профили, которые сейчас есть в базе. Блокировки становятся известны по ответу Telegram при доставке: полного списка заблокировавших бот не получает. Отдельной проверки рассылкой нет. Возвращение в бот снимает текущий отказ; исторические отказы без точной причины не считаются подтверждённой блокировкой.</i>`,[[button('🔄 Обновить','admin:stats:delivery')],[button('👥 Пользователи','admin:stats')],...BACK]);
 }
 if(action==='admin:stats:usage') {
  const now=Date.now(),since=new Date(now-6*86400000).toISOString().slice(0,10),today=new Date(now).toISOString().slice(0,10);
  const rows=await bot.store.db.all("SELECT payload FROM sjc_records WHERE kind='usage' AND record_key>=:since",{':since':since});
  const totals={searches:0,empty:0,translations:0};for(const r of rows)for(const key of Object.keys(totals))totals[key]+=JSON.parse(r.payload)[key]||0;
  const active=async day=>(await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_users WHERE json_extract(payload,'$.last_seen_day')>=:day",{':day':day})).n;
  const subscriptions=await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_users WHERE json_extract(payload,'$.settings.notifications') IS NOT NULL AND json_extract(payload,'$.settings.notifications')!='off'");
  const sinceMetrics=await bot.store.meta('analytics_started');
  return bot.panel(`<b>📈 Использование бота</b>\n\nАктивных сегодня (UTC): ${await active(today)}\nЗа 7 дней: ${await active(since)}\nЗа 30 дней: ${await active(new Date(now-29*86400000).toISOString().slice(0,10))}\nВключены уведомления: ${subscriptions.n}\n\n<b>Последние 7 дней</b>\nПоисков: ${totals.searches}\nБез результатов: ${totals.empty}${totals.searches?' · '+Math.round(100*totals.empty/totals.searches)+'%':''}\nЗапросов перевода: ${totals.translations}\n\n<i>Учёт с ${safe(sinceMetrics||'первого обращения',30)}. Переходы между карточками не считаются новым поиском. Тексты запросов и значения фильтров не собираются.</i>`,[[button('👥 Пользователи','admin:stats')],...BACK]);
 }
 const q=qualitySummary(data.groups.flatMap(g=>g.members),data.groups);
 if(action==='admin:quality') {
  const backup=await bot.store.meta('last_backup');
  return bot.panel(`<b>🧹 Качество базы</b>\n\nПубликаций: ${q.total} · групп: ${q.groups}\nДоступно: ${q.visible}\nОбъединено копий: ${q.merged}\nЗакрытых / просроченных публикаций: ${q.expired}\nС датой старше 30 дней: ${q.old}\nБез даты публикации: ${q.undated}\nГрупп возможных дублей: ${q.candidates.length}\n\nВозраст сам по себе не закрывает вакансию. Возможные дубли требуют проверки владельца.\n\nПоследняя проверенная резервная копия: ${safe(backup?.verified_at||'ещё нет',40)}\n<i>Копия считается завершённой после сохранения зашифрованного артефакта в Actions.</i>`,[[button('📡 Польза источников','admin:quality:sources:0')],[button('🔍 Возможные дубли','admin:quality:duplicates:0')],...BACK]);
 }
 let m;if((m=/^admin:quality:sources:(\d+)$/.exec(action))) {
  const page=Math.min(Number(m[1]),Math.max(0,Math.ceil(q.sources.length/4)-1));
  const history=Object.fromEntries((await bot.store.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='source_health'")).map(r=>[r.record_key,JSON.parse(r.payload)]));
  const text=q.sources.slice(page*4,page*4+4).map(s=>{const h=history[s.source];return `<b>${safe(SOURCE_NAMES[s.source],70)}</b>\nВ выдаче: ${s.visible} · только здесь: ${s.exclusive}\nЗаписей: ${s.stored} · копий внутри источника: ${s.duplicates}\nЗакрытых / просроченных: ${s.expired}\nСбоев: ${h?.failures??0}/${h?.checks??0} · подряд: ${h?.streak??0}`;}).join('\n\n');
  const nav=[];if(page)nav.push(button('⬅️',`admin:quality:sources:${page-1}`));if((page+1)*4<q.sources.length)nav.push(button('➡️',`admin:quality:sources:${page+1}`));
  return bot.panel('<b>📡 Польза и стабильность источников</b>\n\n'+text,[...(nav.length?[nav]:[]),...BACK]);
 }
 if((m=/^admin:quality:duplicates:(\d+)$/.exec(action))) {
  const page=Math.min(Number(m[1]),Math.max(0,q.candidates.length-1)),v=q.candidates[page];
  if(!v)return bot.panel('Подозрительных совпадений по должности, работодателю и городу не найдено. Жалобы на повторы остаются в разделе «Жалобы».',BACK);
  const rows=[],text=[`<b>🔍 Возможные дубли · ${page+1}/${q.candidates.length}</b>\nСовпали должность, работодатель и город. Это может быть несколько разных вакансий — автоматического объединения нет.`];
  for(const g of v.slice(0,3)) {const j=g.members[0];text.push(`\n${safe(j.title,100)}\n${safe(j.company,80)} · ${safe(j.location,80)}`);rows.push([button('📄 Открыть',`job:${j.id}:full`),button('Убрать из выдачи',`admin:block:${g.id}`)]);}
  const nav=[];if(page)nav.push(button('⬅️',`admin:quality:duplicates:${page-1}`));if(page+1<q.candidates.length)nav.push(button('➡️',`admin:quality:duplicates:${page+1}`));
  return bot.panel(text.join('\n'),[...rows,...(nav.length?[nav]:[]),...BACK]);
 }
 return bot.panel('Откройте раздел заново.',BACK);
}
