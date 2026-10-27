import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job,handle,callback} from './fixtures.js';
import {notifyOne} from '../tgcloud/lib/admin.js';
import {Store} from '../tgcloud/lib/store.js';
import {snapshotFilters} from '../tgcloud/lib/searches.js';
const keys=f=>f.api.edited.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.callback_data).filter(Boolean);
async function setup(){const f=await fixture();await f.store.ensure(1,1);await f.store.patch(1,{notifications:'instant',notifications_after_id:0});for(let i=1;i<=4;i++)await f.store.putJob(job(i),true);return f;}
test('one digest covers every matching vacancy; parallel workers and restart do not repeat it',async()=>{
 const f=await setup(),results=await Promise.all([notifyOne(f.store,f.api,1),notifyOne(new Store(f.db),f.api,1)]);
 assert.equal(results.reduce((n,r)=>n+r.sent,0),1);assert.equal(f.api.sent.length,1);assert.match(f.api.sent[0].text,/Найдены новые вакансии: 4/);
 assert.deepEqual(f.api.sent[0].reply_markup.inline_keyboard.flat().map(b=>b.text),['🔎 Посмотреть','🔕 Отключить уведомления']);
 assert.equal((await f.db.all("SELECT * FROM sjc_deliveries WHERE state='sent'")).length,4);
 assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,0);
});
test('digest opens its own selection across saved searches, preserves current filters and isolates users',async()=>{
 const f=await setup();await f.store.patch(1,{keywords:['водитель'],notifications:'off',saved_searches:[{id:'cook',name:'Кухня',filters:snapshotFilters({keywords:['повар']}),notifications:'instant',notifications_after_id:0}]});
 await notifyOne(f.store,f.api,1);const action=f.api.sent[0].reply_markup.inline_keyboard[0][0].callback_data;
 await handle(f,callback(2,action));assert.match(f.api.edited.at(-1).text,/устарела/);
 await handle(f,callback(1,action));assert.match(f.api.edited.at(-1).text,/Вакансия 1 из 4/);assert.match(f.api.edited.at(-1).text,/из уведомления/);
 const next=keys(f).find(s=>s.includes(':next:'));await f.store.putJob(job(5),true);
 await handle(f,callback(1,next));assert.match(f.api.edited.at(-1).text,/Вакансия 2 из 4/);
 assert.deepEqual((await f.store.user(1)).settings.keywords,['водитель']);
 await f.store.record('moderation','2',{blocked:true,ids:[2]});await f.store.patch(1,{hidden_jobs:[3]});
 await handle(f,callback(1,action));assert.match(f.api.edited.at(-1).text,/Вакансия 1 из 2/);
 await handle(f,callback(1,'notify:stop'));assert.equal((await f.store.user(1)).settings.notifications,'off');assert.equal((await f.store.user(1)).settings.saved_searches[0].notifications,'off');
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
});
test('digest failure claims are all-or-nothing; 429 retries, ambiguous outcomes never resend',async()=>{
 for(const code of [429,403,0]){
  const f=await setup();let calls=0;f.api.sendMessage=async()=>{calls++;throw {code,parameters:{retry_after:5}};};
  await notifyOne(f.store,f.api,1);let rows=await f.db.all('SELECT state FROM sjc_deliveries');
  if(code===429){assert.equal(rows.length,0);await f.store.setMeta('notification_cooldown',0);f.api.sendMessage=async()=>{calls++;return {message_id:10};};assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,1);}
  else {assert.equal(rows.length,4);assert(rows.every(r=>r.state===(code===403?'blocked':'uncertain')));}
  assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,0);assert.equal(calls,code===429?2:1);
 }
});
test('a lost lease or interrupted sender cannot duplicate a claimed digest',async()=>{
 const f=await setup();f.api.sendMessage=async()=>{throw Error('connection lost');};
 await notifyOne(f.store,f.api,1);await f.db.run("UPDATE sjc_deliveries SET state='sending'");
 let sends=0;f.api.sendMessage=async()=>{sends++;return {message_id:9};};await notifyOne(new Store(f.db),f.api,1);assert.equal(sends,0);
 const other=await setup();await notifyOne(other.store,other.api,1,async()=>{const {groupJobs}=await import('../tgcloud/lib/catalog.js');await other.db.run("UPDATE sjc_locks SET owner='replacement' WHERE key='user:1'");return groupJobs(await other.store.jobs());});assert.equal(other.api.sent.length,0);
});
test('new sources are throttled for an hour across restarts without losing unsent vacancies',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await setup();await notifyOne(f.store,f.api,1);
 await f.store.putJob(job(5),true);assert.equal((await notifyOne(new Store(f.db),f.api,1)).deferred,true);
 assert.equal((await f.db.all('SELECT job_id FROM sjc_deliveries WHERE job_id=5')).length,0);
 t.mock.timers.tick(3599999);assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,0);
 t.mock.timers.tick(1);assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,1);assert.match(f.api.sent.at(-1).text,/вакансии: 1/);
});
test('delivery health counts digest messages rather than every vacancy in a failed digest',async()=>{
 const {healthTick}=await import('../tgcloud/lib/health.js'),f=await setup(),at=new Date().toISOString();
 await f.store.setMeta('last_successful_collection',at);
 for(let id=1;id<=8;id++)await f.db.run("INSERT INTO sjc_deliveries VALUES(1,:id,'uncertain',:payload)",{':id':id,':payload':JSON.stringify({digest:'same',delivered_at:at})});
 await healthTick(f.store,f.api);assert.equal(f.api.sent.length,0);
 for(let uid=2;uid<=5;uid++)await f.db.run("INSERT INTO sjc_deliveries VALUES(:uid,1,'uncertain',:payload)",{':uid':uid,':payload':JSON.stringify({digest:'same',delivered_at:at})});
 await healthTick(f.store,f.api);assert.equal(f.api.sent.length,1);assert.match(f.api.sent[0].text,/ошибок доставки уведомлений/);
 await healthTick(new Store(f.db),f.api);assert.equal(f.api.sent.length,1);
});
