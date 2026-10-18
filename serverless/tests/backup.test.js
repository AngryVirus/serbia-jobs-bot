import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,job } from './fixtures.js';
import { backupOperation,backupAdmin } from '../tgcloud/lib/backup.js';
const id='00000000-0000-0000-0000-000000000123';

test('resuming an immutable generation preserves its counts and records after live changes',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.putJob(job(1),true);
 const first=await backupOperation(f.store,{operation:'backup_create',id,resume:true});
 await f.store.ensure(2,2);await f.store.putJob(job(2),true);
 assert.deepEqual(await backupOperation(f.store,{operation:'backup_create',id,resume:true}),first);
 await assert.rejects(backupOperation(f.store,{operation:'backup_create',id}),/already exists/);
 const page=await backupOperation(f.store,{operation:'backup_page',id,table:'sjc_users',after:null});
 assert.deepEqual(page.rows.map(r=>r.id),[1]);assert.equal(typeof page.next,'string');
 await backupOperation(f.store,{operation:'backup_release',id});
 await assert.rejects(backupOperation(f.store,{operation:'backup_page',id,table:'sjc_users',after:null}),/expired or missing/);
});

test('keyset pages are bounded by bytes and rows without losing Unicode records',async()=>{
 const f=await fixture();
 for(let i=1;i<=205;i++)await f.store.putJob({...job(i),description:'Юникод 🙂 '.repeat(i<=40?1000:1)},true);
 const manifest=await backupOperation(f.store,{operation:'backup_create',id,resume:true});assert.equal(manifest.counts.sjc_jobs,205);
 const values=[];let cursor=null,pages=0;
 while(values.length<205){
  const page=await backupOperation(f.store,{operation:'backup_page',id,table:'sjc_jobs',after:cursor});
  assert(page.rows.length>0&&page.rows.length<=200);
  assert(Buffer.byteLength(JSON.stringify(page))<102400+4096);
  assert.notEqual(page.next,cursor);cursor=page.next;values.push(...page.rows);pages++;
 }
 assert.equal(new Set(values.map(r=>r.id)).size,205);assert(pages<11,'fewer requests than the former 20-row pages');
 const last=await backupOperation(f.store,{operation:'backup_page',id,table:'sjc_jobs',after:cursor});assert.equal(last.rows.length,0);
});

test('a single oversized row fails explicitly instead of violating the response budget or looping',async()=>{
 const f=await fixture();await f.store.record('synthetic','large',{text:'x'.repeat(250000)});
 await backupOperation(f.store,{operation:'backup_create',id,resume:true});
 await assert.rejects(backupOperation(f.store,{operation:'backup_page',id,table:'sjc_records',after:null}),/safe response limit/);
});

test('small backup entrypoint keeps owner authentication and target bot checks',async()=>{
 const f=await fixture();
 for(const ctx of [{},{ownerRun:true,update:{}},{ownerRun:true,initData:'forged'}])await assert.rejects(backupAdmin({operation:'backup_create',id},ctx,f),/Owner CLI/);
 f.api.getMe=async()=>({is_bot:true,id:1,username:'SerbiaJobsBot'});
 await assert.rejects(backupAdmin({operation:'backup_create',id},{ownerRun:true},f),/Wrong bot/);
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sjc_backup_rows'")).n,0);
});
