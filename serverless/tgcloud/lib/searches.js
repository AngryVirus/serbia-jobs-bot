import { OPTIONS } from './config.js';
import { settings, selected } from './filters.js';
import { button, safe, summary } from './ui.js';

export const MAX_SEARCHES=3;
const ID=/^[a-z0-9]{1,12}$/;
const BACK=[[button('⬅️ Мои вакансии','library')]];
const LIST=[[button('📂 Мои поиски','plans')],...BACK];
const counter=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const name=value=>typeof value==='string'?value.replace(/\s+/gu,' ').trim():'';
const validName=value=>Boolean(value)&&[...value].length<=40&&!/[\p{Cc}\p{Cf}]/u.test(value);

// Saved searches contain only public filtering preferences. Service settings,
// role drafts, notification history and the shared hidden list never migrate.
export function snapshotFilters(raw={}) {
  const s=settings(raw),result={};
  for(const field of ['city','remote','language','residence_permit','freshness']) {
    const allowed=new Set([...Object.keys(OPTIONS[field]),...(field==='language'?['no_serbian']:[])]);
    const values=selected(s,field).filter(value=>allowed.has(value));
    result[field]=values.length?values:['any'];
  }
  for(const field of ['keywords','exclusions'])result[field]=Array.isArray(s[field])?[...new Set(s[field].filter(value=>typeof value==='string').map(value=>value.trim()).filter(value=>value&&[...value].length<=60))].slice(0,15):[];
  result.min_salary=Number.isFinite(s.min_salary)&&s.min_salary>=0&&s.min_salary<=100000000?s.min_salary:null;
  result.currency=['EUR','RSD'].includes(s.currency)?s.currency:'EUR';
  result.include_unknown_salary=s.include_unknown_salary!==false;
  return result;
}

export function savedSearches(raw={}) {
  const ids=new Set(),result=[];
  if(!Array.isArray(raw?.saved_searches))return result;
  for(const saved of raw.saved_searches) {
    if(!saved||!ID.test(saved.id)||saved.id==='main'||ids.has(saved.id)||!validName(name(saved.name))||!saved.filters||typeof saved.filters!=='object'||Array.isArray(saved.filters))continue;
    ids.add(saved.id);
    result.push({id:saved.id,name:name(saved.name),filters:snapshotFilters(saved.filters),notifications:saved.notifications==='instant'?'instant':'off',notifications_after_id:counter(saved.notifications_after_id),last_viewed_id:counter(saved.last_viewed_id)});
    if(result.length===MAX_SEARCHES)break;
  }
  return result;
}

// The main subscription keeps its historical behavior. Saved subscriptions are
// independent; downstream delivery deduplicates jobs across the matching plans.
export function notificationPlans(raw={}) {
  const s=settings(raw),shared={hidden_jobs:Array.isArray(s.hidden_jobs)?[...s.hidden_jobs]:[]},plans=[];
  if(s.notifications!=='off')plans.push({id:'main',name:'Текущие фильтры',filters:{...snapshotFilters(s),...shared},after_id:counter(s.notifications_after_id)});
  for(const saved of savedSearches(s))if(saved.notifications==='instant')plans.push({id:saved.id,name:saved.name,filters:{...saved.filters,...shared},after_id:saved.notifications_after_id});
  return plans;
}

const identifier=searches=>{
  let id;
  do{id=Date.now().toString(36).slice(-6)+Math.random().toString(36).slice(2,8);}while(searches.some(saved=>saved.id===id)||id==='main');
  return id;
};
const prompt=()=>'<b>Название поиска</b>\n\nНапример: «Повар в Белграде». До 40 символов.\n/cancel — отмена.';
const promptRows=[[button('✖ Отменить','plans')],...BACK];

async function listPanel(bot) {
  const searches=savedSearches(bot.s),lines=['<b>📂 Мои поиски</b>','Сохраните до трёх наборов фильтров. У каждого свои уведомления.'];
  if(!searches.length)lines.push('Пока нет сохранённых поисков. Кнопка ниже сохранит текущие фильтры.');
  const rows=searches.map(saved=>[button(`${saved.notifications==='instant'?'🔔':'🔎'} ${saved.name}`,`plans:view:${saved.id}`)]);
  if(searches.length<MAX_SEARCHES)rows.push([button('➕ Сохранить текущие фильтры','plans:create')]);
  else lines.push('Чтобы сохранить другой поиск, удалите один из существующих через «Ещё».');
  return bot.panel(lines.join('\n\n'),[...rows,...BACK]);
}

async function itemPanel(bot,saved) {
  return bot.panel(`<b>📂 ${safe(saved.name,100)}</b>\n\n<blockquote>${summary(saved.filters,true)}</blockquote>\n\nУведомления: ${saved.notifications==='instant'?'включены':'выключены'}.`,[
    [button('🔎 Открыть вакансии',`plans:open:${saved.id}`)],
    [button('⚙️ Загрузить в фильтры',`plans:load:${saved.id}`)],
    [button(saved.notifications==='instant'?'🔕 Выключить уведомления':'🔔 Включить уведомления',`plans:notify:${saved.id}:${saved.notifications==='instant'?'off':'instant'}`)],
    [button('☰ Ещё',`plans:more:${saved.id}`)],[button('📂 Мои поиски','plans')],
  ]);
}

const deletePanel=(bot,saved,token)=>bot.panel(`<b>Удалить поиск «${safe(saved.name,100)}»?</b>\n\nЕго уведомления будут выключены. Текущие фильтры и остальные поиски сохранятся.`,[[button('🗑 Подтвердить удаление',`plans:remove:${saved.id}:${token}`)],[button('↩️ Оставить',`plans:view:${saved.id}`)]]);
const updatePanel=(bot,saved,operation)=>bot.panel(`<b>Обновить фильтры поиска «${safe(saved.name,100)}»?</b>\n\n<blockquote>${summary(operation.filters,true)}</blockquote>\n\nНазвание и переключатель уведомлений сохранятся. Уведомления будут учитывать только вакансии, найденные после обновления.`,[[button('💾 Подтвердить обновление',`plans:replace:${saved.id}:${operation.token}`)],[button('↩️ Отменить',`plans:view:${saved.id}`)]]);
const clearScope=(s,id)=>{
  const sessions=(Array.isArray(s.discovery_sessions)?s.discovery_sessions:[]).filter(item=>item&&item.scope!==id);
  return {discovery_sessions:sessions,discovery_current:sessions.some(item=>item.token===s.discovery_current)?s.discovery_current:null};
};

// A failed Telegram response re-renders the already committed operation.
// In particular, a replay must not allocate another deletion confirmation.
export async function replaySearches(bot) {
  if(bot.s.pending_input==='search_name')return bot.panel(prompt(),promptRows);
  const operation=bot.s.search_operation,saved=savedSearches(bot.s).find(item=>item.id===operation?.id);
  if(operation?.type==='delete'&&saved&&ID.test(operation.token))return deletePanel(bot,saved,operation.token);
  if(operation?.type==='update'&&saved&&ID.test(operation.token))return updatePanel(bot,saved,operation);
  return listPanel(bot);
}

export async function searchRoute(bot,action) {
  if(action==='plans')return listPanel(bot);
  const searches=savedSearches(bot.s);
  if(action==='plans:create') {
    if(searches.length>=MAX_SEARCHES)return bot.panel('Можно сохранить не более трёх поисков. Удалите один из существующих через «Ещё».',LIST);
    await bot.patchInput({pending_input:'search_name',search_operation:{type:'create',filters:snapshotFilters(bot.s)}},'plans');
    return bot.panel(prompt(),promptRows);
  }
  const match=/^plans:(view|open|new|load|notify|more|rename|update|replace|delete|remove):([a-z0-9]{1,12})(?::([a-z0-9]+))?$/.exec(action);
  if(!match)return listPanel(bot);
  const [,kind,id,arg]=match,saved=searches.find(item=>item.id===id);
  if(!saved)return bot.panel('Этот поиск уже удалён. Выберите другой или сохраните текущие фильтры.',LIST);
  if(kind==='view'&&!arg)return itemPanel(bot,saved);
  if(kind==='open'&&!arg)return bot.showPlan(id);
  if(kind==='new'&&!arg)return bot.showPlan(id,true);
  if(kind==='load'&&!arg) {
    await bot.patchInput({...saved.filters,pending_input:null,search_operation:null},'plans');
    return bot.panel(`<b>Фильтры загружены</b>\n\n«${safe(saved.name,100)}» теперь используется в обычном поиске. Сам сохранённый поиск можно открыть отдельно.`,[[button('🔎 Найти вакансии','search:0')],...LIST]);
  }
  if(kind==='notify'&&['off','instant'].includes(arg)) {
    let after=saved.notifications_after_id;
    if(arg==='instant'&&saved.notifications!=='instant')after=await bot.store.latest();
    const updated={...saved,notifications:arg,notifications_after_id:after};
    await bot.patchInput({saved_searches:searches.map(item=>item.id===id?updated:item)},'plans');
    return itemPanel(bot,updated);
  }
  if(kind==='more'&&!arg)return bot.panel(`<b>📂 ${safe(saved.name,100)}</b>\n\nИзменение названия не меняет фильтры и уведомления.`,[[button('⚙️ Обновить из текущих фильтров',`plans:update:${id}`)],[button('✏️ Переименовать',`plans:rename:${id}`)],[button('🗑 Удалить поиск',`plans:delete:${id}`)],[button('↩️ К поиску',`plans:view:${id}`)]]);
  if(kind==='update'&&!arg){
    const operation={type:'update',id,token:identifier([]),filters:snapshotFilters(bot.s)};
    await bot.patchInput({pending_input:null,search_operation:operation},'plans');return updatePanel(bot,saved,operation);
  }
  if(kind==='replace'&&arg){
    const operation=bot.s.search_operation;
    if(operation?.type!=='update'||operation.id!==id||operation.token!==arg)return bot.panel('Подтверждение устарело. Откройте поиск и попробуйте снова.',LIST);
    const updated={...saved,filters:snapshotFilters(operation.filters),notifications_after_id:await bot.store.latest(),last_viewed_id:null};
    await bot.patchInput({saved_searches:searches.map(item=>item.id===id?updated:item),pending_input:null,search_operation:null,...clearScope(bot.s,id)},'plans');return itemPanel(bot,updated);
  }
  if(kind==='rename'&&!arg) {
    await bot.patchInput({pending_input:'search_name',search_operation:{type:'rename',id}},'plans');
    return bot.panel(prompt(),promptRows);
  }
  if(kind==='delete'&&!arg) {
    const token=identifier([]);
    await bot.patchInput({pending_input:null,search_operation:{type:'delete',id,token}},'plans');
    return deletePanel(bot,saved,token);
  }
  if(kind==='remove'&&arg) {
    const operation=bot.s.search_operation;
    if(operation?.type!=='delete'||operation.id!==id||operation.token!==arg)return bot.panel('Подтверждение устарело. Откройте поиск и попробуйте снова.',LIST);
    await bot.patchInput({saved_searches:searches.filter(item=>item.id!==id),pending_input:null,search_operation:null,...clearScope(bot.s,id)},'plans');
    return listPanel(bot);
  }
  return itemPanel(bot,saved);
}

export async function searchInput(bot,message) {
  if(bot.s.pending_input!=='search_name'||typeof message.text!=='string'||message.text.startsWith('/'))return false;
  const operation=bot.s.search_operation,searches=savedSearches(bot.s),value=name(message.text);
  if(!operation||!['create','rename'].includes(operation.type)) {
    await bot.patchInput({pending_input:null,search_operation:null},'plans');
    await bot.panel('Ввод названия отменён. Откройте нужный поиск заново.',LIST);return true;
  }
  if(!validName(value)){await bot.panel('Введите название от 1 до 40 символов, без управляющих символов.',promptRows);return true;}
  if(searches.some(saved=>saved.name.toLowerCase()===value.toLowerCase()&&saved.id!==operation.id)){await bot.panel('Поиск с таким названием уже есть. Введите другое название.',promptRows);return true;}
  let updated;
  if(operation.type==='create') {
    if(searches.length>=MAX_SEARCHES){await bot.patchInput({pending_input:null,search_operation:null},'plans');await bot.panel('Уже сохранены три поиска. Сначала удалите один из них.',LIST);return true;}
    updated={id:identifier(searches),name:value,filters:snapshotFilters(operation.filters||bot.s),notifications:'off',notifications_after_id:0,last_viewed_id:null};
    searches.push(updated);
  } else {
    const index=searches.findIndex(saved=>saved.id===operation.id);
    if(index<0){await bot.patchInput({pending_input:null,search_operation:null},'plans');await bot.panel('Поиск уже удалён. Сохраните новый из текущих фильтров.',LIST);return true;}
    updated={...searches[index],name:value};searches[index]=updated;
  }
  await bot.patchInput({saved_searches:searches,pending_input:null,search_operation:null},'plans');
  await itemPanel(bot,updated);return true;
}
