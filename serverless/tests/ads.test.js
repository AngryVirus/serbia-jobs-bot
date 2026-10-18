import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,message,callback } from './fixtures.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { adTick } from '../tgcloud/lib/ads.js';
import { administer } from '../tgcloud/lib/admin.js';

async function draft(f,photo=false) {
  await handle(f,callback(OWNER_ID,'ads:new'));
  const update=message(OWNER_ID,'Тестовый пост');
  if(photo) {delete update.message.text;Object.assign(update.message,{photo:[{file_id:'small'},{file_id:'large'}],caption:'Фото 📷',caption_entities:[{type:'bold',offset:0,length:4}],forward_origin:{type:'channel'}});}
  else update.message.entities=[{type:'bold',offset:0,length:8}];
  await handle(f,update);
  return (await f.store.meta('ad_draft')).id;
}
async function campaign(f) {const id=await f.store.meta('ad_current');return (await f.store.records('ad_campaign')).find(c=>c.id===id);}
async function ready(f,id) {await handle(f,callback(OWNER_ID,'ads:confirm:'+id));await handle(f,callback(OWNER_ID,'ads:start:'+id));}
async function tick(f) {const c=await campaign(f);await f.store.record('ad_campaign',c.id,{...c,retry_at:0});return adTick(f.store,f.api);}

test('advertising drafts, previews, owner-only confirmation, photo entities and optional link',async()=>{
  const f=await fixture();f.api.sendPhoto=async p=>{f.api.sent.push(p);return {message_id:999};};
  await handle(f,callback(1,'ads:new'));assert.equal(await f.store.meta('ad_draft'),null);
  const old=await draft(f,true);
  const photo=f.api.sent.findLast(p=>p.photo);
  assert.equal(photo.photo,'large');
  assert.equal(photo.caption_entities[0].offset,'📣 Реклама\n\n'.length);
  assert.equal((await f.store.records('ad_campaign')).length,0);
  await handle(f,callback(OWNER_ID,'ads:link:'+old));await handle(f,message(OWNER_ID,'Подробнее | https://example.com/offer'));
  const next=(await f.store.meta('ad_draft')).id;assert.notEqual(old,next);
  await handle(f,callback(OWNER_ID,'ads:start:'+old));assert.equal(await f.store.meta('ad_current'),null);
  await handle(f,callback(1,'ads:start:'+next));assert.equal(await f.store.meta('ad_current'),null);
  await handle(f,callback(OWNER_ID,'ads:start:'+next));assert.equal(await f.store.meta('ad_current'),null);
  await ready(f,next);assert.equal((await campaign(f)).state,'done');
  assert(f.api.sent.some(p=>p.photo==='large'&&p.reply_markup?.inline_keyboard[0][0].url==='https://example.com/offer'));
  assert(f.api.sent.filter(p=>p.photo).every(p=>!JSON.stringify(p.reply_markup||{}).includes('ads:off')));
  const count=f.api.sent.length;await handle(f,callback(OWNER_ID,'ads:start:'+next));await tick(f);assert.equal(f.api.sent.length,count);
});

test('snapshot excludes opt-outs, opt-out before delivery and deleted/recreated users are skipped',async()=>{
  const f=await fixture();for(let id=1;id<=12;id++) await f.store.ensure(id,id);
  await f.store.patch(2,{ads_enabled:false,notifications:'instant'});
  const id=await draft(f);await ready(f,id);
  assert.equal((await campaign(f)).total,12); // 11 users plus the owner
  assert.equal((await f.store.user(2)).settings.notifications,'instant');
  await handle(f,callback(10,'ads:off'));await f.store.deleteUser(11);await f.store.ensure(11,11);
  await f.store.ensure(13,13); // Joined after the recipient snapshot.
  while(!(await tick(f)).done) {}
  const deliveries=await f.store.records('ad_delivery');
  assert.equal(deliveries.filter(r=>r.state==='sent').length,10);
  assert.equal(deliveries.filter(r=>r.state==='skipped').length,1);
  assert(!f.api.sent.some(p=>[2,10,11,13].includes(p.chat_id)&&p.text?.startsWith('📣 Реклама')));
});

test('429 retries the same recipient; blocked and ambiguous deliveries do not repeat',async()=>{
  const f=await fixture();await f.store.ensure(1,1);await f.store.ensure(2,2);await f.store.ensure(3,3);
  const id=await draft(f);const send=f.api.sendMessage;let limited=true;
  f.api.sendMessage=async p=>{if(p.chat_id===1&&limited)throw {code:429,parameters:{retry_after:10}};if(p.chat_id===2)throw {code:403,description:'Forbidden: bot was blocked by the user'};if(p.chat_id===3)throw new Error('Timeout');return send(p);};
  await ready(f,id);assert.equal((await campaign(f)).cursor,0);
  assert.equal((await f.store.records('ad_delivery')).length,0);
  limited=false;await tick(f);
  const states=(await f.store.records('ad_delivery')).map(r=>r.state).sort();
  assert.deepEqual(states,['blocked','sent','sent','uncertain']);
  assert.equal((await f.store.user(2)).settings.bot_blocked,true);
  assert.equal((await f.store.user(2)).delivery_status,'blocked');
  assert.equal((await f.store.user(2)).ever_confirmed_blocked,1);
  const count=f.api.sent.length;await tick(f);assert.equal(f.api.sent.length,count);
});

test('stop, concurrent workers, campaign replay and deleted data cannot restart a campaign',async()=>{
  const f=await fixture();for(let id=1;id<=15;id++)await f.store.ensure(id,id);
  const id=await draft(f);await ready(f,id);const before=f.api.sent.length;
  await handle(f,callback(1,'ads:stop:'+id));assert.equal(await f.store.meta('ad_stop:'+id),null);
  await handle(f,callback(OWNER_ID,'ads:stop:'+id));
  await Promise.all([adTick(f.store,f.api),adTick(f.store,f.api)]);
  assert.equal(f.api.sent.length,before);assert.equal((await campaign(f)).state,'stopped');
  await ready(f,id);assert.equal(f.api.sent.length,before);
  await f.store.deleteUser(1);
  assert.equal(await f.db.get("SELECT payload FROM sjc_records WHERE kind='ad_delivery' AND record_key=:key",{':key':id+':1'}),undefined);
});

test('unconfirmed sending claims are never resent after a worker interruption; API requires owner context',async()=>{
  const f=await fixture();for(let id=1;id<=8;id++)await f.store.ensure(id,id);
  const id=await draft(f);await ready(f,id);
  await f.store.record('ad_delivery',id+':6',{state:'sending'});
  await tick(f);assert(!f.api.sent.some(p=>p.chat_id===6));
  await assert.rejects(administer({operation:'ads_tick'},{initData:'fake'},f),/Owner CLI/);
});

test('campaign creation rolls quota, audience and audit back together and retries the same update safely',async()=>{
 for(const fail of ['ad_audit','ad_control','ad_target','ad_campaign']){
  const f=await fixture();await f.store.ensure(77,77);const id=await draft(f);
  await handle(f,callback(OWNER_ID,'ads:confirm:'+id));
  await f.db.run(`CREATE TRIGGER fail_launch BEFORE INSERT ON sjc_records WHEN NEW.kind='${fail}' ${fail==='ad_audit'?"AND json_extract(NEW.payload,'$.action')='start'":''} BEGIN SELECT RAISE(ABORT,'simulated launch failure'); END`);
  const start=callback(OWNER_ID,'ads:start:'+id);
  await assert.rejects(handle(f,start),/simulated launch failure/);
  for(const kind of ['ad_launch','ad_target','ad_campaign','ad_control'])assert.equal((await f.store.records(kind)).length,0);
  assert.equal((await f.store.records('ad_audit')).filter(r=>r.action==='start').length,0);
  assert(!f.api.sent.some(p=>p.chat_id===77));
  await f.db.run('DROP TRIGGER fail_launch');await handle(f,start);
  assert.equal((await f.store.records('ad_launch')).length,1);assert.equal((await f.store.records('ad_campaign')).length,1);
  assert.equal((await f.store.records('ad_audit')).filter(r=>r.action==='start').length,1);
  await handle(f,callback(OWNER_ID,'ads:start:'+id));await adTick(f.store,f.api);
  assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);
 }
});

test('launch resumes an older orphan reservation and snapshot without another quota charge',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const id=await draft(f);
 await handle(f,callback(OWNER_ID,'ads:confirm:'+id));await f.store.setMeta('ad_daily_limit',1);
 await f.store.record('ad_launch',id,{day:'2000-01-01'});
 await f.store.record('ad_target',id+':'+String(77).padStart(20,'0'),{uid:77,created_at:(await f.store.user(77)).created_at});
 await f.store.record('ad_launch','another',{day:new Date().toISOString().slice(0,10)});
 await f.store.ensure(88,88);await handle(f,callback(OWNER_ID,'ads:start:'+id));
 assert.equal((await campaign(f)).total,1);assert.equal((await f.store.records('ad_launch')).length,2);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);assert.equal(f.api.sent.filter(p=>p.chat_id===88).length,0);
});

test('a crash before the compatibility pointer cache leaves a campaign that the background worker resumes once',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const id=await draft(f);
 await handle(f,callback(OWNER_ID,'ads:confirm:'+id));
 const run=f.db.run;let fail=true;
 f.db.run=async(sql,params)=>{if(fail&&sql.includes('INSERT INTO sjc_meta')&&params?.[':key']==='ad_current'){fail=false;throw Error('lost before current pointer');}return run(sql,params);};
 await assert.rejects(handle(f,callback(OWNER_ID,'ads:start:'+id)),/lost before current pointer/);
 assert.equal((await f.store.records('ad_campaign')).length,1);assert.equal(await f.store.meta('ad_current'),null);
 assert(!f.api.sent.some(p=>p.chat_id===77));
 await adTick(f.store,f.api);await handle(f,callback(OWNER_ID,'ads:start:'+id));await adTick(f.store,f.api);
 assert.equal(await f.store.meta('ad_current'),id);assert.equal((await f.store.records('ad_launch')).length,1);
 assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,1);
});
