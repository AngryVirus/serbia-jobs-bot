import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,callback,job } from './fixtures.js';
import { backupOperation } from '../tgcloud/lib/backup.js';
import { usage,activity,freshness,sourceHistory,qualitySummary } from '../tgcloud/lib/analytics.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { administer } from '../tgcloud/lib/admin.js';
const snapshot='00000000-0000-0000-0000-000000000001';

test('immutable atomic snapshot includes every durable queue and state but no leases',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.putJob(job(10),true);
 await f.store.record('ad_delivery','c:1',{state:'sending'});await f.store.record('moderation','10',{ids:[10],blocked:true});
 await f.store.finishUpdate('u:1');await f.store.claimUpdate('u:2');await f.store.lock('user:1','worker');
 const manifest=await backupOperation(f.store,{operation:'backup_create',id:snapshot});
 assert.equal(manifest.counts.sjc_jobs,1);assert.equal(manifest.counts.sjc_users,1);assert(!('sjc_locks' in manifest.counts));
 await f.store.patch(1,{keywords:['changed after snapshot']});await f.store.putJob(job(11),true);
 const users=await backupOperation(f.store,{operation:'backup_page',id:snapshot,table:'sjc_users',offset:0});
 assert.deepEqual(JSON.parse(users.rows[0].payload).settings.keywords,[]);
 const jobs=await backupOperation(f.store,{operation:'backup_page',id:snapshot,table:'sjc_jobs',offset:0});assert.equal(jobs.rows.length,1);
 await assert.rejects(backupOperation(f.store,{operation:'backup_create',id:snapshot}));
 const records=await backupOperation(f.store,{operation:'backup_page',id:snapshot,table:'sjc_records',offset:0});
 assert(records.rows.some(r=>r.kind==='ad_delivery' && JSON.parse(r.payload).state==='sending'));
 await assert.rejects(administer({operation:'backup_create',id:snapshot},{initData:'forged'},f),/Owner CLI/);
 await assert.rejects(backupOperation(f.store,{operation:'backup_page',id:snapshot,table:'sjc_users; DROP TABLE sjc_users',offset:0}));
 await backupOperation(f.store,{operation:'backup_release',id:snapshot});
 assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sjc_backup_rows')).n,0);
});
test('atomic anonymous metrics, coarse activity, retention and no query text',async()=>{
 const f=await fixture(),now=Date.now();await f.store.ensure(1,1);await f.store.ensure(2,2);
 await Promise.all(Array.from({length:30},()=>usage(f.store,'searches',now)));
 await Promise.all([activity(f.store,1,now),activity(f.store,1,now),activity(f.store,2,now)]);
 const values=await f.store.records('usage');assert.deepEqual(values,[{searches:30}]);
 assert.equal((await f.store.user(1)).last_seen_day,new Date(now).toISOString().slice(0,10));
 await f.store.record('usage','2000-01-01',{searches:1});await sourceHistory(f.store,'run',new Date(now).toISOString(),now);
 assert.equal((await f.store.records('usage')).length,1);
});
test('freshness appears on search only when stale and clears after collection',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);
 await handle(f,callback(1,'search:0'));assert.match(f.api.edited.at(-1).text,/Свежесть базы пока не подтверждена/);
 await f.store.setMeta('last_successful_collection',new Date(Date.now()-3*3600000).toISOString());
 await handle(f,callback(1,'search:0'));assert.match(f.api.edited.at(-1).text,/3 ч назад/);
 await f.store.setMeta('last_successful_collection',new Date().toISOString());
 assert.equal(await freshness(f.store),'');await handle(f,callback(1,'search:0'));assert(!f.api.edited.at(-1).text.includes('Последний успешный сбор'));
 const totals=(await f.store.records('usage'))[0];assert.equal(totals.searches,3);assert.equal(totals.empty,undefined);
 await f.store.patch(1,{keywords:['no match']});await handle(f,callback(1,'search:0'));
 assert.equal((await f.store.records('usage'))[0].empty,1);
});
test('source history is idempotent per run and tracks repeated failures and recovery',async()=>{
 const f=await fixture(),now=Date.now(),start=new Date(now-1000).toISOString();
 await f.store.sourceStatus('radim',{state:'error',checked_at:new Date(now).toISOString()});
 await sourceHistory(f.store,'a',start,now);await sourceHistory(f.store,'a',start,now);
 let h=(await f.store.records('source_health'))[0];assert.equal(h.checks,1);assert.equal(h.streak,1);
 await sourceHistory(f.store,'b',start,now);h=(await f.store.records('source_health'))[0];assert.equal(h.streak,2);
 await f.store.sourceStatus('radim',{state:'ok',checked_at:new Date(now).toISOString()});
 await sourceHistory(f.store,'c',start,now);h=(await f.store.records('source_health'))[0];assert.equal(h.checks,3);assert.equal(h.streak,0);assert.equal(h.failures,2);
});
test('quality counts expired and undated records, and flags candidates without merging',async()=>{
 const description='Нужен повар в ресторан. '.repeat(8);
 const jobs=[job(1,{company:'A',description}),job(2,{company:'A',description:description+' Другая смена.'}),job(3,{_cloud:{...job(3)._cloud,expires_ms:Date.now()-1}})];
 const q=qualitySummary(jobs);assert.equal(q.expired,1);assert.equal(q.undated,3);assert.equal(q.candidates.length,1);assert.equal(q.groups,3);
});
test('new panels reject forged owner identity and contain no individual usage details',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);
 for(const action of ['admin:stats','admin:stats:delivery','admin:stats:usage','admin:quality','admin:quality:sources:0','admin:quality:duplicates:0']) {
  const u=callback(1,action);u.callback_query.message.chat.id=OWNER_ID;await handle(f,u);
  assert.match(f.api.edited.at(-1).text,/только владельцу/);
  await handle(f,callback(OWNER_ID,action));assert(!f.api.edited.at(-1).text.includes('только владельцу'));
 }
 const result=await administer({operation:'operations_check'},{ownerRun:true},f);assert.equal(result.panels,7);
});
test('missing backups alert independently after 36 hours and recover without repeat spam',async()=>{
 const {healthTick}=await import('../tgcloud/lib/health.js');
 const f=await fixture(),now=Date.now();
 await f.store.setMeta('last_successful_collection',new Date(now).toISOString());
 await f.store.setMeta('backup_monitor_since',new Date(now-37*3600000).toISOString());
 await healthTick(f.store,f.api,now);await healthTick(f.store,f.api,now+1000);
 assert.equal(f.api.sent.length,1);assert.match(f.api.sent[0].text,/резервной копии/);
 await f.store.setMeta('last_backup',{verified_at:new Date(now).toISOString()});
 await healthTick(f.store,f.api,now+2000);await healthTick(f.store,f.api,now+3000);
 assert.equal(f.api.sent.length,2);assert.match(f.api.sent[1].text,/резервное копирование/);
});
