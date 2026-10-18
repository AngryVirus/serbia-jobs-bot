import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,callback,message,job} from './fixtures.js';
import {Store} from '../tgcloud/lib/store.js';
import {defaults,settings} from '../tgcloud/lib/filters.js';

const failPanel=f=>{const send=f.api.editMessageText;f.api.editMessageText=async()=>{throw {code:429,parameters:{retry_after:1}};};return ()=>{f.api.editMessageText=send;};};

test('mutating callbacks apply once when panel delivery fails and the same update is retried',async()=>{
 const cases=[
  ['toggle_salary',null,s=>assert.equal(s.include_unknown_salary,false)],
  ['choose:city:belgrade:1',null,s=>assert.deepEqual(s.city,['belgrade'])],
  ['set:remote:office',null,s=>assert.equal(s.remote,'office')],
  ['notify:instant',null,s=>{assert.equal(s.notifications,'instant');assert.equal(s.notifications_after_id,2);}],
  ['reset',{keywords:['old'],city:['nis']},s=>{assert.deepEqual(s.keywords,[]);assert.equal(s.city,'any');}],
  ['hide:1',null,s=>assert.deepEqual(s.hidden_jobs,[1])],
  ['restore:1',{hidden_jobs:[1]},s=>assert.deepEqual(s.hidden_jobs,[])],
  ['view:1:0:hide:s',null,s=>assert.deepEqual(s.hidden_jobs,[1])],
  ['input:keywords',null,s=>assert.equal(s.pending_input,'keywords')],
 ];
 for(const [action,initial,verify] of cases){
  const f=await fixture();await f.store.ensure(77,77);if(initial)await f.store.patch(77,initial);
  await f.store.putJob(job(1),true);await f.store.putJob(job(2,{title:'Other'}),true);
  const u=callback(77,action),restore=failPanel(f);
  await assert.rejects(handle(f,u));const before=(await f.store.user(77)).settings;verify(before);
  const revision=(await f.store.user(77)).input_applied;restore();await handle(f,u);
  const user=await f.store.user(77);verify(user.settings);assert.equal(user.input_applied,revision,action);
  assert.equal((await f.db.get('SELECT state FROM sjc_updates WHERE key=:key',{':key':'u:'+u.update_id})).state,'done');
 }
});

test('state-write acknowledgement loss is safe, and a planned write can resume after failure',async()=>{
 for(const committed of [false,true]){
  const f=await fixture();await f.store.ensure(77,77);const u=callback(77,'toggle_salary'),run=f.db.run;let writes=0,failed=false;
  f.db.run=async(sql,params)=>{
   if(sql.startsWith('UPDATE sjc_users SET payload=:payload') && params?.[':revision'] && !failed){
    failed=true;writes++;if(committed)await run(sql,params);throw Error('lost write acknowledgement');
   }
   if(sql.startsWith('UPDATE sjc_users SET payload=:payload') && params?.[':revision'])writes++;
   return run(sql,params);
  };
  await assert.rejects(handle(f,u),/lost write/);
  assert.equal((await f.store.user(77)).settings.include_unknown_salary,!committed);
  await handle(f,u);assert.equal((await f.store.user(77)).settings.include_unknown_salary,false);
  assert.equal(writes,committed?1:2);
 }
});

test('an old retry neither overwrites a newer preference nor replaces its newer panel',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const old=callback(77,'toggle_salary'),restore=failPanel(f);
 await assert.rejects(handle(f,old));restore();await handle(f,callback(77,'reset'));
 const count=f.api.edited.length;await handle(f,old);
 assert.equal((await f.store.user(77)).settings.include_unknown_salary,true);assert.equal(f.api.edited.length,count);
});

test('parallel retries share the user lease and a committed effect is never repeated',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const u=callback(77,'toggle_salary');
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),send=f.api.editMessageText;
 f.api.editMessageText=async p=>{entered();await gate;return send(p);};
 const first=handle(f,u);await started;await assert.rejects(handle(f,u),/busy/);release();await first;await handle(f,u);
 assert.equal((await f.store.user(77)).settings.include_unknown_salary,false);assert.equal(f.api.edited.length,1);
});

test('accepted text input survives reply failure and retries without storing private input in receipts',async()=>{
 const f=await fixture();await f.store.ensure(77,77);await f.store.patch(77,{pending_input:'keywords'});
 const u=message(77,'личный запрос'),send=f.api.sendMessage;f.api.sendMessage=async()=>{throw Error('network');};
 await assert.rejects(handle(f,u));assert.deepEqual((await f.store.user(77)).settings.keywords,['личный запрос']);
 f.api.sendMessage=send;await handle(f,u);assert.deepEqual((await f.store.user(77)).settings.keywords,['личный запрос']);
 assert(!JSON.stringify(await f.store.records('input_effect')).includes('личный запрос'));
});

test('deletion retries keep profiles deleted and cannot erase a later registration',async()=>{
 for(const registerAgain of [false,true]){
  const f=await fixture();await f.store.ensure(77,77);const u=callback(77,'delete_confirm'),send=f.api.sendMessage;
  f.api.sendMessage=async()=>{throw Error('network');};await assert.rejects(handle(f,u));assert.equal(await f.store.user(77),null);
  f.api.sendMessage=send;
  if(registerAgain){await handle(f,message(77,'/start'));await f.store.patch(77,{keywords:['new profile']});}
  await handle(f,u);const user=await f.store.user(77);
  if(registerAgain)assert.deepEqual(user.settings.keywords,['new profile']);else assert.equal(user,null);
 }
});

test('search, translation and both report quotas survive profile deletion until their own expiry',async()=>{
 const f=await fixture();await f.store.ensure(77,77);const now=Date.now();
 for(const [kind,limit,seconds] of [['search',40,60],['translate',10,60],['report',5,60],['report_daily',20,86400]]){
  for(let i=0;i<limit;i++)assert.equal(await f.store.rate(`77:${kind}`,limit,seconds,now),0);
 }
 await handle(f,callback(77,'delete_confirm'));await handle(f,message(77,'/start'));
 for(const [kind,limit,seconds] of [['search',40,60],['translate',10,60],['report',5,60],['report_daily',20,86400]]){
  assert((await new Store(f.db).rate(`77:${kind}`,limit,seconds,now+1000))>0);
  assert.equal(await f.store.rate(`77:${kind}`,limit,seconds,now+seconds*1000),0);
 }
});

test('mismatched private actor/chat pairs are rejected before profile changes or output',async()=>{
 const f=await fixture();await f.store.ensure(77,77);await f.store.patch(77,{keywords:['private']});const before=await f.store.user(77);
 const c=callback(77,'filters');c.callback_query.message.chat.id=88;
 const m=message(77,'/start');m.message.chat.id=88;
 await handle(f,c);await handle(f,m);
 assert.deepEqual(await f.store.user(77),before);assert.equal(await f.store.user(88),null);assert.equal(f.api.sent.length+f.api.edited.length,0);
 await assert.rejects(f.store.ensure(77,88),/must match/);
});

test('existing databases gain expiry indexes and housekeeping deletes bounded expired batches',async()=>{
 const f=await fixture(),now=Date.now();
 for(let i=0;i<225;i++){
  await f.db.run("INSERT INTO sjc_updates(key,state,expires) VALUES(:key,'done',:expires)",{':key':'expired:'+i,':expires':now-1});
  await f.store.record('rate','expired:'+i,{n:1,end:now-1});await f.store.record('input_effect','expired:'+i,{expires:now-1});
 }
 await f.store.record('rate','active',{n:1,end:now+10000});await f.store.record('input_effect','active',{expires:now+10000});
 await new Store(f.db).init();await f.store.pruneTransient(now);
 assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sjc_updates')).n,125);
 for(const kind of ['rate','input_effect'])assert.equal((await f.store.records(kind)).length,126);
 await f.store.pruneTransient(now);await f.store.pruneTransient(now);
 assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sjc_updates')).n,0);
 for(const kind of ['rate','input_effect'])assert.equal((await f.store.records(kind)).length,1);
 const plan=await f.db.all('EXPLAIN QUERY PLAN SELECT key FROM sjc_updates WHERE expires<=:now ORDER BY expires LIMIT 100',{':now':now});
 assert(plan.some(r=>r.detail.includes('sjc_updates_expires')));
});

test('obsolete defaults are omitted while legacy user filters and notification baseline survive normalization',async()=>{
 for(const field of ['sources','daily_hour','webhook_update_ids'])assert(!Object.hasOwn(defaults(),field));
 const legacy={sources:['disabled'],daily_hour:3,webhook_update_ids:[42],city:['belgrade'],keywords:['chef'],hidden_jobs:[9],notifications:'daily',notifications_after_id:7,ads_enabled:false};
 const normalized=settings(legacy);for(const field of ['sources','daily_hour','webhook_update_ids'])assert(!Object.hasOwn(normalized,field));
 for(const field of ['city','keywords','hidden_jobs','notifications','notifications_after_id','ads_enabled'])assert.deepEqual(normalized[field],legacy[field]);
 const f=await fixture();await f.store.ensure(77,77);const user=await f.store.user(77);user.settings=legacy;await f.store.saveUser(user);
 await f.store.patch(77,{remote:'only'});const saved=(await f.store.user(77)).settings;
 assert.equal(saved.remote,'only');assert.equal(saved.notifications_after_id,7);assert(!Object.hasOwn(saved,'sources'));
});
