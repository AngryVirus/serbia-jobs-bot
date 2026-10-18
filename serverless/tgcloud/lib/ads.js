import { deliveryForbidden } from './analytics.js';
import { OWNER_ID } from './owner.js';
import { button, safe } from './ui.js';

const BACK=[[button('📣 Реклама','ads')],[button('📊 Админка','admin')]];
const prefix='📣 Реклама\n\n';
const token=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,8);
const read=async(store,kind,key)=>{const r=await store.db.get('SELECT payload FROM sjc_records WHERE kind=:kind AND record_key=:key',{':kind':kind,':key':key});return r?JSON.parse(r.payload):null;};
async function audit(store,action,id=null) { await store.record('ad_audit',token(),{owner:OWNER_ID,action,id,at:new Date().toISOString()}); }
const eligible=u=>u && u.settings?.ads_enabled!==false && !u.settings?.bot_blocked;
const audienceSQL="FROM sjc_users WHERE COALESCE(json_extract(payload,'$.settings.ads_enabled'),1) != 0 AND COALESCE(json_extract(payload,'$.settings.bot_blocked'),0) = 0";

export async function sendAd(api,chat,post) {
  const rows=[];
  if(post.link) rows.push([{text:post.link.text,url:post.link.url}]);
  const entities=(post.entities||[]).map(e=>({...e,offset:e.offset+prefix.length}));
  const common={chat_id:chat,...(rows.length?{reply_markup:{inline_keyboard:rows}}:{})};
  return post.photo ? api.sendPhoto({...common,photo:post.photo,caption:prefix+post.text,caption_entities:entities})
    : api.sendMessage({...common,text:prefix+post.text,entities,link_preview_options:{is_disabled:true}});
}

export async function adInput(bot,message) {
  if(bot.uid!==OWNER_ID || bot.chat!==OWNER_ID || !['ad_post','ad_link'].includes(bot.s.pending_input)) return false;
  if(message.text?.startsWith('/')) return false;
  let draft=await bot.store.meta('ad_draft');
  if(bot.s.pending_input==='ad_link') {
    if(!draft) {await bot.patch({pending_input:null});return true;}
    const m=/^([^|\n]{1,40})\s*\|\s*(https:\/\/[^\s<>"\\]+)$/.exec(message.text||'');
    if(!m || m[2].length>1000 || /@/.test(m[2].split('/')[2])) {await bot.panel('Отправьте: Текст кнопки | https://example.com',BACK);return true;}
    draft={...draft,id:token(),link:{text:m[1].trim(),url:m[2]},confirmed:false,previewed:false};
  } else {
    const photo=message.photo?.at(-1)?.file_id;
    const text=photo?(message.caption||''):message.text;
    if(message.media_group_id || typeof text!=='string' || (!photo&&!text.trim())) {await bot.panel('Отправьте один текстовый пост или одну фотографию с подписью. Альбомы и видео пока не поддерживаются.',BACK);return true;}
    if(text.length+prefix.length>(photo?1024:4096)) {await bot.panel(`Сократите ${photo?'подпись':'текст'} до ${ (photo?1024:4096)-prefix.length} символов.`,BACK);return true;}
    draft={id:token(),text,photo:photo||null,entities:photo?(message.caption_entities||[]):(message.entities||[]),confirmed:false};
  }
  await bot.store.setMeta('ad_draft',draft);await audit(bot.store,'create',draft.id);await bot.patch({pending_input:null});
  await preview(bot,draft);return true;
}

async function preview(bot,draft) {
  try {await sendAd(bot.api,OWNER_ID,draft);} catch {return bot.panel('Не удалось показать предпросмотр. Черновик сохранён, попробуйте ещё раз.',BACK);}
  await bot.store.setMeta('ad_draft',{...draft,previewed:true});
  return bot.panel('<b>Предпросмотр рассылки</b>\nПост выше увидят получатели. Сначала проверьте текст и ссылку.',[
    [button('🔗 Добавить / изменить кнопку',`ads:link:${draft.id}`)],
    [button('📨 Выбрать всех получателей',`ads:confirm:${draft.id}`)],...BACK]);
}

export async function adStatus(bot) {
  const id=await bot.store.meta('ad_current'),campaign=id&&await read(bot.store,'ad_campaign',id);
  let text='<b>📣 Реклама</b>\n\nТекст или фото с подписью → предпросмотр → подтверждение.\nРассылка всем пользователям, кроме отказавшихся от рекламы и заблокировавших бота.';
  const rows=[];
  if(campaign) {
    const counts=await bot.store.db.all("SELECT json_extract(payload,'$.state') AS state,COUNT(*) AS n FROM sjc_records WHERE kind='ad_delivery' AND record_key LIKE :prefix GROUP BY state",{':prefix':id+':%'});
    const c=Object.fromEntries(counts.map(r=>[r.state,r.n]));
    const stopped=await bot.store.meta('ad_stop:'+id) || (await bot.store.meta('ad_emergency') || 0)>=Date.parse(campaign.created_at);
    text+=`\n\n<b>${stopped?'Остановлена':({running:'Рассылка идёт',done:'Завершена',stopped:'Остановлена'})[campaign.state]}</b>\nПолучателей при запуске: ${campaign.total}\nДоставлено: ${c.sent||0} · блокировок: ${c.blocked||0}\nПропущено: ${c.skipped||0} · ошибок: ${c.failed||0}\nНеподтверждённых: ${(c.uncertain||0)+(c.sending||0)}`;
    if(campaign.state==='running'&&!stopped) rows.push([button('⏹ Остановить',`ads:stop:${id}`)]);
  }
  rows.push([button('📋 Журнал действий','ads:audit')]);
  rows.push([button('🛑 Остановить всю рекламу','ads:emergency')]);
  rows.push([button('Лимит: 1/сутки','ads:limit:1'),button('3/сутки','ads:limit:3'),button('5/сутки','ads:limit:5')]);
  text+=`\nЛимит запусков: ${await bot.store.meta('ad_daily_limit') || 3}/сутки (UTC).`;
  rows.push([button('✍️ Создать пост','ads:new'),button('🔄 Обновить','ads')]);
  if(await bot.store.meta('ad_draft')) rows.push([button('👁 Черновик','ads:preview')]);
  return bot.panel(text,[...rows,[button('📊 Админка','admin')]]);
}

export async function adRoute(bot,action) {
  const requestedAt=new Date().toISOString();
  if(action==='ads:off'||action==='ads:on') {
    await bot.patch({ads_enabled:action==='ads:on'});
    return bot.panel(action==='ads:off'?'Реклама отключена. Настройка уведомлений о вакансиях не изменилась.':'Рекламные сообщения включены.',[[button('🏠 Меню','menu')]]);
  }
  if(bot.uid!==OWNER_ID||bot.chat!==OWNER_ID) return bot.panel('Этот раздел доступен только владельцу бота.');
  if(action==='ads:audit') {
    const entries=(await bot.store.db.all("SELECT payload FROM sjc_records WHERE kind='ad_audit' ORDER BY json_extract(payload,'$.at') DESC LIMIT 20")).map(r=>JSON.parse(r.payload));
    return bot.panel('<b>Журнал рекламы</b>\n'+entries.map(r=>`${safe(r.at)} · ${safe(r.action)} · ${safe(r.id || '—')}`).join('\n'),BACK);
  }
  if(action==='ads:emergency') {
    await bot.store.setMeta('ad_emergency',Date.now());
    const current=await bot.store.meta('ad_current');
    if(current) await bot.store.setMeta('ad_stop:'+current,true);
    await audit(bot.store,'emergency_stop');return adStatus(bot);
  }
  if(/^ads:limit:[135]$/.test(action)) {await bot.store.setMeta('ad_daily_limit',Number(action.at(-1)));await audit(bot.store,'limit');return adStatus(bot);}
  if(action==='ads') return adStatus(bot);
  if(action==='ads:new') {await bot.store.setMeta('ad_draft',null);await bot.patch({pending_input:'ad_post'});return bot.panel('Отправьте или перешлите текстовый пост либо одну фотографию с подписью. Форматирование сохранится.\n/cancel — отмена.',BACK);}
  const draft=await bot.store.meta('ad_draft');
  if(action==='ads:preview'&&draft) return preview(bot,draft);
  const m=/^ads:(link|confirm|start|stop):([a-z0-9]+)$/.exec(action);
  if(!m) return adStatus(bot);
  const [,operation,id]=m;
  if(operation==='stop') {await bot.store.setMeta('ad_stop:'+id,true);await audit(bot.store,'stop',id);return adStatus(bot);}
  if(!draft||draft.id!==id) return bot.panel('Этот черновик устарел. Откройте актуальный предпросмотр.',BACK);
  if(operation==='link') {await bot.patch({pending_input:'ad_link'});return bot.panel('Отправьте: Текст кнопки | https://example.com',BACK);}
  if(operation==='confirm'&&draft.previewed) {
    const {n}=await bot.store.db.get('SELECT COUNT(*) AS n '+audienceSQL);
    await bot.store.setMeta('ad_draft',{...draft,confirmed:true});await audit(bot.store,'confirm',id);
    return bot.panel(`<b>Отправить рекламу ${n} пользователям?</b>\n\nПервые сообщения отправятся после подтверждения. Остальные — фоновыми порциями; GitHub может задержать продолжение. Остановить можно оставшуюся очередь.`,[[button(`✅ Отправить всем · ${n}`,`ads:start:${id}`)],...BACK]);
  }
  if(operation==='start'&&draft.confirmed&&draft.previewed) {
    const lock=token(); if(!await bot.store.lock('ad_worker',lock,180)) return bot.panel('Рассылка обрабатывается. Попробуйте через несколько секунд.',BACK);
    try {
      const oldId=await bot.store.meta('ad_current'),old=oldId&&await read(bot.store,'ad_campaign',oldId);
      if(await read(bot.store,'ad_campaign',id)) {
        if(oldId!==id && (!old || old.state!=='running' || await bot.store.meta('ad_stop:'+oldId))) await bot.store.setMeta('ad_current',id);
        return adStatus(bot);
      }
      if(old?.state==='running'&&!await bot.store.meta('ad_stop:'+oldId)) return bot.panel('Сначала дождитесь завершения текущей рассылки или остановите её.',BACK);
      const day=new Date().toISOString().slice(0,10);
      const reserved=await bot.store.db.run("INSERT INTO sjc_records(kind,record_key,payload) SELECT 'ad_launch',:id,:payload WHERE (SELECT COUNT(*) FROM sjc_records WHERE kind='ad_launch' AND json_extract(payload,'$.day')=:day)<:limit ON CONFLICT(kind,record_key) DO NOTHING",{':id':id,':payload':JSON.stringify({day}),':day':day,':limit':await bot.store.meta('ad_daily_limit') || 3});
      if(reserved.rowsAffected!==1) return bot.panel('Суточный лимит запусков исчерпан или запуск уже принят. Новый лимит — после 00:00 UTC.',BACK);
      await audit(bot.store,'start',id);
      await bot.store.db.run("INSERT OR IGNORE INTO sjc_records(kind,record_key,payload) SELECT 'ad_target',:prefix || printf('%020d',id),json_object('uid',id,'created_at',json_extract(payload,'$.created_at')) "+audienceSQL,{':prefix':id+':'});
      const snapshot=await bot.store.db.get("SELECT COUNT(*) AS n,MAX(json_extract(payload,'$.uid')) AS max_id FROM sjc_records WHERE kind='ad_target' AND record_key LIKE :prefix",{':prefix':id+':%'});
      await bot.store.record('ad_campaign',id,{id,post:draft,state:'running',cursor:0,max_id:snapshot.max_id||0,total:snapshot.n,created_at:requestedAt});
      await bot.store.setMeta('ad_current',id);
    } finally {await bot.store.unlock('ad_worker',lock);}
    await adTick(bot.store,bot.api,bot.uid);return adStatus(bot);
  }
  return adStatus(bot);
}

export async function adTick(store,api,heldUser=null) {
  if(!await store.meta('active')) return {done:true};
  const lock=token(); if(!await store.lock('ad_worker',lock,180)) return {busy:true};
  try {
    const id=await store.meta('ad_current'),c=id&&await read(store,'ad_campaign',id);
    if(!c||c.state!=='running') return {done:true};
    if((await store.meta('ad_emergency') || 0)>=Date.parse(c.created_at) || await store.meta('ad_stop:'+id)) {c.state='stopped';await store.record('ad_campaign',id,c);return {done:true};}
    if(c.retry_at>Date.now()) return {retry_after:Math.ceil((c.retry_at-Date.now())/1000)};
    const page=await store.db.all("SELECT json_extract(payload,'$.uid') AS id,payload FROM sjc_records WHERE kind='ad_target' AND record_key LIKE :prefix AND record_key>:cursor ORDER BY record_key LIMIT 5",{':prefix':id+':%',':cursor':id+':'+String(c.cursor).padStart(20,'0')});
    for(const row of page) {
      if(!await store.lock('ad_worker',lock,180)) return {busy:true};
      if((await store.meta('ad_emergency') || 0)>=Date.parse(c.created_at) || await store.meta('ad_stop:'+id)) {c.state='stopped';break;}
      const key=id+':'+row.id;
      const owner=token();
      const held=row.id===heldUser;
      if(!held&&!await store.lock('user:'+row.id,owner,180)) break;
      try {
        const u=await store.user(row.id);
        let receipt=await read(store,'ad_delivery',key);
        if(!receipt) {
          receipt={at:new Date().toISOString(),state:eligible(u)&&u.created_at===JSON.parse(row.payload).created_at?'sending':'skipped'};
          const claim=await store.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('ad_delivery',:key,:payload) ON CONFLICT(kind,record_key) DO NOTHING",{':key':key,':payload':JSON.stringify(receipt)});
          if(claim.rowsAffected!==1) break;
          if(receipt.state==='sending') {
            if((await store.meta('ad_emergency') || 0)>=Date.parse(c.created_at) || await store.meta('ad_stop:'+id)) {c.state='stopped';break;}
            if(!await store.lock('ad_worker',lock,180)) return {busy:true};
            try {
              const message=await sendAd(api,u.chat_id,c.post);
              if(!Number.isSafeInteger(message?.message_id)||message.message_id<=0) throw new Error('Unconfirmed send');
              receipt.state='sent';
            } catch(error) {
              if(error.code===429) {
                await store.db.run("DELETE FROM sjc_records WHERE kind='ad_delivery' AND record_key=:key",{':key':key});
                c.retry_at=Date.now()+Math.min(3600,Math.max(5,Number(error.parameters?.retry_after)||60))*1000;
                await store.record('ad_campaign',id,c);return {retry_after:Math.ceil((c.retry_at-Date.now())/1000)};
              }
              receipt.state=error.code===403?'blocked':error.code===400?'failed':'uncertain';
              if(error.code===403) await deliveryForbidden(store,row.id,error);
            }
            await store.record('ad_delivery',key,receipt);
          }
        }
        // A previous sending claim may have been delivered before a crash.
        // Keep it unconfirmed; never resend automatically.
        c.cursor=row.id;await store.record('ad_campaign',id,c);
      } finally {if(!held) await store.unlock('user:'+row.id,owner);}
    }
    if(page.length===0||c.cursor>=c.max_id) c.state='done';
    if(c.state==='running') c.retry_at=Date.now()+1100;
    await store.record('ad_campaign',id,c);
    return {done:c.state!=='running'};
  } finally {await store.unlock('ad_worker',lock);}
}
