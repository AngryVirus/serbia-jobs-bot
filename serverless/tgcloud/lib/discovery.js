import {vacancyVisual} from './ui.js';
import {accessRole,rank} from './permissions.js';
// Bounded, per-user search sessions preserve the search and its previous-visit
// boundary while users navigate, translate and hide vacancies.
import { defaults, hidden, normalize, validUrl } from './filters.js';
import { groupJobs, visibleJobs, includesId } from './catalog.js';
import { savedSearches, snapshotFilters } from './searches.js';
import { vacancyWarnings } from './risks.js';
import { hasFavorite } from './library.js';
import { freshness, usage } from './analytics.js';
import { button, BACK, safe, emptyText, translatedCard, links, browserUrl, cardActions, sourceChoice } from './ui.js';

const TTL = 86400000, MAX_SESSIONS = 6;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const sessions = (s, now = Date.now()) => (Array.isArray(s.discovery_sessions) ? s.discovery_sessions : [])
  .filter(x => x && /^[a-z0-9]{8}$/.test(x.token) && ['all','new','notice'].includes(x.kind) && x.expires > now && nonnegative(x.upper_id))
  .slice(-MAX_SESSIONS);
const scopePlan = (s, scope) => scope === 'main' ? null : savedSearches(s).find(p => p.id === scope);
const scopeExists = (s, scope) => ['main','notice'].includes(scope) || Boolean(scopePlan(s,scope));
// Array order does not change OR filters or keyword/exclusion matching. Compare
// only public preferences, so notification switches, hidden jobs and renaming
// a saved search do not invalidate its still-correct browsing context.
const filterKey = raw => JSON.stringify(Object.fromEntries(Object.entries(snapshotFilters(raw)).map(([key,value]) =>
  [key,Array.isArray(value) ? [...new Set(value.map(normalize))].sort() : value])));
const currentFilters = (s, session) => session.scope === 'notice' ? session.filters : session.scope === 'main' ? s : scopePlan(s,session.scope)?.filters;
const currentSession = (s, session) => {
  const filters=currentFilters(s,session);
  return Boolean(filters && filterKey(filters) === filterKey(session.filters));
};
export const discoverySession = (s, token) => sessions(s).find(x => x.token === token && currentSession(s,x));
const lookup = discoverySession;
const callback = (session, job, index, action, mode = 's') => `discover:${session.token}:${job.id}:${index}:${action}:${mode}`;
const backRows = session => [[button('⚙️ Фильтры',session.scope === 'main' ? 'filters' : 'plans'),button('🏠 Меню','menu')]];
const scopedSettings = (s, session) => ({ ...s, ...session.filters, hidden_jobs: s.hidden_jobs });
const newJobs = (jobs, session) => session.after_id === null ? [] : jobs.filter(j => j._duplicate_ids.every(id => id > session.after_id && id <= session.upper_id));
function eligible(groups, s, session) {
  const settings = scopedSettings(s,session);
  const jobs = visibleJobs(groups,settings)
    .filter(j => j._duplicate_ids.some(id => id <= session.upper_id));
  if (session.kind === 'notice') return jobs.filter(j=>j._duplicate_ids.some(id=>session.notice_ids?.includes(id)));
  if (session.kind === 'new') return newJobs(jobs,session);
  return jobs;
}
function rowsFor(session, job, index, count, mode, failed, newCount) {
  const b = (text,action) => button(text,callback(session,job,index,action,mode));
  const rows = [...links(job,false,callback(session,job,index,'open',mode))], nav=[];
  if(index)nav.push(b('⬅️','prev'));
  if(index+1<count)nav.push(b('➡️','next'));
  if(nav.length)rows.push(nav);
  rows.push([b(mode.endsWith('f') ? '🔼 Свернуть' : '🔽 Подробнее','details'),button('⭐ Отзывы',`ratings:${job.id}:list`)]);
  rows.push([b('☰ Ещё','actions')]);
  if (failed && validUrl(job.url)) rows.push([{text:'🌐 Перевести в браузере',url:browserUrl(job)}]);
  if(session.kind === 'all' && newCount)rows.push([b(`🆕 С прошлого просмотра · ${newCount}`,'new')]);
  if(session.kind === 'new')rows.push([b('🔎 Все подходящие','all')]);
  rows.push([button('🏠 Главное меню','menu')]);
  return rows;
}
function reasons(job, back) {
  const warnings = vacancyWarnings(job);
  return ['<b>⚠️ На что обратить внимание</b>\n\n'+safe(job.title,140)+'\n\n'+(warnings.length
    ? warnings.map(w => '• '+safe(w.reason,350)+'\n'+safe(w.advice,500)).join('\n\n')+'\n\nЭто автоматическая подсказка по тексту объявления. Она не подтверждает мошенничество; отсутствие предупреждения не гарантирует безопасность.'
    : 'В тексте не найдено признаков, для которых бот показывает предупреждения. Это не гарантирует безопасность работодателя.'),[[button('↩️ К вакансии',back)]]];
}
export async function expiredDiscovery(bot) {
  return bot.panel('Эта подборка устарела или условия поиска изменились. Откройте поиск заново — будут использованы ваши сохранённые фильтры.',[[button('🔎 Найти вакансии','search:0'),button('📂 Мои поиски','plans')],...BACK]);
}
const expired=expiredDiscovery;
async function render(bot, original, {action='show',jobId=null,index=0,mode='s',persist=true,catalog=null}={}) {
  if(!scopeExists(bot.s,original.scope) || !currentSession(bot.s,original))return expired(bot);
  const session={...original}, groups=catalog || groupJobs(await bot.store.jobs());
  let s=bot.s, jobs=eligible(groups,s,session),notice='';
  let current=jobs.findIndex(j=>j._duplicate_ids.includes(jobId));
  const stale = jobId !== null && current < 0;
  if(action==='hide' && current>=0) {
    index=current;
    s={...s,hidden_jobs:[...new Set([...hidden(s),jobId])].sort((a,b)=>a-b)};
    jobs=eligible(groups,s,session);notice='<i>🙈 Вакансия скрыта</i>\n\n';
  } else if(current>=0) index=current+(action==='next'?1:action==='prev'?-1:0);
  else if(action==='prev')index--;
  if(stale && ['details','translate','actions','problem','risk','open'].includes(action)) {
    action='show';mode='s';notice='<i>Подборка изменилась — показана актуальная вакансия.</i>\n\n';
  }
  index=Math.min(Math.max(0,index),Math.max(0,jobs.length-1));
  if(action==='details')mode=mode.slice(0,-1)+(mode.endsWith('f')?'s':'f');
  else if(action==='translate')mode=mode.startsWith('r')?mode.slice(1):'r'+mode;
  else if(['next','prev','hide'].includes(action))mode='s';
  session.current_id=jobs[index]?.id || null;session.index=index;session.mode=mode;
  session.view=['actions','problem','risk','open'].includes(action)?action:'show';
  if(persist) {
    const retained=sessions(s).filter(x=>x.token!==session.token);
    await bot.patchInput({...(s.hidden_jobs ? {hidden_jobs:s.hidden_jobs} : {}),discovery_sessions:[...retained,session].slice(-MAX_SESSIONS),discovery_current:session.token},'discovery');
  }
  if(!jobs.length) {
    const text=session.kind==='notice' ? '<b>Вакансии из уведомления больше недоступны.</b>\n\nОни могли закрыться или быть скрыты вами. Откройте новый поиск.' : session.kind==='new' ? '<b>Новых вакансий с прошлого просмотра нет.</b>\n\nПоказываем только впервые найденные объявления, подходящие этим условиям. Копии прежних вакансий не считаются новыми.'
      : groups.length ? emptyText(groups,scopedSettings(s,session)) : '⏳ База ещё наполняется. Попробуйте поиск через несколько минут.';
    const more=session.kind==='new' ? [[button('🔎 Все подходящие',`discover:${session.token}:0:0:all:s`)]] : [];
    return bot.panel(await freshness(bot.store)+notice+text,[...more,...backRows(session)]);
  }
  const job=jobs[index];
  if(['actions','problem'].includes(session.view))return bot.panel(...cardActions(job,index,mode,{token:session.token},await hasFavorite(bot,job),session.view==='problem',rank(await accessRole(bot))>=2));
  if(session.view==='open')return bot.panel(...sourceChoice(job,callback(session,job,index,'show',mode)));
  if(session.view==='risk')return bot.panel(...reasons(job,callback(session,job,index,'show',mode)));
  const result=await translatedCard(job,mode,bot.fetch,bot.store);
  const newCount=session.kind==='all'?newJobs(jobs,session).length:0;
  const heading=(session.kind==='notice'?'<b>🔔 Новые вакансии из уведомления</b>\n':session.kind==='new'?'<b>🆕 Новое с прошлого просмотра</b>\n':'')
    +(!['main','notice'].includes(session.scope)?'<b>Поиск: '+safe(scopePlan(s,session.scope)?.name || 'Сохранённый',60)+'</b>\n':'');
  const prefix=await freshness(bot.store)+notice+heading+`<i>Вакансия ${index+1} из ${jobs.length}</i>\n\n`;
  return bot.panel(prefix+result.text,
    rowsFor(session,job,index,jobs.length,result.mode,result.failed,newCount),bot.mid,vacancyVisual(result,prefix));
}
export async function openDiscovery(bot, scope='main',kind='all', parent=null) {
  if(!['all','new'].includes(kind)||!scopeExists(bot.s,scope))return expired(bot);
  if(parent && (parent.scope!==scope || !currentSession(bot.s,parent)))return expired(bot);
  const plan=scopePlan(bot.s,scope), all=await bot.store.jobs();
  const upper=all.reduce((max,j)=>Math.max(max,j.id),0), previous=scope==='notice'?null:scope==='main'?bot.s.last_viewed_id:plan.last_viewed_id;
  const retained=sessions(bot.s),taken=new Set(retained.map(x=>x.token));let token;
  do {token=Math.random().toString(36).slice(2,10).padEnd(8,'0');} while(taken.has(token));
  const session={token,scope,kind,filters:parent?.filters || snapshotFilters(scope==='notice'?defaults():scope==='main'?bot.s:plan.filters),after_id:parent?parent.after_id:nonnegative(previous)?previous:null,
    upper_id:parent?.upper_id ?? upper,expires:Date.now()+TTL,index:0,mode:'s',view:'show'};
  const viewed=Math.max(nonnegative(previous)?previous:0,session.upper_id);
  const marker=scope==='notice'?{}:scope==='main'?{last_viewed_id:viewed}:{saved_searches:savedSearches(bot.s).map(p=>p.id===scope?{...p,last_viewed_id:viewed}:p)};
  // The marker and response session are one replay-safe user-row mutation.
  await bot.patchInput({...marker,discovery_sessions:[...retained,session].slice(-MAX_SESSIONS),discovery_current:token},'discovery');
  await usage(bot.store,'searches');
  const catalog=groupJobs(all);
  if(!eligible(catalog,bot.s,session).length)await usage(bot.store,'empty');
  return render(bot,session,{persist:false,catalog});
}
export async function replayDiscovery(bot) {
  const session=lookup(bot.s,bot.s.discovery_current);
  return session ? render(bot,session,{jobId:session.current_id,index:session.index||0,mode:session.mode||'s',action:session.view||'show',persist:false}) : expired(bot);
}
export async function discoveryRoute(bot,action) {
  let m;
  if((m=/^notice:([a-z0-9]{12,24})$/.exec(action))){
    const rows=await bot.store.db.all("SELECT job_id FROM sjc_deliveries WHERE user_id=:uid AND json_extract(payload,'$.digest')=:token AND state IN ('sent','sending','uncertain') ORDER BY job_id DESC LIMIT 500",{':uid':bot.uid,':token':m[1]});
    if(!rows.length)return expired(bot);
    const all=await bot.store.jobs(),retained=sessions(bot.s),token=Math.random().toString(36).slice(2,10).padEnd(8,'0');
    const session={token,scope:'notice',kind:'notice',filters:snapshotFilters(defaults()),notice_ids:rows.map(r=>r.job_id),upper_id:all.reduce((max,j)=>Math.max(max,j.id),0),after_id:null,expires:Date.now()+TTL,index:0,mode:'s',view:'show'};
    await bot.patchInput({discovery_sessions:[...retained,session].slice(-MAX_SESSIONS),discovery_current:token},'discovery');
    return render(bot,session,{persist:false,catalog:groupJobs(all)});
  }
  if((m=/^risk:([1-9]\d*)(?::([a-z0-9]{8}):(\d{1,7}):(s|f|rs|rf))?$/.exec(action)) && Number.isSafeInteger(Number(m[1]))) {
    const id=Number(m[1]),session=m[2]&&lookup(bot.s,m[2]);
    if(m[2])return session?render(bot,session,{action:'risk',jobId:id,index:Number(m[3]),mode:m[4]}):expired(bot);
    const job=visibleJobs(groupJobs(await bot.store.jobs()),{...defaults(),hidden_jobs:bot.s.hidden_jobs}).find(j=>j._duplicate_ids.includes(id));
    return job?bot.panel(...reasons(job,`job:${job.id}:short`)):bot.panel('Вакансия больше не доступна.',BACK);
  }
  if((m=/^discover:([a-z0-9]{8}):(0|[1-9]\d*):(\d{1,7}):(show|next|prev|details|translate|hide|actions|problem|open|new|all):(s|f|rs|rf)$/.exec(action)) && Number.isSafeInteger(Number(m[2])) && Number(m[3])<=1000000) {
    const session=lookup(bot.s,m[1]);if(!session)return expired(bot);
    if(['new','all'].includes(m[4]))return openDiscovery(bot,session.scope,m[4]==='new'?'new':'all',session);
    return render(bot,session,{jobId:Number(m[2])||null,index:Number(m[3]),action:m[4],mode:m[5]});
  }
  return expired(bot);
}
