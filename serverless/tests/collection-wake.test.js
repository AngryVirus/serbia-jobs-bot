import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,callback,handle,job} from './fixtures.js';
import {Store} from '../tgcloud/lib/store.js';
import {configureWake,requestCollectionWake,wakeStatus,wakeMessage} from '../tgcloud/lib/collection-wake.js';
import {administer} from '../tgcloud/lib/admin.js';
import {ownerRoute,OWNER_ID} from '../tgcloud/lib/owner.js';
const credential='x'.repeat(80),now=Date.now();
async function enabled(){const f=await fixture();await configureWake(f.store,{enabled:true,credential});return f;}

test('wake is disabled by default; pause and fresh catalogue never call GitHub',async()=>{
 const f=await fixture();let calls=0;const fetch=async()=>{calls++;return {status:204};};
 assert.equal((await requestCollectionWake(f.store,fetch)).status,'disabled');
 await configureWake(f.store,{enabled:true,credential});await f.store.setMeta('active',false);
 assert.equal((await requestCollectionWake(f.store,fetch)).status,'paused');
 await f.store.setMeta('active',true);await f.store.setMeta('last_successful_collection',new Date(now-20*60000).toISOString());
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'fresh');
 assert.equal((await requestCollectionWake(f.store,fetch,{now,manual:true})).status,'fresh');assert.equal(calls,0);
});
test('concurrent searches and owner clicks share one durable wake claim',async()=>{
 const f=await enabled();let calls=0;
 const fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.github.com/repos/AngryVirus/serbia-jobs-bot/actions/workflows/catch-up.yml/dispatches');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{ref:'main'});assert.equal(options.headers.Authorization,'Bearer '+credential);return {status:204};};
 const results=await Promise.all(Array.from({length:12},(_,i)=>requestCollectionWake(new Store(f.db),fetch,{now,manual:i%2===0})));
 assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='requested').length,1);
 assert.equal((await requestCollectionWake(new Store(f.db),fetch,{now:now+1000})).status,'waiting');
 assert(!JSON.stringify(await wakeStatus(f.store)).includes(credential));
});
test('a running collection prevents wake, but an expired lease permits recovery',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;return {status:204};};
 await f.store.setMeta('collection_run',{state:'running',owner:'worker'});await f.store.lock('collection','worker',120);
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'running');
 await f.db.run("UPDATE sjc_locks SET expires=0 WHERE key='collection'");
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'requested');assert.equal(calls,1);
});
test('ambiguous POST and restart do not immediately dispatch again or expose details',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;throw new Error(credential);};
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'unconfirmed');
 assert.equal((await requestCollectionWake(new Store(f.db),fetch,{now:now+1000})).status,'waiting');assert.equal(calls,1);
 assert(!JSON.stringify(await wakeStatus(f.store)).includes(credential));assert(!wakeMessage({status:'unconfirmed'}).includes(credential));
});
test('rolling daily budget bounds requests even when catalogue stays stale',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;return {status:204};};
 for(let i=0;i<12;i++)assert.equal((await requestCollectionWake(f.store,fetch,{now:now+i*901000})).status,'requested');
 assert.equal((await requestCollectionWake(f.store,fetch,{now:now+12*901000})).status,'daily_limit');assert.equal(calls,12);
});
test('a new daily window cannot reset eleven recent attempts from the previous day',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;return {status:204};};
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'requested');
 for(let i=0;i<11;i++)assert.equal((await requestCollectionWake(f.store,fetch,{now:now+20*3600000+i*901000})).status,'requested');
 assert.equal((await requestCollectionWake(new Store(f.db),fetch,{now:now+86401000})).status,'requested');
 assert.equal((await requestCollectionWake(new Store(f.db),fetch,{now:now+86401000+901000})).status,'daily_limit');
 assert.equal(calls,13);
});
test('GitHub retry-after persists beyond the ordinary cooldown',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;return {status:429,headers:{get:name=>name==='retry-after'?'3600':null}};};
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'limited');
 const retry=await requestCollectionWake(new Store(f.db),fetch,{now:now+901000});assert.equal(retry.status,'waiting');assert(retry.wait>2000);assert.equal(calls,1);
});
test('late dispatch result cannot overwrite a disabled configuration state',async()=>{
 const f=await enabled();let start,finish;const started=new Promise(r=>start=r),response=new Promise(r=>finish=r);
 const pending=requestCollectionWake(f.store,async()=>{start();return response;},{now});await started;
 await configureWake(f.store,{enabled:false});finish({status:401});await pending;
 assert.deepEqual(await wakeStatus(f.store),{enabled:false,state:null,requested_at:null});
});
test('denied access stops further requests until explicit configuration; response bodies are private',async()=>{
 const f=await enabled();let calls=0;const fetch=async()=>{calls++;return {status:403,json(){throw Error('Do not read');},text(){throw Error('Do not read');}};};
 assert.equal((await requestCollectionWake(f.store,fetch,{now})).status,'denied');
 assert.equal((await requestCollectionWake(f.store,fetch,{now:now+901000})).status,'denied');assert.equal(calls,1);
 await configureWake(f.store,{enabled:false});assert.deepEqual(await f.store.meta('collection_wake_config'),{enabled:false});
 assert.equal((await requestCollectionWake(f.store,fetch,{now:now+1802000})).status,'disabled');
});
test('public callback and forged owner context cannot configure or manually trigger wake',async()=>{
 const f=await enabled();let calls=0;f.fetch=async()=>{calls++;return {status:204};};
 for(const ctx of [{},{ownerRun:true,update:{}},{ownerRun:true,initData:'forged'}])await assert.rejects(administer({operation:'collection_wake_configure',enabled:false},ctx,f),/Owner CLI/);
 const panels=[];await ownerRoute({uid:1,chat:OWNER_ID,store:f.store,fetch:f.fetch,panel:async(...p)=>panels.push(p)},'admin:collection:wake');
 await ownerRoute({uid:OWNER_ID,chat:1,store:f.store,fetch:f.fetch,panel:async()=>{}},'admin:collection:wake');assert.equal(calls,0);
 await handle(f,callback(1,'admin:collection:wake'));assert.equal(calls,0);
 await handle(f,callback(OWNER_ID,'admin:collection:wake'));assert.equal(calls,1);assert.match(f.api.edited.at(-1).text,/ещё не подтверждение/);
});
test('stale search requests wake without exposing it or adding buttons to user menu',async()=>{
 const f=await enabled();await f.store.putJob(job(1),true);let calls=0;f.fetch=async()=>{assert(f.api.edited.length>0,'Search must be displayed before GitHub request');calls++;return {status:204};};
 await handle(f,callback(1,'search:0'));assert.equal(calls,1);assert.match(f.api.edited.at(-1).text,/Вакансия/);
 await handle(f,callback(1,'menu'));assert.equal(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().length,5);
 assert(!JSON.stringify(f.api).includes(credential));
});
test('configuration returns a boolean only and requires explicit enable choice',async()=>{
 const f=await fixture();assert.deepEqual(await administer({operation:'collection_wake_configure',enabled:true,credential},{ownerRun:true},f),{enabled:true});
 await assert.rejects(configureWake(f.store,{credential}),/Invalid wake configuration/);
 await assert.rejects(configureWake(f.store,{enabled:true,credential:'short'}),/Invalid wake credential/);
});
