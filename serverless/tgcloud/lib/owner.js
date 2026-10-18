import { banPanel } from './bans.js';
import { analyticsPanel,successfulCollection } from './analytics.js';
import { SOURCE_NAMES } from './config.js';
import { sourceEnabled } from './source-policy.js';
import { defaults, belgradeOffset } from './filters.js';
import { groupJobs, visibleJobs, includesId } from './catalog.js';
import { button, BACK, safe, card, links } from './ui.js';
import { OWNER_ID } from './permissions.js';
export { OWNER_ID } from './permissions.js';
export const REASONS = { not_job: 'Не вакансия / реклама', duplicate: 'Повтор объявления', outdated: 'Набор закрыт / устарело' };
const OWNER_BACK = [[button('📊 Отчёт владельца', 'admin')], ...BACK];
const date = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)+belgradeOffset(Date.parse(value))).toISOString().replace('T',' ').slice(0,16) + ' (Белград)' : 'нет данных';
const STATES = { ok:'работает', empty:'нет подходящих объявлений', partial:'частичный сбор', blocked:'доступ заблокирован', robots_disallowed:'автосбор запрещён', unsupported:'нет доступной ленты', requires_permission:'нужно разрешение', excluded:'не подходит название канала', error:'ошибка', unknown:'не проверен' };
const REPORT_GROUP="(json_extract(payload,'$.job_id') IN (SELECT value FROM json_each(:ids)) OR json_extract(payload,'$.group_id') IN (SELECT value FROM json_each(:ids)))";
const groupParams=group=>({':ids':JSON.stringify(group.members.map(j=>j.id))});
async function reportedIds(store){
 const ids=new Set();let after=0;
 while(true){
  const rows=await store.db.all("SELECT id FROM (SELECT json_extract(payload,'$.job_id') AS id FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open' UNION SELECT json_extract(payload,'$.group_id') AS id FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open') WHERE id>:after ORDER BY id LIMIT 100",{':after':after});
  for(const row of rows)ids.add(row.id);
  if(rows.length<100)return ids;after=rows.at(-1).id;
 }
}
async function reportSummary(store,group){
 const rows=await store.db.all("SELECT CASE WHEN json_extract(payload,'$.reason') IN ('not_job','duplicate','outdated') THEN json_extract(payload,'$.reason') ELSE 'other' END AS reason,COUNT(*) AS n FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open' AND "+REPORT_GROUP+' GROUP BY reason',groupParams(group));
 return {total:rows.reduce((n,r)=>n+r.n,0),reasons:[...new Set(rows.map(r=>REASONS[r.reason]||'Другая причина'))].join('; ')};
}
async function openGroupReports(store,group){
 const reports=[];let after='';
 while(true){
  const rows=await store.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open' AND "+REPORT_GROUP+' AND record_key>:after ORDER BY record_key LIMIT 100',{...groupParams(group),':after':after});
  reports.push(...rows.map(r=>({key:r.record_key,payload:r.payload,report:JSON.parse(r.payload)})));
  if(rows.length<100)return reports;after=rows.at(-1).record_key;
 }
}

export async function notifyReports(store, api) {
  const pending=(await store.db.all("SELECT payload FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open' AND json_extract(payload,'$.owner_notice')='pending' AND COALESCE(json_extract(payload,'$.notice_after'),0)<=:now ORDER BY record_key LIMIT 5",{':now':Date.now()})).map(r=>JSON.parse(r.payload));
  for (const report of pending) {
    const key=`${report.user_id}:${report.group_id}`, claimed={...report,owner_notice:'sending'};
    const update=async (before,after)=>store.db.run("UPDATE sjc_records SET payload=:next WHERE kind='report' AND record_key=:key AND payload=:old",{':next':JSON.stringify(after),':key':key,':old':JSON.stringify(before)});
    if ((await update(report,claimed)).rowsAffected!==1) continue;
    let next={...claimed,owner_notice:'sent'};
    try {
      const message=await api.sendMessage({chat_id:OWNER_ID,parse_mode:'HTML',link_preview_options:{is_disabled:true},
        text:'<b>🚩 Новая жалоба на вакансию</b>\n\n'+safe(report.job_title || 'Вакансия',140)+'\n<b>Причина:</b> '+safe(REASONS[report.reason] || 'Другая причина',80),
        reply_markup:{inline_keyboard:[[button('🔎 Рассмотреть',`admin:review:${report.job_id}`)]]}});
      if (!Number.isSafeInteger(message?.message_id) || message.message_id<=0) throw new Error('Unconfirmed owner notice');
    } catch (error) {
      next.owner_notice=error.code===429?'pending':error.code===403?'blocked':'uncertain';
      if(error.code===429) next.notice_after=Date.now()+Math.min(3600,Math.max(5,Number(error.parameters?.retry_after)||60))*1000;
    }
    // A concurrent moderation decision must not be overwritten. An ambiguous
    // send is retained, never automatically repeated.
    await update(claimed,next);
    if(next.owner_notice==='pending') break;
  }
}

export async function complaint(bot, id, reason, index=-1, mode='s') {
  const group = groupJobs(await bot.store.jobs()).find(g => includesId(g,id));
  if (!group) return bot.panel('Объявление больше не найдено.');
  const back=index===-1 ? `job:${id}:${mode.startsWith('r')?'ru_':''}${mode.endsWith('f')?'full':'short'}` : `view:${id}:${index}:show:${mode}`;
  if (!reason) return bot.panel('<b>🚩 Пожаловаться</b>\n\n' + safe(group.members[0].title,120) + '\n\nВыберите причину. Объявление будет скрыто из вашей подборки, а жалобу проверит владелец.', [...Object.entries(REASONS).map(([key,label])=>[button(label,`report:${id}:${key}:${index}:${mode}`)]), [button('↩️ К объявлению',back)], ...BACK]);
  if (!Object.hasOwn(REASONS,reason)) return bot.home();
  const exists = Boolean(await bot.store.db.get("SELECT 1 AS found FROM sjc_records WHERE kind='report' AND record_key LIKE :prefix AND json_extract(payload,'$.user_id')=:uid AND "+REPORT_GROUP+' LIMIT 1',{...groupParams(group),':prefix':bot.uid+':%',':uid':bot.uid}));
  if(!exists) {
    const wait=await bot.store.rate(`${bot.uid}:report_daily`,20,86400);
    if(wait) return bot.panel(`Суточный лимит жалоб исчерпан. Повторите через ${Math.ceil(wait/60)} мин.`,BACK);
  }
  const key = `${bot.uid}:${group.id}`;
  const record = { user_id: bot.uid, job_id: id, group_id: group.id, reason, state: 'open', created_at: new Date().toISOString(), owner_notice:'pending',job_title:group.members.find(j=>j.id===id)?.title || group.members[0].title };
  // One complaint per person and recognized vacancy, even on replay/another copy.
  if (!exists) await bot.store.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('report',:key,:payload) ON CONFLICT(kind,record_key) DO NOTHING", { ':key':key, ':payload':JSON.stringify(record) });
  await bot.patch({ hidden_jobs: [...new Set([...(bot.s.hidden_jobs || []),group.id])] });
  await notifyReports(bot.store,bot.api);
  return bot.panel('Спасибо. Жалоба сохранена для проверки владельцем. Вакансия и распознанные копии скрыты из вашей подборки.', [[button('🔎 Продолжить поиск',index===-1?'search:0':`view:${id}:${index}:show:s`),button('↩️ Вернуть',`restore:${id}`)], ...BACK]);
}

export async function ownerReport(store) {
  const jobs = await store.jobs(), groups = groupJobs(jobs), counts = await store.stats();
  const statuses = await store.records('source_status');
  const pending=(await store.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open'")).n;
  const last = await store.meta('last_collection'), running = await store.meta('collection_run');
  const successful=Date.parse(await successfulCollection(store)),stale=!Number.isFinite(successful)||Date.now()-successful>7200000;
  const bySource = new Map(statuses.map(s=>[s.source,s.payload]));
  const sources = Object.keys(SOURCE_NAMES).filter(sourceEnabled).map(id=>({id,...(bySource.get(id) || {state:'unknown'})}));
  const issues = sources.filter(s=>!['ok','empty'].includes(s.state));
  const totals = Object.fromEntries(Object.keys(STATES).map(s=>[s,sources.filter(x=>x.state===s).length]));
  const deliveryStates = await store.db.all('SELECT state,COUNT(*) AS n FROM sjc_deliveries GROUP BY state');
  const delivery = Object.fromEntries(deliveryStates.map(r=>[r.state,r.n]));
  const cooldown = await store.meta('notification_cooldown');
  let text = '<b>📊 Отчёт владельца</b>\n\n';
  text += `Каталог: ${jobs.length} публикаций, ${groups.length} уникальных групп.\nРаспознанных повторов: ${jobs.length-groups.length}.\nДоступных вакансий: ${visibleJobs(groups,defaults()).length}.\nИсключено правилами качества: ${jobs.filter(j=>j._cloud?.quality?.reason).length} публикаций.\n`;
  text += `\nПоследний завершённый сбор: ${date(last?.finished_at)}.\n`;
  if (last) text += `Результат: ${last.failed ? 'завершился с ошибкой' : 'успешно'}. Источников: ${last.totals?.sources ?? '—'}/${sources.length}.\nНовых доступных вакансий: ${last.new_unique ?? '—'}; повторов за сбор: ${last.new_duplicates ?? '—'}; новых записей: ${last.totals?.added ?? '—'}.\nУведомлений за сбор: ${last.totals?.sent ?? '—'}. Ошибки доставки за сбор: ${last.totals?.blocked ?? '—'} блокировок, ${last.totals?.uncertain ?? '—'} неопределённых отправок.\n`;
  if (running?.state === 'running') text += `Сбор начат: ${date(running.started_at)}${Date.now()-Date.parse(running.started_at)>1800000 ? ' — проверьте зависший запуск' : ''}.\n`;
  if (stale) text += '⚠️ Нет подтверждения успешного свежего сбора за последние 2 часа.\n';
  text += `\nИсточники: ${totals.ok} работают, ${totals.empty} без подходящих объявлений, ${issues.length} требуют внимания.\nОшибки доставки за всё время: ${delivery.blocked || 0} блокировок, ${counts.uncertain} неопределённых.\nЖалоб ожидает проверки: ${pending}.`;
  if (cooldown>Date.now()) text += `\nTelegram ограничил отправку до ${date(new Date(cooldown).toISOString())}.`;
  const details = text;
  const stuck = running?.state==='running' && Date.now()-Date.parse(running.started_at)>1800000;
  const health = stuck ? '⚠️ Сбор затянулся' : running?.state==='running' ? '🔄 Идёт сбор вакансий' : last?.failed ? '⚠️ Последний сбор с ошибкой' : stale ? '⚠️ Данные давно не обновлялись' : '✅ Сбор работает';
  text = `<b>📊 Отчёт владельца</b>\n${health}\n\n`;
  text += `<b>💼 Вакансии</b>\nВ поиске: <b>${visibleJobs(groups,defaults()).length}</b> · новых за сбор: <b>${last?.new_unique ?? '—'}</b>\n`;
  text += `<b>📡 Источники</b>\nРаботают: ${totals.ok + totals.empty}/${sources.length} · требуют внимания: ${issues.length}\n\n`;
  text += `<b>🔔 Последний сбор</b>\nУведомлений: ${last?.totals?.sent ?? '—'} · повторов: ${last?.new_duplicates ?? '—'}\n`;
  text += `<b>🚩 Жалобы</b> · ${pending} ожидают проверки\n`;
  if (last?.totals?.blocked || last?.totals?.uncertain) text += `\n⚠️ Доставка: ${last.totals.blocked || 0} блокировок · ${last.totals.uncertain || 0} неподтверждённых\n`;
  if (cooldown>Date.now()) text += `\n⏳ Пауза отправки до ${date(new Date(cooldown).toISOString())}\n`;
  text += `\n<i>Обновление: ${date(last?.finished_at)}</i>`;
  return { text, details, issues, sources, groups, pending_reports:pending };
}

export async function ownerRoute(bot, action) {
  if (bot.uid !== OWNER_ID || bot.chat !== OWNER_ID) return bot.panel('Этот раздел доступен только владельцу бота.');
  if(action.startsWith('admin:bans:'))return banPanel(bot,action);
  const data = await ownerReport(bot.store);
  if(action==='admin:stats' || action.startsWith('admin:stats:') || action.startsWith('admin:quality'))return analyticsPanel(bot,action,data);
  if (action === 'admin') return bot.panel(data.text, [[button('📣 Реклама','ads'),button('🚫 Баны','admin:bans:0')],[button('👥 Команда','admin:team:0'),button('📋 Журнал команды','admin:audit:0')],[button('📈 Статистика','admin:stats'),button('🧹 Качество базы','admin:quality')],[button('📡 Источники','admin:sources:0'),button('🚩 Жалобы','admin:reports:0')],[button('📋 Подробности','admin:details'),button('🙈 Снятые','admin:blocked:0')],[button('🔄 Обновить','admin'),button('🏠 Меню','menu')]]);
  if (action === 'admin:details') return bot.panel(data.details,OWNER_BACK);
  let m;
  if ((m=/^admin:sources:(\d+)$/.exec(action))) {
    const page=Math.min(Number(m[1]),Math.max(0,Math.ceil(data.issues.length/6)-1));
    const text='<b>⚠️ Источники, требующие внимания</b>\n\n'+(data.issues.slice(page*6,page*6+6).map(s=>`${safe(SOURCE_NAMES[s.id],80)} — ${STATES[s.state] || 'ошибка'}.\n${safe(s.detail,150)}\nПроверка: ${date(s.checked_at)}`).join('\n\n') || 'Проблем по последней диагностике нет.');
    const rows=[];
    if(page) rows.push(button('⬅️',`admin:sources:${page-1}`));
    if((page+1)*6<data.issues.length) rows.push(button('➡️',`admin:sources:${page+1}`));
    return bot.panel(text,[...(rows.length?[rows]:[]),...OWNER_BACK]);
  }
  if ((m=/^admin:(reports|blocked|review):(\d+)$/.exec(action))) {
    const blocked=m[1]==='blocked';
    const reported=blocked?null:await reportedIds(bot.store);
    const groups=data.groups.filter(g=>blocked ? g.members.some(j=>j._moderated) : g.members.some(j=>reported.has(j.id)));
    const index=m[1]==='review'?groups.findIndex(g=>includesId(g,Number(m[2]))):Math.min(Number(m[2]),Math.max(0,groups.length-1)), group=groups[index];
    if(!group) return bot.panel(blocked?'Снятых с выдачи вакансий нет.':'Новых жалоб нет.',OWNER_BACK);
    const summary=await reportSummary(bot.store,group);
    const text=`<b>${blocked?'🙈 Снятые с выдачи':'🚩 Жалобы'} · ${index+1}/${groups.length}</b>\n${safe(summary.reasons,180)}${summary.total ? ` · ${summary.total} жалоб` : ''}\n\n`+card(group.members[0],true);
    const rows=[...links(group.members[0],false), blocked ? [button('↩️ Вернуть в выдачу',`admin:restore:${group.id}`)] : [button('Убрать из выдачи',`admin:block:${group.id}`),button('Оставить',`admin:keep:${group.id}`)]];
    const route=blocked?'blocked':'reports';
    const nav=[]; if(index>0) nav.push(button('⬅️',`admin:${route}:${index-1}`)); if(index+1<groups.length) nav.push(button('➡️',`admin:${route}:${index+1}`));
    return bot.panel(text,[...rows,...(nav.length?[nav]:[]),...OWNER_BACK],bot.mid,false);
  }
  if ((m=/^admin:(block|keep|restore):([1-9]\d*)$/.exec(action))) {
    const group=data.groups.find(g=>includesId(g,Number(m[2])));
    if(!group) return bot.panel('Объявление больше не найдено.',OWNER_BACK);
    const reports=await openGroupReports(bot.store,group);
    if(m[1]==='block') await bot.store.record('moderation',group.id,{ids:group.members.map(j=>j.id),blocked:true,updated_at:new Date().toISOString()});
    if(m[1]==='restore') for(const record of await bot.store.records('moderation')) {
      if(record.ids.some(id=>includesId(group,id))) await bot.store.record('moderation',Math.min(...record.ids),{...record,blocked:false,updated_at:new Date().toISOString()});
    }
    // Resolve only the records read for this review: concurrent new reports remain open.
    for(const row of reports) {
      await bot.store.db.run("UPDATE sjc_records SET payload=:next WHERE kind='report' AND record_key=:key AND payload=:old", { ':key':row.key, ':old':row.payload, ':next':JSON.stringify({...row.report,state:'reviewed',decision:m[1],reviewed_at:new Date().toISOString()}) });
    }
    return bot.panel(m[1]==='block'?'Вакансия и распознанные копии сняты с общей выдачи.':m[1]==='restore'?'Ограничение владельца снято. Вакансия появится, если проходит обычные проверки.':'Жалобы рассмотрены. Вакансия остаётся в выдаче при совпадении с фильтрами.',OWNER_BACK);
  }
  return bot.panel('Действие устарело. Откройте отчёт заново.',OWNER_BACK);
}
