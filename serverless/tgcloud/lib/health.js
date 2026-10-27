import { OWNER_ID } from './owner.js';
import { successfulCollection } from './analytics.js';
// Persistent transitions claimed before delivery: ambiguous sends are never replayed.
export async function healthTick(store,api,now=Date.now()) {
  await store.pruneStaffAudit(now);
  if(!await store.meta('active')) return {paused:true};
  const lock=`${now}:${Math.random()}`;
  if(!await store.lock('health',lock,120)) return {busy:true};
  try {
    const last=await successfulCollection(store);
    const rows=await store.db.all("SELECT state,COUNT(DISTINCT CAST(user_id AS TEXT)||':'||COALESCE('digest:'||json_extract(payload,'$.digest'),'job:'||CAST(job_id AS TEXT))) AS n FROM sjc_deliveries WHERE json_extract(payload,'$.delivered_at')>=:since GROUP BY state",{':since':new Date(now-7200000).toISOString()});
    const ads=await store.db.all("SELECT json_extract(payload,'$.state') AS state,COUNT(*) AS n FROM sjc_records WHERE kind='ad_delivery' AND json_extract(payload,'$.at')>=:since GROUP BY state",{':since':new Date(now-7200000).toISOString()});
    let backupSince=await store.meta('backup_monitor_since');
    if(!backupSince){backupSince=new Date(now).toISOString();await store.setMeta('backup_monitor_since',backupSince);}
    const lastBackup=await store.meta('last_backup');
    const checks={backup:now-Date.parse(lastBackup?.verified_at || backupSince)>36*3600000,collection:!Number.isFinite(Date.parse(last)) || now-Date.parse(last)>7200000};
    for(const [kind,list] of [['notifications',rows],['advertising',ads]]) {
      const total=list.filter(r=>r.state!=='skipped').reduce((n,r)=>n+r.n,0),bad=list.filter(r=>['blocked','failed','uncertain','sending'].includes(r.state)).reduce((n,r)=>n+r.n,0);
      checks[kind]=bad>=5 && bad/total>=0.2;
    }
    for(const [kind,bad] of Object.entries(checks)) {
      const key='health:'+kind,previous=await store.meta(key);
      const retry=previous?.notice==='pending' && previous.retry_at<=now;
      if(Boolean(previous?.bad)===bad && !retry) continue;
      await store.setMeta(key,{bad,at:new Date(now).toISOString(),notice:'claimed'});
      try {
        const message=await api.sendMessage({chat_id:OWNER_ID,text:bad ? ({backup:'⚠️ Более 36 часов нет подтверждённой резервной копии. Проверьте Encrypted SQLite backup в Actions.',collection:'⚠️ Нет успешного сбора вакансий более двух часов.',notifications:'⚠️ Повышенная доля ошибок доставки уведомлений за 2 часа (не менее 5 и 20%).',advertising:'⚠️ Повышенная доля ошибок доставки рекламы за 2 часа (не менее 5 и 20%).'})[kind] : `✅ Восстановление: ${{backup:'резервное копирование',collection:'сбор вакансий',notifications:'доставка уведомлений',advertising:'доставка рекламы'}[kind]}.`});
        if(!Number.isSafeInteger(message?.message_id) || message.message_id<=0) throw Error('Unconfirmed warning');
        await store.setMeta(key,{bad,at:new Date(now).toISOString(),notice:'sent'});
      } catch(error) {
        if(error.code===429) await store.setMeta(key,{bad,notice:'pending',retry_at:now+Math.min(3600,Math.max(5,Number(error.parameters?.retry_after)||60))*1000});
        // Ambiguous sends remain claimed; no payloads or user details are logged.
      }
    }
    return {checked:true};
  } finally {await store.unlock('health',lock);}
}
