import {accessRole,rank} from './permissions.js';
import {reasons} from './discovery.js';
import { defaults, hidden } from './filters.js';
import { groupJobs, visibleJobs, includesId, hiddenGroups } from './catalog.js';
import { button, BACK, safe, clip, jobButtons,translatedCard,cardActions,sourceChoice } from './ui.js';
const HOME=[[button('⬅️ Мои вакансии','library')]];
export async function hasFavorite(bot,job) {
 const ids=new Set(await bot.store.favoriteIds(bot.uid));
 return (job._duplicate_ids||[job.id]).some(id=>ids.has(id));
}
export async function libraryRoute(bot,action,catalog=null) {
 const saved=new Set(await bot.store.favoriteIds(bot.uid)),groups=catalog||groupJobs(await bot.store.jobs());
 const selected=groups.filter(g=>g.members.some(j=>saved.has(j.id)));
 const present=new Set(selected.flatMap(g=>g.members.map(j=>j.id)));
 const missing=[...saved].filter(id=>!present.has(id));
 if(action==='library')return bot.panel('<b>📂 Мои вакансии</b>\n\nИзбранные — объявления, к которым хотите вернуться. Скрытые — убранные из вашего поиска и уведомлений. Сохранённые поиски — отдельные наборы условий.',[[button(`⭐ Избранные · ${selected.length+missing.length}`,'favorites:0')],[button(`🙈 Скрытые · ${hiddenGroups(groups,bot.s).length}`,'hidden:0')],[button('📂 Сохранённые поиски','plans')],...BACK]);
 let m;
 if((m=/^favorite:(add|remove):([1-9]\d*)(?::(fav|[a-z0-9]{8}):(\d{1,7}):(s|f|rs|rf))?$/.exec(action))) {
  const id=Number(m[2]);if(!Number.isSafeInteger(id))return libraryRoute(bot,'library');
  const group=groups.find(g=>includesId(g,id)),enabled=m[1]==='add';
  if(enabled&&!visibleJobs(group?[group]:[],defaults()).length)return bot.panel('Вакансия сейчас недоступна. Сохранить можно действующее объявление.',HOME);
  const ok=await bot.store.setFavorite(bot.uid,group?group.members.map(j=>j.id):[id],enabled,bot.updateKey||'local:'+Date.now());
  if(!ok)return bot.panel('В избранном уже 200 вакансий. Уберите ненужные, чтобы сохранить новые.',HOME);
  const current=await bot.store.favoriteIds(bot.uid);
  if(current.some(i=>group?includesId(group,i):i===id)!==enabled)return bot.panel('Это действие уже обработано, а избранное с тех пор изменилось. Откройте актуальный список.',[[button('⭐ Избранные','favorites:0')],...HOME]);
  if(m[3]==='fav'&&!enabled)return libraryRoute(bot,'favorites:0');
  const back=m[3]==='fav'?`favorites:show:${id}:${m[5]}`:m[3]?`discover:${m[3]}:${id}:${m[4]}:show:${m[5]}`:`job:${id}:short`;
  return bot.panel(enabled?'⭐ Вакансия сохранена в избранном. Фильтры и уведомления остаются прежними.':'Вакансия убрана из избранного.',[...(group?[[button('↩️ К вакансии',back)]]:[]),[button('⭐ Избранные','favorites:0')],...HOME]);
 }
 const available=visibleJobs(selected,defaults());
 if((m=/^favorites:(show|open|actions|problem|translate|hide|risk):([1-9]\d*)(?::(s|f|rs|rf))?$/.exec(action))) {
  const id=Number(m[2]),group=selected.find(g=>includesId(g,id));let mode=m[3]||'s';
  if(!group&&!missing.includes(id))return bot.panel('Этой вакансии уже нет в вашем избранном.',HOME);
  const job=available.find(j=>j._duplicate_ids.includes(id));
  if(!job)return bot.panel('<b>⭐ Сохранённая вакансия недоступна</b>\n\nОбъявление закрыто, снято с выдачи или больше не найдено. Его можно убрать из избранного.',[[button('🗑 Убрать из избранного',`favorite:remove:${id}`)],[button('⭐ К избранным','favorites:0')],...HOME]);
  const back=`favorites:show:${id}:${mode}`;
  if(m[1]==='open')return bot.panel(...sourceChoice(job,back));
  if(m[1]==='risk')return bot.panel(...reasons(job,back));
  if(['actions','problem'].includes(m[1]))return bot.panel(...cardActions(job,0,mode,{favorite:true},true,m[1]==='problem',rank(await accessRole(bot))>=2));
  if(m[1]==='hide')await bot.patch({hidden_jobs:[...new Set([...hidden(bot.s),id])]});
  if(m[1]==='translate')mode=mode.startsWith('r')?mode.slice(1):'r'+mode;
  const result=await translatedCard(job,mode,bot.fetch,bot.store);mode=result.mode;
  const controls=jobButtons(job,mode).map(row=>row.map(b=>{
   if(b.callback_data?.startsWith('job:'))return {...b,callback_data:`favorites:show:${id}:${mode.startsWith('r')?'r':''}${mode.endsWith('f')?'s':'f'}`};
   if(b.callback_data?.startsWith('open:'))return {...b,callback_data:`favorites:open:${id}:${mode}`};
   if(b.callback_data?.startsWith('actions:'))return {...b,callback_data:`favorites:actions:${id}:${mode}`};
   if(b.callback_data?.startsWith('ratings:'))return {...b,callback_data:`ratings:${id}:list:0:fav:0:${mode}`};
   return b;
  }));
  return bot.panel('<i>⭐ Избранное'+(job._duplicate_ids.some(i=>hidden(bot.s).has(i))?' · скрыта из вашего поиска':'')+'</i>\n\n'+result.text,[...controls,[button('⭐ К избранным','favorites:0')]],bot.mid,false);
 }
 if((m=/^favorites:(\d{1,6})$/.exec(action))) {
  const entries=[...selected.map(g=>({id:g.id,title:g.members[0].title})),...missing.map(id=>({id,title:'Объявление больше не найдено'}))].sort((a,b)=>b.id-a.id);
  const page=Math.min(Number(m[1]),Math.max(0,Math.ceil(entries.length/5)-1)),slice=entries.slice(page*5,page*5+5),rows=[];
  const lines=['<b>⭐ Избранные вакансии</b>','Сохранённые объявления доступны здесь независимо от выбранных фильтров.'];
  if(!entries.length)lines.push('Пока пусто. В карточке вакансии откройте «Ещё» → «Сохранить».');
  for(const [i,e] of slice.entries()){const j=available.find(j=>j._duplicate_ids.includes(e.id));lines.push(`${page*5+i+1}. ${safe(e.title,130)}${j?'':' · недоступна'}`);rows.push([button(`📄 ${page*5+i+1}. ${clip(e.title,40)}`,`favorites:show:${e.id}`)]);}
  const nav=[];if(page)nav.push(button('⬅️',`favorites:${page-1}`));if((page+1)*5<entries.length)nav.push(button('➡️',`favorites:${page+1}`));
  return bot.panel(lines.join('\n\n'),[...rows,...(nav.length?[nav]:[]),...HOME]);
 }
 return libraryRoute(bot,'library',groups);
}
