import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job,handle,callback} from './fixtures.js';
import {availabilityAllows,AVAILABILITY_AGE} from '../tgcloud/lib/availability.js';
import {availabilityTarget,groupJobs,visibleJobs} from '../tgcloud/lib/catalog.js';
import {defaults} from '../tgcloud/lib/filters.js';
import {administer,notifyOne} from '../tgcloud/lib/admin.js';
import {Store} from '../tgcloud/lib/store.js';
const owner='00000000-0000-0000-0000-000000000001',ctx={ownerRun:true};let n=1;
const probe=()=>`00000000-0000-0000-0000-${String(++n).padStart(12,'0')}`;
const run=(f,operation,fields={})=>administer({operation,owner,...fields},ctx,f);
async function apply(f,results,extra={}){
 results=await Promise.all(results.map(async r=>({...r,key:availabilityTarget(await f.store.job(r.id)).key})));
 const batch=await run(f,'availability_due');
 const input={operation:'availability_apply',owner,probe:probe(),after:batch.after,cursor:batch.cursor,started_at:batch.started_at,results,...extra};
 return {input,result:await administer(input,ctx,f)};
}
test('30 days uses confirmed activity then publication then first save; explicit deadlines take precedence',()=>{
 const now=Date.now(),old=now-AVAILABILITY_AGE,j={created_at:new Date(now).toISOString(),_cloud:{published_ms:old}};
 assert.equal(availabilityAllows(j,now),false);assert(availabilityAllows(j,now-1));
 assert(availabilityAllows({...j,_availability:{state:'active',verified_at:now}},now));
 assert.equal(availabilityAllows({...j,_availability:{state:'unknown',verified_at:old}},now),false);
 assert.equal(availabilityAllows({...j,_availability:{state:'closed',verified_at:now}},now),false);
 assert(availabilityAllows({...j,_cloud:{published_ms:old,expires_ms:now+86400000}},now));
 assert.equal(availabilityAllows({_cloud:{},created_at:new Date(old).toISOString()},now),false);
 assert.equal(availabilityAllows({_cloud:{},_availability_baseline:new Date(old).toISOString()},now),false);
 assert(availabilityAllows({...j,_cloud:{expires_ms:now-1},_availability:{state:'active',verified_at:now,expires_ms:null}},now));
 assert.equal(availabilityAllows({...j,_availability:{state:'active',verified_at:now,expires_ms:now-1}},now),false);
});
test('fresh original web parsing confirms activity but a stale listing never reopens a known closure',async()=>{
 const f=await fixture(),j=job(1,{source:'radim',url:'https://radim.rs/jobs/a'});
 await f.store.putJob(j);let saved=await f.store.job(1);assert.equal(saved._availability.state,'active');
 await f.store.record('availability',availabilityTarget(j).key,{state:'closed',checked_at:Date.now()});
 await f.store.putJob(j);assert.equal((await f.store.job(1))._availability.state,'closed');
});
test('publisher-original keys are shared, and original expiry hides a stale Telegram copy',()=>{
 const site=job(1,{source:'radim',url:'https://radim.rs/jobs/a'}),tg=job(2,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/7',description:'Подробнее и откликнуться: https://radim.rs/jobs/a?utm_source=telegram'});
 assert.deepEqual(availabilityTarget(tg),{key:'radim.rs/jobs/a',url:'https://radim.rs/jobs/a',source:'radim'});
 site._cloud.expires_ms=Date.now()-1000;assert.equal(visibleJobs(groupJobs([site,tg]),defaults()).length,0);
});
test('closed originals suppress all copies and a confirmed reopening restores them without recreating jobs or deliveries',async()=>{
 const f=await fixture();await f.store.ensure(77,77);
 const site=job(1,{source:'radim',url:'https://radim.rs/jobs/a'}),tg=job(2,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/7',description:'Подробнее и откликнуться: https://radim.rs/jobs/a'});
 await f.store.putJob(site,true);await f.store.putJob(tg,true);await f.store.patch(77,{notifications:'instant',notifications_after_id:0});
 await f.db.run("INSERT INTO sjc_deliveries VALUES(77,1,'sent','{}')");
 await run(f,'collection_begin');const first=await run(f,'availability_due');assert.equal(first.candidates.length,1);assert.equal(first.candidates[0].source,'radim');
 await apply(f,[{id:1,state:'closed',reason:'publisher_notice'}]);assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
 await f.store.putJob(tg);assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
 await apply(f,[{id:1,state:'active',reason:'parsed'}]);assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);
 const stats=await f.store.stats();assert.equal(stats.jobs,2);assert.equal(stats.deliveries,1);
 await notifyOne(f.store,f.api,77);assert.equal(f.api.sent.filter(p=>p.chat_id===77).length,0);
});
test('404 requires two spaced probes; retries, network errors and a worker restart do not invent closure',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-21T12:00:00Z')});
 const f=await fixture();await f.store.putJob(job(1,{source:'radim',url:'https://radim.rs/jobs/a'}),true);await run(f,'collection_begin');
 const first=await apply(f,[{id:1,state:'missing',reason:'not_found'}]);
 assert.notEqual((await f.store.job(1))._availability.state,'closed');
 assert.equal((await administer(first.input,ctx,f)).replayed,true);
 const restarted=new Store(f.db);assert.notEqual((await restarted.job(1))._availability.state,'closed');
 await apply(f,[{id:1,state:'unknown',reason:'unavailable'}]);assert.notEqual((await f.store.job(1))._availability.state,'closed');
 t.mock.timers.tick(6*3600000);await f.store.lock('collection',owner,900);
 await apply(f,[{id:1,state:'missing',reason:'not_found'}]);assert.equal((await f.store.job(1))._availability.state,'closed');
});
test('unknown responses retain the last successful check and automatic return never resets the original publication date',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-21T12:00:00Z')});
 const f=await fixture(),old=Date.now()-31*86400000,j=job(1,{source:'radim',url:'https://radim.rs/jobs/a',published_at:new Date(old).toISOString(),created_at:new Date().toISOString()});j._cloud.published_ms=old;
 await f.store.putJob(j,true);await run(f,'collection_begin');assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
 await apply(f,[{id:1,state:'active',reason:'parsed'}]);const stamp=(await f.store.job(1))._availability.verified_at;
 assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);
 t.mock.timers.tick(1000);await apply(f,[{id:1,state:'unknown',reason:'unavailable'}]);assert.equal((await f.store.job(1))._availability.verified_at,stamp);
 assert.equal((await f.store.job(1))._cloud.published_ms,old);
});
test('the bounded numeric queue persists and advances past sparse IDs even when every page has no due requests',async()=>{
 const f=await fixture();for(let i=1;i<=27;i++)await f.store.putJob(job(i*3,{source:'radim',url:'https://radim.rs/jobs/'+i}),true);await run(f,'collection_begin');
 const visited=[];
 for(let page=0;page<3;page++){
  const batch=await run(f,'availability_due');assert(batch.candidates.length<=12);visited.push(...batch.candidates.map(c=>c.id));
  await run(f,'availability_apply',{...batch,probe:probe(),results:batch.candidates.map(c=>({id:c.id,key:c.key,state:'unknown',reason:'unrecognized'}))});
 }
 assert.deepEqual(visited,Array.from({length:27},(_,i)=>(i+1)*3));assert.equal(await new Store(f.db).meta('availability_cursor'),0);
 const next=await run(f,'availability_due');assert.equal(next.candidates.length,0);
 await run(f,'availability_apply',{...next,probe:probe(),results:[]});assert.equal(await f.store.meta('availability_cursor'),36);
});
test('stale owners and out-of-page results cannot mutate availability or advance the cursor',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await run(f,'collection_begin');const batch=await run(f,'availability_due');
 const input={...batch,owner,probe:probe(),results:[{id:1,key:availabilityTarget(await f.store.job(1)).key,state:'closed',reason:'gone'}]};
 await f.store.unlock('collection',owner);await f.store.lock('collection','another',900);
 await assert.rejects(f.store.applyAvailability(input),/owner changed/);assert.equal(await f.store.meta('availability_cursor'),null);assert.equal((await f.store.records('availability')).length,0);
 await assert.rejects(run(f,'availability_apply',{...input,results:[{id:99,state:'closed',reason:'gone'}]}));
});
test('public forged callbacks and non-owner CLI contexts cannot request or submit availability probes',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);
 for(const op of ['availability_due','availability_apply']){
  await assert.rejects(administer({operation:op,owner},{ownerRun:false},f),/Owner CLI context/);
  await handle(f,callback(1,'admin:'+op));
 }
 assert.equal((await f.store.records('availability')).length,0);
});
