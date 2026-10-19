import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,callback,message } from './fixtures.js';
import { administer } from '../tgcloud/lib/admin.js';
import { Store } from '../tgcloud/lib/store.js';
import { healthTick } from '../tgcloud/lib/health.js';
import { adTick } from '../tgcloud/lib/ads.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { freshness,successfulCollection } from '../tgcloud/lib/analytics.js';

test('atomic persistent quotas under parallel calls and a new Store instance',async()=>{
 const f=await fixture(),now=Date.now();
 const results=await Promise.all(Array.from({length:30},()=>f.store.rate('1:search',10,60,now)));
 assert.equal(results.filter(x=>x===0).length,10);
 assert.equal(await new Store(f.db).rate('1:search',10,60,now+1000),59);
 assert.equal(await f.store.rate('2:search',10,60,now),0);
 assert.equal(await f.store.rate('1:search',10,60,now+60000),0);
});
test('search translation and report limits return an actionable wait',async()=>{
 const f=await fixture();
 for(const [kind,action,limit] of [['search','search:0',40],['translate','job:1:ru_full',10],['report','report:1:not_job',5]]) {
  for(let i=0;i<limit;i++) await f.store.rate(`1:${kind}`,limit,60);
  await handle(f,callback(1,action));
  assert.match(f.api.edited.at(-1).text,/Повторите через \d+ сек/);
 }
});
async function start(f){
 await handle(f,callback(OWNER_ID,'ads:new'));await handle(f,message(OWNER_ID,'Проверка'));
 const {id}=await f.store.meta('ad_draft');
 await handle(f,callback(OWNER_ID,'ads:confirm:'+id));await handle(f,callback(OWNER_ID,'ads:start:'+id));return id;
}
test('daily campaign quota, audit, forged owner callbacks, emergency stop and replay',async()=>{
 const f=await fixture();await f.store.setMeta('ad_daily_limit',1);
 for(let i=1;i<=15;i++)await f.store.ensure(i,i);
 const id=await start(f);
 const forged=callback(1,'ads:emergency');forged.callback_query.message.chat.id=OWNER_ID;
 await handle(f,forged);assert.equal(await f.store.meta('ad_emergency'),null);
 await handle(f,callback(OWNER_ID,'ads:emergency'));const count=f.api.sent.length;
 await Promise.all([adTick(f.store,f.api),adTick(f.store,f.api)]);
 assert.equal(f.api.sent.length,count);
 await start(f);assert.equal((await f.store.records('ad_campaign')).length,1);
 assert.equal((await f.store.records('ad_launch')).length,1);
 const actions=(await f.store.records('ad_audit')).map(x=>x.action);
 for(const action of ['create','confirm','start','emergency_stop'])assert(actions.includes(action));
 assert.equal(await f.store.meta('ad_stop:'+id),true);
});
test('health transitions suppress duplicates across concurrent checks and restart, then recover',async()=>{
 const f=await fixture(),now=Date.now();
 await f.store.setMeta('last_successful_collection',new Date(now-7300000).toISOString());
 await Promise.all([healthTick(f.store,f.api,now),healthTick(f.store,f.api,now)]);
 await healthTick(new Store(f.db),f.api,now+1000);
 assert.equal(f.api.sent.length,1);
 await f.store.setMeta('last_successful_collection',new Date(now).toISOString());
 await healthTick(f.store,f.api,now+2000);await healthTick(f.store,f.api,now+3000);
 assert.equal(f.api.sent.length,2);assert.match(f.api.sent[1].text,/Восстановление/);
 for(let i=1;i<=5;i++)await f.db.run("INSERT INTO sjc_deliveries(user_id,job_id,state,payload) VALUES(1,:id,'uncertain',:payload)",{':id':i,':payload':JSON.stringify({delivered_at:new Date(now).toISOString()})});
 await healthTick(f.store,f.api,now+4000);await healthTick(f.store,f.api,now+5000);
 assert.equal(f.api.sent.length,3);
 await healthTick(f.store,f.api,now+7200001);
 assert(f.api.sent.some(x=>/Восстановление: доставка уведомлений/.test(x.text)));
});
test('ambiguous owner warning is not retried',async()=>{
 const f=await fixture();let calls=0;f.api.sendMessage=async()=>{calls++;throw Error('timeout');};
 await healthTick(f.store,f.api);await healthTick(f.store,f.api);
 assert.equal(calls,1);
});
test('emergency stop during an in-flight ad stops the next recipient and all campaigns',async()=>{
 const f=await fixture();for(let i=1;i<=15;i++)await f.store.ensure(i,i);
 const send=f.api.sendMessage;let triggered=false;
 f.api.sendMessage=async p=>{
   if(p.chat_id===1 && p.text?.startsWith('📣')) {
     triggered=true;await handle(f,callback(OWNER_ID,'ads:emergency'));
   }
   return send(p);
 };
 const id=await start(f);assert(triggered);
 assert.equal(f.api.sent.filter(p=>p.text?.startsWith('📣')&&p.chat_id!==OWNER_ID).length,1);
 assert.equal((await f.store.records('ad_campaign')).find(c=>c.id===id).state,'stopped');
 const n=f.api.sent.length;await adTick(f.store,f.api);assert.equal(f.api.sent.length,n);
});
test('health retries only explicit 429 responses without duplicate warnings',async()=>{
 const f=await fixture(),now=Date.now();const send=f.api.sendMessage;let limited=true;
 f.api.sendMessage=async p=>{if(limited)throw {code:429,parameters:{retry_after:10}};return send(p);};
 await healthTick(f.store,f.api,now);limited=false;
 await healthTick(f.store,f.api,now+9000);assert.equal(f.api.sent.length,0);
 await healthTick(f.store,f.api,now+11000);await healthTick(f.store,f.api,now+12000);
 assert.equal(f.api.sent.length,1);
});
test('emergency during campaign creation also cancels the launch before its first send',async()=>{
 const f=await fixture();await f.store.ensure(1,1);
 await handle(f,callback(OWNER_ID,'ads:new'));await handle(f,message(OWNER_ID,'Пост'));
 const {id}=await f.store.meta('ad_draft');await handle(f,callback(OWNER_ID,'ads:confirm:'+id));
 const run=f.db.run;let stopped=false;
 f.db.run=async(sql,params)=>{
  const result=await run(sql,params);
  if(!stopped && sql.includes('entries(kind,record_key,payload)') && sql.includes("'ad_campaign'")) {
   stopped=true;await handle(f,callback(OWNER_ID,'ads:emergency'));
  }
  return result;
 };
 const n=f.api.sent.filter(p=>p.text?.startsWith('📣')).length;
 await handle(f,callback(OWNER_ID,'ads:start:'+id));
 assert(stopped);assert.equal(f.api.sent.filter(p=>p.text?.startsWith('📣')).length,n);
 assert.equal((await f.store.records('ad_campaign'))[0].state,'stopped');
});

test('only a completed collection with a healthy source advances the success heartbeat',async()=>{
 const f=await fixture();let run=0;
 for(const [failed,healthy] of [[true,1],[false,0],[false,1]]) {
  const owner='00000000-0000-0000-0000-'+String(++run).padStart(12,'0');
  await administer({operation:'collection_begin',owner},{ownerRun:true},f);
  await administer({operation:'collection_end',owner,failed,totals:{sources:1,healthy_sources:healthy}},{ownerRun:true},f);
  assert.equal(Boolean(await f.store.meta('last_successful_collection')),!failed && healthy>0);
 }
});
test('parallel live advertising workers claim each recipient once',async()=>{
 const f=await fixture();for(let i=1;i<=15;i++)await f.store.ensure(i,i);
 const id=await start(f),campaign=(await f.store.records('ad_campaign'))[0];
 await f.store.record('ad_campaign',id,{...campaign,retry_at:0});
 let entered,release;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const send=f.api.sendMessage;
 f.api.sendMessage=async p=>{if(p.chat_id===6){entered();await gate;}return send(p);};
 const first=adTick(f.store,f.api);await waiting;
 assert.equal((await adTick(f.store,f.api)).busy,true);
 release();await first;
 for(let i=0;i<5;i++) {
  const c=(await f.store.records('ad_campaign'))[0];
  await f.store.record('ad_campaign',id,{...c,retry_at:0});
  if((await adTick(f.store,f.api)).done)break;
 }
 const messages=f.api.sent.filter(p=>p.text?.startsWith('📣') && p.chat_id!==OWNER_ID);
 assert.equal(messages.length,15);assert.equal(new Set(messages.map(p=>p.chat_id)).size,15);
});

test('health and user freshness reject an explicit zero healthy-source count but accept legacy success records',async()=>{
 const now=Date.now();
 for(const [healthy,failed,expected] of [[0,false,false],[1,false,true],[undefined,false,true],[1,true,false]]){
  const f=await fixture(),totals={sources:14};if(healthy!==undefined)totals.healthy_sources=healthy;
  await f.store.setMeta('last_collection',{finished_at:new Date(now).toISOString(),failed,totals});
  assert.equal(Boolean(await successfulCollection(f.store)),expected);
  assert.equal((await freshness(f.store,now))==='',expected);
  await healthTick(f.store,f.api,now);assert.equal(f.api.sent.some(p=>p.text.includes('Нет успешного сбора')),!expected);
  await f.store.setMeta('last_successful_collection',new Date(now-3*3600000).toISOString());
  assert.match(await freshness(f.store,now),/3 ч назад/);
 }
});
