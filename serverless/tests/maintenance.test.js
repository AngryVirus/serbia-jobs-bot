import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job} from './fixtures.js';
import {Store} from '../tgcloud/lib/store.js';
import {notifyBatch,administer} from '../tgcloud/lib/admin.js';
const cli=(f,operation,fields={})=>administer({operation,...fields},{ownerRun:true},f);
const owner='11111111-1111-4111-8111-111111111111',version='a'.repeat(64);
async function subscribers(f,count){for(let id=1;id<=count;id++){await f.store.ensure(id,id);await f.store.patch(id,{notifications:'instant',notifications_after_id:0});}}

test('notification cursor survives restarted batches and a small worker budget without starving the tail',async()=>{
 const f=await fixture();await subscribers(f,6);await f.store.putJob(job(1),true);
 await notifyBatch(f.store,f.api,2);assert.deepEqual(f.api.sent.map(p=>p.chat_id),[1,2]);
 await notifyBatch(new Store(f.db),f.api,2);await notifyBatch(new Store(f.db),f.api,2);
 assert.deepEqual(f.api.sent.map(p=>p.chat_id),[1,2,3,4,5,6]);
 for(let i=0;i<3;i++)await notifyBatch(f.store,f.api,2);
 assert.equal(f.api.sent.length,6);assert.equal(await f.store.meta('notification_cursor'),0);
});
test('one batch prepares the catalog once, concurrent workers do not duplicate and fresh bans/moderation win',async()=>{
 const f=await fixture();await subscribers(f,3);await f.store.putJob(job(1),true);let scans=0;const jobs=f.store.jobs.bind(f.store);f.store.jobs=async()=>{scans++;return jobs();};
 const send=f.api.sendMessage;f.api.sendMessage=async p=>{if(p.chat_id===1){await f.store.record('user_ban','2',{uid:2,active:true});await f.store.record('moderation','job:1',{blocked:true,ids:[1]});}return send(p);};
 const results=await Promise.all([notifyBatch(f.store,f.api,3),notifyBatch(new Store(f.db),f.api,3)]);
 assert.equal(scans,1);assert.deepEqual(f.api.sent.map(p=>p.chat_id),[1]);assert(results.some(r=>r.busy));
});
test('429 preserves the current cursor, honors cooldown and retries the same recipient without duplication',async()=>{
 const f=await fixture();await subscribers(f,3);await f.store.putJob(job(1),true);const send=f.api.sendMessage;
 f.api.sendMessage=async p=>{if(p.chat_id===2)throw {code:429,parameters:{retry_after:10}};return send(p);};
 const first=await notifyBatch(f.store,f.api,3);assert.equal(first.retry_after,10);assert.equal(await f.store.meta('notification_cursor'),1);
 await f.store.setMeta('notification_cooldown',0);f.api.sendMessage=send;await notifyBatch(new Store(f.db),f.api,3);
 assert.deepEqual(f.api.sent.map(p=>p.chat_id),[1,2,3]);
});
test('collection updates the expiry of known jobs without importing unknown expired archive records',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await cli(f,'collection_begin',{owner});
 const expired=id=>{const j=job(id);j._cloud.expires_ms=Date.now()-1000;return j;};
 const result=await cli(f,'collect',{owner,source:job(1).source,jobs:[expired(1),expired(2)],status:{state:'ok'}});
 assert.equal(result.added,0);assert.equal((await f.store.stats()).jobs,1);assert((await f.store.job(1))._cloud.expires_ms<Date.now());
});
test('facts migration resumes after a partial write and refreshes languages while preserving concurrent source edits',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await f.store.putJob(job(2),true);
 await cli(f,'facts_begin',{owner,version});const page=await cli(f,'facts_page',{owner,version});assert.equal(page.after,0);assert.equal(page.rows.length,2);
 const fresh=page.rows.map(j=>({...j,_cloud:{...j._cloud,languages:['en'],required_languages:['en']}}));
 await f.db.run("CREATE TRIGGER fail_second_fact BEFORE UPDATE ON sjc_jobs WHEN OLD.id=2 BEGIN SELECT RAISE(ABORT,'interrupted'); END");
 await assert.rejects(cli(f,'facts_apply',{owner,version,after:2,rows:fresh}),/interrupted/);
 assert.equal((await f.store.meta('facts_progress')).after,0);assert.deepEqual((await f.store.job(1))._cloud.languages,['en']);
 await f.db.run('DROP TRIGGER fail_second_fact');await f.store.putJob({...job(2),description:'Changed by collector'});
 const applied=await cli(f,'facts_apply',{owner,version,after:2,rows:fresh});assert.equal(applied.skipped,1);
 await cli(f,'facts_finish',{owner,version});assert.equal((await cli(f,'facts_status')).version,version);assert.equal(await f.store.meta('facts_progress'),null);assert.equal((await f.store.job(2)).description,'Changed by collector');
});
