import { OWNER_ID } from './owner.js';
import { positive } from './store.js';
import { button } from './ui.js';
const BACK=[[button('🚫 Баны','admin:bans:0')],[button('📊 Админка','admin')]];
const owner=bot=>bot.uid===OWNER_ID && bot.chat===OWNER_ID;
export async function banInput(bot,message) {
 if(!owner(bot) || bot.s.pending_input!=='owner_ban' || message.text?.startsWith('/'))return false;
 const value=String(message.text||'').trim(),uid=Number(value);
 if(!/^[1-9]\d{0,15}$/.test(value) || !positive(uid) || uid===OWNER_ID){await bot.panel('Введите положительный числовой Telegram ID. Владельца забанить нельзя.',BACK);return true;}
 await bot.patch({pending_input:null});
 await bot.panel(`<b>Забанить пользователя ${uid}?</b>\n\nБот перестанет отвечать на сообщения и кнопки, отправлять вакансии и рекламу. Бан действует до разблокировки владельцем.`,[[button('🚫 Подтвердить бан',`admin:bans:add:${uid}`)],...BACK]);return true;
}
export async function banPanel(bot,action) {
 if(!owner(bot))return bot.panel('Этот раздел доступен только владельцу бота.');
 if(action==='admin:bans:new'){
  await bot.patch({pending_input:'owner_ban'});
  return bot.panel('<b>🚫 Бан пользователя</b>\n\nВведите числовой Telegram ID пользователя. Можно забанить ID до первого обращения в бот.\n\n/cancel — отмена.',BACK);
 }
 let match=/^admin:bans:(add|remove):([1-9]\d*)$/.exec(action);
 if(match){
  const uid=Number(match[2]);if(!positive(uid) || uid===OWNER_ID)return bot.panel('Некорректный ID. Владельца забанить нельзя.',BACK);
  const token=`ban:${Date.now()}:${Math.random()}`,key='user:'+uid;
  // Same lease as inbound updates and both delivery workers: no later sends after confirmation.
  if(!await bot.store.lock(key,token,180))return bot.panel('Пользователь сейчас обрабатывается. Повторите действие через несколько секунд.',[[button('🔄 Повторить',action)],...BACK]);
  try{
   if(match[1]==='add')await bot.store.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('user_ban',:uid,:payload) ON CONFLICT(kind,record_key) DO NOTHING",{':uid':String(uid),':payload':JSON.stringify({uid,at:new Date().toISOString()})});
   else await bot.store.db.run("DELETE FROM sjc_records WHERE kind='user_ban' AND record_key=:uid",{':uid':String(uid)});
  }finally{await bot.store.unlock(key,token);}
  return bot.panel(match[1]==='add'?`Пользователь ${uid} забанен.`:`Пользователь ${uid} разбанен.`,BACK);
 }
 match=/^admin:bans:(\d+)$/.exec(action);if(!match)return bot.panel('Откройте раздел заново.',BACK);
 const total=(await bot.store.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='user_ban'")).n;
 const page=Math.min(Number(match[1]),Math.max(0,Math.ceil(total/5)-1));
 const rows=await bot.store.db.all("SELECT record_key FROM sjc_records WHERE kind='user_ban' ORDER BY record_key LIMIT 5 OFFSET :offset",{':offset':page*5});
 const controls=rows.map(r=>[button(`Разбанить ${r.record_key}`,`admin:bans:remove:${r.record_key}`)]),nav=[];
 if(page)nav.push(button('⬅️',`admin:bans:${page-1}`));if((page+1)*5<total)nav.push(button('➡️',`admin:bans:${page+1}`));
 return bot.panel(`<b>🚫 Баны пользователей</b>\n\nВсего: ${total}\n\n${rows.map(r=>r.record_key).join('\n')||'Список пуст.'}\n\nЗабаненным бот не отвечает и не отправляет уведомления или рекламу. Удаление профиля не снимает бан.`,[[button('➕ Забанить по ID','admin:bans:new')],...controls,...(nav.length?[nav]:[]),[button('🔄 Обновить',`admin:bans:${page}`)],[button('📊 Админка','admin')]]);
}
