import { OWNER_ID } from './permissions.js';
import { sourceEnabled } from './source-policy.js';
import { button, BACK, safe } from './ui.js';
const HELP=[[button('💬 К помощи','help')],...BACK];
const OWNER_BACK=[[button('📡 Сбор вакансий','admin:collection')],[button('📊 Отчёт владельца','admin')]];
export function sourceUsername(value) {
 if(typeof value!=='string')return null;
 const m=/^(?:@|https:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?)?([a-z][a-z0-9_]{3,31})(?:\/\d+)?\/?$/i.exec(value.trim());
 const name=m?.[1]?.toLowerCase();
 return name&&!['joinchat','share','proxy','socks','addstickers','addemoji','login','iv','boost'].includes(name)?name:null;
}
const known=name=>sourceEnabled('tg_'+name)||sourceEnabled('telegram_'+name);
export async function notifySourceIdeas(store,api) {
 const rows=await store.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='source_idea' AND json_extract(payload,'$.notice')='pending' AND COALESCE(json_extract(payload,'$.notice_after'),0)<=:now ORDER BY record_key LIMIT 3",{':now':Date.now()});
 for(const row of rows){
  const data=JSON.parse(row.payload),sending={...data,notice:'sending'};
  const update=async(before,after)=>store.db.run("UPDATE sjc_records SET payload=:next WHERE kind='source_idea' AND record_key=:key AND payload=:old",{':key':row.record_key,':old':JSON.stringify(before),':next':JSON.stringify(after)});
  if((await update(data,sending)).rowsAffected!==1)continue;
  const next={...sending,notice:'sent'};
  try{
   const sent=await api.sendMessage({chat_id:OWNER_ID,text:'<b>📡 Предложен Telegram-источник</b>\n\n@'+safe(row.record_key,32)+'\nПроверьте тематику Сербии и доступность публичных вакансий.',parse_mode:'HTML',reply_markup:{inline_keyboard:[[button('📋 Предложения','admin:ideas:pending:0')]]}});
   if(!Number.isSafeInteger(sent?.message_id)||sent.message_id<=0)throw Error('Unconfirmed source notice');
  }catch(e){next.notice=e.code===429?'pending':e.code===403?'blocked':'uncertain';if(e.code===429)next.notice_after=Date.now()+Math.min(3600,Math.max(5,Number(e.parameters?.retry_after)||60))*1000;}
  await update(sending,next);
  if(next.notice==='pending')break;
 }
}
export async function sourceIdeaRoute(bot,action) {
 if(action==='idea:start'){
  await bot.patch({pending_input:'source_idea'});
  return bot.panel('<b>📡 Предложить источник</b>\n\nПришлите ссылку https://t.me/название или @название публичного Telegram-канала с вакансиями в Сербии.\n\nВладелец проверит предложение. Отправка ссылки не подключает канал автоматически. Закрытые чаты и ссылки-приглашения сборщику недоступны.',[[button('✖ Отменить','help')],...BACK]);
 }
 if(bot.uid!==OWNER_ID||bot.chat!==OWNER_ID)return bot.panel('Этот раздел доступен только владельцу бота.',BACK);
 let m;
 if((m=/^admin:ideas:(work|reject):([a-z][a-z0-9_]{3,31})$/.exec(action))){
  const row=await bot.store.db.get("SELECT payload FROM sjc_records WHERE kind='source_idea' AND record_key=:key",{':key':m[2]});
  if(row){const previous=JSON.parse(row.payload);if(previous.state==='pending')await bot.store.db.run("UPDATE sjc_records SET payload=:next WHERE kind='source_idea' AND record_key=:key AND payload=:old",{':key':m[2],':old':row.payload,':next':JSON.stringify({...previous,state:m[1]==='work'?'work':'rejected',updated_at:new Date().toISOString()})});}
  return bot.panel(m[1]==='work'?'Предложение взято в работу. Проверьте канал перед подключением к сбору.':'Предложение отклонено.',[[button('📋 К предложениям','admin:ideas:pending:0')],...OWNER_BACK]);
 }
 if((m=/^admin:ideas:(pending|reviewed):(\d{1,6})$/.exec(action))){
  const pending=m[1]==='pending',params={':state':pending?'pending':'reviewed'};
  const where="kind='source_idea' AND (CASE WHEN :state='pending' THEN json_extract(payload,'$.state')='pending' ELSE json_extract(payload,'$.state')!='pending' END)";
  const total=(await bot.store.db.get('SELECT COUNT(*) AS n FROM sjc_records WHERE '+where,params)).n;
  const page=Math.min(Number(m[2]),Math.max(0,Math.ceil(total/4)-1));
  const rows=await bot.store.db.all('SELECT record_key,payload FROM sjc_records WHERE '+where+' ORDER BY record_key LIMIT 4 OFFSET :offset',{...params,':offset':page*4});
  const text=['<b>📡 Предложения источников</b>',pending?'Новые предложения. Проверьте публичность, вакансии и тематику Сербии.':'Взятые в работу и отклонённые предложения за последние 90 дней.','Кнопка «В работу» сохраняет решение; подключение источника выполняется после проверки.'],buttons=[];
  for(const row of rows){const value=JSON.parse(row.payload);text.push('@'+row.record_key+' — '+({pending:'ожидает проверки',work:'в работе',rejected:'отклонён'}[value.state]||'рассмотрен'));buttons.push([{text:'🔗 @'+row.record_key,url:'https://t.me/'+row.record_key}]);if(pending)buttons.push([button('✅ В работу','admin:ideas:work:'+row.record_key),button('❌ Отклонить','admin:ideas:reject:'+row.record_key)]);}
  if(!rows.length)text.push('Список пуст.');
  const nav=[];if(page)nav.push(button('⬅️',`admin:ideas:${m[1]}:${page-1}`));if((page+1)*4<total)nav.push(button('➡️',`admin:ideas:${m[1]}:${page+1}`));
  return bot.panel(text.join('\n\n'),[...buttons,...(nav.length?[nav]:[]),[button(pending?'📋 Рассмотренные':'📋 Новые предложения',`admin:ideas:${pending?'reviewed':'pending'}:0`)],...OWNER_BACK]);
 }
 return bot.panel('Откройте предложения источников заново.',OWNER_BACK);
}
export async function sourceIdeaInput(bot,message) {
 if(bot.s.pending_input!=='source_idea'||message.text?.startsWith('/'))return false;
 const username=sourceUsername(message.text);
 if(!username){await bot.panel('Пришлите одну ссылку на публичный Telegram-канал или его @название. Ссылки-приглашения и другие сайты не подходят.',HELP);return true;}
 if(known(username)){await bot.patch({pending_input:null});await bot.panel('Этот Telegram-источник уже подключён к сбору.',HELP);return true;}
 const existing=await bot.store.db.get("SELECT 1 AS found FROM sjc_records WHERE kind='source_idea' AND record_key=:key",{':key':username});
 if(!existing){
  const wait=await bot.store.rate(bot.uid+':source_idea',3,86400);
  if(wait){await bot.panel(`Сегодня вы уже предложили три источника. Повторите через ${Math.ceil(wait/3600)} ч.`,HELP);return true;}
  const result=await bot.store.db.run("INSERT INTO sjc_records(kind,record_key,payload) SELECT 'source_idea',:key,:payload WHERE (SELECT COUNT(*) FROM sjc_records WHERE kind='source_idea' AND json_extract(payload,'$.state')='pending')<100 ON CONFLICT(kind,record_key) DO NOTHING",{':key':username,':payload':JSON.stringify({state:'pending',created_at:new Date().toISOString(),notice:'pending'})});
  if(!result.rowsAffected&&!await bot.store.db.get("SELECT 1 AS found FROM sjc_records WHERE kind='source_idea' AND record_key=:key",{':key':username})){await bot.panel('Сейчас много предложений на проверке. Попробуйте позже.',HELP);return true;}
 }
 await bot.patch({pending_input:null});
 try{await notifySourceIdeas(bot.store,bot.api);}catch{/* The durable proposal remains available in the owner's queue. */}
 await bot.panel(existing?'Этот источник уже предложен. Повторная заявка не нужна.':'Спасибо! Источник сохранён для проверки владельцем. Подключение возможно после проверки.',HELP);
 return true;
}
