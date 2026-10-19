import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job,callback,handle} from './fixtures.js';
import {administer} from '../tgcloud/lib/admin.js';
import {collectionMetrics,sourceHealthy,sourceHistory} from '../tgcloud/lib/analytics.js';
import {OWNER_ID} from '../tgcloud/lib/owner.js';
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source='radim',cli=(f,operation,fields={})=>administer({operation,owner,...fields},{ownerRun:true},f);
const checkpoint=(extra={})=>({version:1,updated_at:Math.floor(Date.now()/1000),cursor:'https://radim.rs/poslovi?page=2',pending:['https://radim.rs/poslovi/one'],seen:{['a'.repeat(64)]:Math.floor(Date.now()/1000)},...extra});
const vacancy=id=>job(id,{source,url:`https://radim.rs/poslovi/${id}`});

test('crawl state is source-specific and omitted from owner-facing source status',async()=>{
 const f=await fixture();await cli(f,'collection_begin');
 assert.deepEqual(await cli(f,'collection_state',{source}),{state:{}});
 await cli(f,'collect',{source,jobs:[vacancy(1)]});
 assert.deepEqual(await cli(f,'collection_state',{source}),{state:{}});
 const rootCursor=checkpoint({cursor:'https://www.poslovi.rs/'});
 await cli(f,'collect',{source:'poslovi',jobs:[],status:{state:'ok',crawl_state:rootCursor}});
 assert.deepEqual((await cli(f,'collection_state',{source:'poslovi'})).state,rootCursor);
 const state=checkpoint();
 await cli(f,'collect',{source,jobs:[],status:{state:'ok',discovered:24,inspected:8,parsed_count:7,crawl_state:state}});
 assert.deepEqual(await cli(f,'collection_state',{source}),{state});
 assert.deepEqual(await cli(f,'collection_state',{source:'infostud'}),{state:{}});
 const visible=(await f.store.records('source_status')).find(s=>s.source===source).payload;
 assert.equal(visible.crawl_state,undefined);assert.equal(visible.inspected,8);
 assert(!JSON.stringify(visible).includes('radim.rs'));
 await assert.rejects(administer({operation:'collection_state',owner,source},{ownerRun:true,update:{}},f),/Owner CLI/);
 await assert.rejects(cli(f,'collection_state',{source:'not_a_source'}),/Invalid collection source/);
});

test('checkpoint advances only after the final upload commits and survives failed batch retry',async()=>{
 const f=await fixture();await cli(f,'collection_begin');const before=checkpoint({cursor:null});
 await cli(f,'collect',{source,jobs:[],status:{state:'partial',crawl_state:before}});
 await f.db.run("CREATE TRIGGER interrupt_job BEFORE INSERT ON sjc_jobs WHEN json_extract(NEW.payload,'$.title')='fail' BEGIN SELECT RAISE(ABORT,'interrupted upload'); END");
 const next=checkpoint(),jobs=[vacancy(1),{...vacancy(2),title:'fail'}];
 await assert.rejects(cli(f,'collect',{source,jobs,status:{state:'ok',crawl_state:next}}),/interrupted upload/);
 assert.equal((await f.store.stats()).jobs,1);
 assert.deepEqual((await cli(f,'collection_state',{source})).state,before);
 assert.equal((await f.store.records('source_status')).find(s=>s.source===source).payload.state,'partial');
 await f.db.run('DROP TRIGGER interrupt_job');
 assert.equal((await cli(f,'collect',{source,jobs,status:{state:'ok',crawl_state:next}})).added,1);
 assert.deepEqual((await cli(f,'collection_state',{source})).state,next);assert.equal((await f.store.stats()).jobs,2);
});

test('checkpoint validation rejects secrets, nonpublic URLs, malformed hashes and oversized state before writes',async()=>{
 const f=await fixture();await cli(f,'collection_begin');
 const bad=[checkpoint({password:'private'}),checkpoint({cursor:'http://radim.rs/jobs'}),checkpoint({cursor:'https://u:p@radim.rs/jobs'}),checkpoint({cursor:'https://127.0.0.1/jobs'}),checkpoint({cursor:'https://radim.rs/jobs#private'}),checkpoint({cursor:'https://radim.rs/jobs?api_key=private'}),checkpoint({cursor:'https://radim.rs/jobs%0Aprivate'}),checkpoint({pending:Array(49).fill('https://radim.rs/jobs')}),checkpoint({seen:{email:1}}),checkpoint({updated_at:Math.floor(Date.now()/1000)+3600}),checkpoint({seen:Object.fromEntries(Array.from({length:1000},(_,i)=>[i.toString(16).padStart(64,'0'),Math.floor(Date.now()/1000)])),pending:Array.from({length:48},(_,i)=>`https://radim.rs/${i}${'x'.repeat(900)}`)})];
 for(const state of bad)await assert.rejects(cli(f,'collect',{source,jobs:[vacancy(1)],status:{state:'ok',crawl_state:state}}),/Invalid crawl checkpoint/);
 assert.equal((await f.store.stats()).jobs,0);assert.deepEqual((await cli(f,'collection_state',{source})).state,{});
});

test('corrupt and incompatible durable states restart their source without exposing raw payloads',async()=>{
 const f=await fixture();await cli(f,'collection_begin');
 for(const raw of ['{corrupt',JSON.stringify({version:9,secret:'private'}),JSON.stringify(checkpoint({seen:Object.fromEntries(Array.from({length:1001},(_,i)=>[i.toString(16).padStart(64,'0'),1]))}))]){
  await f.db.run("INSERT INTO sjc_records(kind,record_key,payload) VALUES('collection_crawl',:source,:payload) ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload",{':source':source,':payload':raw});
  assert.deepEqual(await cli(f,'collection_state',{source}),{state:{}});
 }
});

test('active run and matching lease prevent stale workers from writing after takeover or completion',async()=>{
 const f=await fixture();await assert.rejects(cli(f,'collect',{source,jobs:[]}),/owner mismatch|not active/);
 await cli(f,'collection_begin');await f.db.run("UPDATE sjc_locks SET expires=0 WHERE key='collection'");
 await cli(f,'collection_begin',{owner:other});
 for(const operation of ['collection_state','collect','collection_end'])await assert.rejects(cli(f,operation,{source,jobs:[vacancy(1)]}),/owner mismatch|not active/);
 assert.equal((await f.store.stats()).jobs,0);
 await cli(f,'collection_end',{owner:other,totals:{sources:1,healthy_sources:1}});
 await assert.rejects(cli(f,'collect',{owner:other,source,jobs:[vacancy(1)]}),/owner mismatch|not active/);
 assert.equal(await f.db.get("SELECT 1 AS n FROM sjc_locks WHERE key='collection'"),undefined);
});

test('concurrent starts select one owner; repeated start and completion preserve baselines, totals and history',async()=>{
 const f=await fixture(),results=await Promise.allSettled([cli(f,'collection_begin'),cli(f,'collection_begin',{owner:other})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const run=await f.store.meta('collection_run'),fields={owner:run.owner};
 await cli(f,'collect',{...fields,source,jobs:[vacancy(1)],status:{state:'ok',checked_at:new Date().toISOString()}});
 await cli(f,'collection_begin',fields);assert.deepEqual(await f.store.meta('collection_run'),run);
 await cli(f,'collection_end',{...fields,totals:{sources:1,healthy_sources:1,added:1}});
 const completed=await f.store.meta('last_collection'),successful=await f.store.meta('last_successful_collection'),history=await f.store.records('source_health');
 await cli(f,'collection_end',{...fields,failed:true,totals:{sources:0,healthy_sources:0,added:99}});
 assert.deepEqual(await f.store.meta('last_collection'),completed);assert.equal(await f.store.meta('last_successful_collection'),successful);assert.deepEqual(await f.store.records('source_health'),history);
 await assert.rejects(cli(f,'collection_begin',fields),/already completed/);
 assert.equal(await f.db.get("SELECT 1 AS n FROM sjc_locks WHERE key='collection'"),undefined);
});

test('collection due catches missed schedules using successful collection and only live leases',async()=>{
 const f=await fixture();assert.deepEqual(await cli(f,'collection_due'),{active:true,due:true,last_successful_collection:null,running:false});
 await cli(f,'collection_begin');assert.equal((await cli(f,'collection_due')).due,false);
 await f.db.run("UPDATE sjc_locks SET expires=0 WHERE key='collection'");assert.equal((await cli(f,'collection_due')).due,true);
 await cli(f,'collection_end',{totals:{sources:1,healthy_sources:0}});assert.equal((await cli(f,'collection_due')).due,true);
 await f.store.setMeta('last_successful_collection',new Date(Date.now()-29*60000).toISOString());assert.equal((await cli(f,'collection_due')).due,false);
 const stale=new Date(Date.now()-31*60000).toISOString();await f.store.setMeta('last_successful_collection',stale);assert.equal((await cli(f,'collection_due')).due,true);
 await f.store.setMeta('active',false);assert.deepEqual(await cli(f,'collection_due'),{active:false,due:false,last_successful_collection:stale,running:false});
});

test('owner diagnostics distinguish discovered, parsed and unfinished work without exposing checkpoints',async()=>{
 const f=await fixture(),status={state:'partial',detail:'Есть следующая страница',checked_at:new Date().toISOString(),discovered:96,inspected:24,parsed_count:20,rejected:{not_job:3,parse_error:1},skipped_known:12,backlog:36,truncated:true,listing_pages:2,crawl_state:checkpoint()};
 await cli(f,'collection_begin');await cli(f,'collect',{source,jobs:[],status});
 for(const action of ['admin:sources:0','admin:quality:sources:0']){
  const forged=callback(1,action);forged.callback_query.message.chat.id=OWNER_ID;const before=f.api.edited.length;await handle(f,forged);assert.equal(f.api.edited.length,before);
  const group=callback(OWNER_ID,action);group.callback_query.message.chat={id:-1,type:'group'};await handle(f,group);assert.equal(f.api.edited.length,before);
 }
 // Both diagnostic pages keep four detailed sources within Telegram limits.
 const {ownerReport}=await import('../tgcloud/lib/owner.js');const report=await ownerReport(f.store);
 const issue=report.issues.findIndex(s=>s.id===source),sourceIndex=report.sources.findIndex(s=>s.id===source);
 for(const action of [`admin:sources:${Math.floor(issue/4)}`,`admin:quality:sources:${Math.floor(sourceIndex/4)}`]){
  await handle(f,callback(OWNER_ID,action));const text=f.api.edited.at(-1).text;
  assert.match(text,/Обнаружено: 96 · проверено: 24 · разобрано: 20/);assert.match(text,/не вакансия 3/);assert.match(text,/В очереди: 36 · обход продолжится/);assert(!text.includes('crawl_state'));assert(!text.includes('radim.rs/poslovi'));
 }
 assert.equal(collectionMetrics({detail:'private',rejected:{private_email:'private'}}),'');
 assert.match(collectionMetrics({discovered:3,rejected:{foreign:1,unrecognized:1,missing:1}}),/другая страна 1 · не распознано 1 · недостаточно данных 1/);
});


test('parallel retries using one owner cannot restart or finalize the same run twice',async()=>{
 const f=await fixture();await cli(f,'collection_begin');
 await cli(f,'collect',{source,jobs:[vacancy(1)],status:{state:'ok',checked_at:new Date().toISOString()}});
 const run=await f.store.meta('collection_run'),raw=f.db.run;
 let entered,release,paused=false;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 f.db.run=async(sql,params)=>{
  const result=await raw(sql,params);
  if(!paused&&sql.includes('INSERT INTO sjc_locks')&&params?.[':key']==='collection_rpc'){paused=true;entered();await gate;}
  return result;
 };
 const first=cli(f,'collection_end',{totals:{sources:1,healthy_sources:1,added:1}});await waiting;
 await assert.rejects(cli(f,'collection_begin'),/operation in progress/);
 await assert.rejects(cli(f,'collection_end',{failed:true,totals:{added:99}}),/operation in progress/);
 assert.deepEqual(await f.store.meta('collection_run'),run);
 release();await first;
 const final=await f.store.meta('last_collection');assert.equal(final.failed,false);assert.equal(final.totals.added,1);
 assert.equal((await f.store.records('source_health'))[0].checks,1);
 assert.equal(await f.db.get("SELECT 1 AS n FROM sjc_locks WHERE key='collection_rpc'"),undefined);
});

test('completion retry releases its lease after interruption following durable finalization',async()=>{
 const f=await fixture();await cli(f,'collection_begin');const raw=f.db.run;let interrupted=false;
 f.db.run=async(sql,params)=>{
  if(!interrupted&&sql.startsWith('DELETE FROM sjc_locks')&&params?.[':key']==='collection'){interrupted=true;throw Error('interrupted release');}
  return raw(sql,params);
 };
 await assert.rejects(cli(f,'collection_end',{totals:{sources:1,healthy_sources:1}}),/interrupted release/);
 const final=await f.store.meta('last_collection'),heartbeat=await f.store.meta('last_successful_collection');
 assert(await f.db.get("SELECT 1 AS n FROM sjc_locks WHERE key='collection'"));
 await cli(f,'collection_end',{failed:true,totals:{sources:99}});
 assert.deepEqual(await f.store.meta('last_collection'),final);assert.equal(await f.store.meta('last_successful_collection'),heartbeat);
 assert.equal(await f.db.get("SELECT 1 AS n FROM sjc_locks WHERE key='collection'"),undefined);
});

test('checkpoint write itself is fenced against a delayed call after lease takeover',async()=>{
 const f=await fixture();await cli(f,'collection_begin');const before=checkpoint({cursor:null});
 await cli(f,'collect',{source,jobs:[],status:{state:'partial',crawl_state:before}});
 const raw=f.db.run;let taken=false;
 f.db.run=async(sql,params)=>{
  if(!taken&&sql.includes("SELECT 'collection_crawl',:source,:payload")){
   taken=true;
   await raw("UPDATE sjc_locks SET owner=:owner WHERE key='collection'",{':owner':other});
   await raw("UPDATE sjc_meta SET payload=json_set(payload,'$.owner',:owner) WHERE key='collection_run'",{':owner':other});
  }
  return raw(sql,params);
 };
 await assert.rejects(cli(f,'collect',{source,jobs:[],status:{state:'ok',crawl_state:checkpoint()}}),/owner mismatch|not active/);
 assert.equal(taken,true);
 assert.deepEqual((await cli(f,'collection_state',{owner:other,source})).state,before);
});

test('detailed source diagnostics remain bounded when every source reports maximum counters',async()=>{
 const f=await fixture(),{SOURCE_NAMES}=await import('../tgcloud/lib/config.js');
 const {sourceEnabled}=await import('../tgcloud/lib/source-policy.js'),ids=Object.keys(SOURCE_NAMES).filter(sourceEnabled);
 const counters={discovered:1000000000,inspected:1000000000,parsed_count:1000000000,skipped_known:1000000000,backlog:1000000000,listing_pages:1000000000};
 for(const id of ids)await f.store.sourceStatus(id,{state:'partial',detail:'A'.repeat(150),checked_at:new Date().toISOString(),...counters,rejected:Object.fromEntries(Array.from({length:4},(_,i)=>['x'.repeat(39)+String.fromCharCode(97+i),1000000000])),truncated:true});
 for(let page=0;page<Math.ceil(ids.length/4);page++)for(const route of ['admin:sources:','admin:quality:sources:']){
  await handle(f,callback(OWNER_ID,route+page));const text=f.api.edited.at(-1).text;
  assert(text.length<4096,`${route}${page} exceeds text fallback limit`);
 }
});


test('bounded healthy partial coverage is distinct from partial errors and blocked sources',async()=>{
 const f=await fixture(),at=new Date().toISOString();
 const states=[['radim',{state:'partial',healthy:true,truncated:true,backlog:12}],['poslovi',{state:'partial',healthy:false,truncated:true,backlog:12}],['workforce',{state:'blocked',healthy:true,truncated:true}]];
 for(const [id,status] of states)await f.store.sourceStatus(id,{...status,checked_at:at});
 await sourceHistory(f.store,'run-1',at);
 const {ownerReport}=await import('../tgcloud/lib/owner.js'),report=await ownerReport(f.store);
 assert(!report.issues.some(s=>s.id==='radim'));
 assert(report.issues.some(s=>s.id==='poslovi'));assert(report.issues.some(s=>s.id==='workforce'));
 assert.match(report.text,/Продолжают обход каталога: 1/);
 const history=await f.db.all("SELECT record_key,payload FROM sjc_records WHERE kind='source_health'");
 const bySource=Object.fromEntries(history.map(r=>[r.record_key,JSON.parse(r.payload)]));
 assert.equal(bySource.radim.failures,0);assert.equal(bySource.radim.streak,0);
 assert.equal(bySource.poslovi.failures,1);assert.equal(bySource.workforce.failures,1);
 await f.store.sourceStatus('poslovi',{state:'partial',healthy:true,truncated:true,checked_at:at});
 await sourceHistory(f.store,'run-2',at);
 const recovered=JSON.parse((await f.db.get("SELECT payload FROM sjc_records WHERE kind='source_health' AND record_key='poslovi'")).payload);
 assert.equal(recovered.checks,2);assert.equal(recovered.failures,1);assert.equal(recovered.streak,0);
 for(const status of [{state:'partial',truncated:true},{state:'partial',healthy:false},{state:'partial',healthy:'true'},{state:'blocked',healthy:true},{state:'error',healthy:true},{state:'ok',healthy:false}])assert.equal(sourceHealthy(status),false);
 for(const status of [{state:'ok'},{state:'empty'},{state:'partial',healthy:true}])assert.equal(sourceHealthy(status),true);
});
