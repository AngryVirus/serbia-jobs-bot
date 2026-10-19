// Read-only diagnostics. No user IDs, filter text or recipient details in output.
import { notificationPlans, savedSearches } from './searches.js';
import { groupJobs, visibleJobs } from './catalog.js';
import { successfulCollection } from './analytics.js';
export async function notificationState(store,uid,now=Date.now()) {
 const user=await store.user(uid),plans=notificationPlans(user?.settings||{});
 const deliveries=plans.length?await store.db.all('SELECT job_id,state FROM sjc_deliveries WHERE user_id=:uid',{':uid':uid}):[];
 const delivered=new Map(deliveries.map(r=>[r.job_id,r.state])),groups=plans.length?groupJobs(await store.jobs()):[];
 const matching=new Set(),fresh=new Set(),pending=new Set(),sent=new Set(),uncertain=new Set();
 for(const plan of plans)for(const j of visibleJobs(groups,plan.filters,now)) {
  const id=Math.min(...j._duplicate_ids);matching.add(id);
  if(plan.after_id===null||!j._duplicate_ids.every(i=>i>plan.after_id))continue;
  fresh.add(id);
  const states=j._duplicate_ids.map(i=>delivered.get(i)).filter(Boolean);
  if(!states.length)pending.add(id);
  else if(states.includes('sent'))sent.add(id);
  else if(states.some(s=>s==='sending'||s==='uncertain'))uncertain.add(id);
 }
 const cooldown=await store.meta('notification_cooldown');
 return {current_enabled:plans.some(p=>p.id==='main'),saved_enabled:savedSearches(user?.settings).filter(p=>p.notifications==='instant').length,
  uninitialized_plans:plans.filter(p=>p.after_id===null).length,matching:matching.size,new_since_enabled:fresh.size,
  pending:pending.size,already_sent:sent.size,unconfirmed:uncertain.size,
  bot_active:Boolean(await store.meta('active')),blocked:Boolean(user?.settings?.bot_blocked),
  banned:await store.isBanned(uid),cooldown_seconds:Math.max(0,Math.ceil(((Number(cooldown)||0)-now)/1000)),
  last_successful_collection:await successfulCollection(store),last_notification:user?.last_notified_at||null};
}
