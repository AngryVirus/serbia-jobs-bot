import test from 'node:test';
import { job, fixture, message, callback, handle } from './fixtures.js';
import assert from 'node:assert/strict';
import { administer, notifyOne } from '../tgcloud/lib/admin.js';
import { settings, defaults, matches, contains, belgradeDay } from '../tgcloud/lib/filters.js';
import { card, clip } from '../tgcloud/lib/ui.js';
test('filters: Unicode word boundaries and Belgrade DST calendar', () => {
  assert(contains('Требуется ПОВАР','повар')); assert(!contains('повариха','повар')); assert(contains('Niš','nis')); assert(!contains('business','nis'));
  assert.equal(belgradeDay(Date.parse('2026-03-29T22:30Z')), Math.floor(Date.parse('2026-03-30T00:00Z')/86400000));
  assert.equal(belgradeDay(Date.parse('2026-10-25T22:30Z')), Math.floor(Date.parse('2026-10-25T00:00Z')/86400000));
  assert(matches(job(1), defaults())); assert(!matches(job(1), {...defaults(),residence_permit:'yes'}));
  assert(!matches(job(1), {...defaults(),language:'english'}));
});
test('menu, persisted input, independent users, explicit choices, hidden and old callbacks', async () => {
  const f=await fixture(); await f.store.putJob(job(41),true); await f.store.putJob(job(42),true);
  await handle(f,message(1,'/start')); assert(!f.api.sent.at(-1).text.includes('тестовом режиме'));
  await handle(f,callback(1,'input:keywords')); await handle(f,message(1,'повар, шеф'));
  assert.deepEqual((await f.store.user(1)).settings.keywords,['повар','шеф']);
  await handle(f,callback(1,'choose:city:belgrade:1')); await handle(f,callback(1,'choose:city:belgrade:1'));
  assert.deepEqual((await f.store.user(1)).settings.city,['belgrade']);
  await handle(f,message(2,'/start')); assert.deepEqual((await f.store.user(2)).settings.keywords,[]);
  await handle(f,callback(1,'search:0')); assert(f.api.edited.at(-1).text.includes('1 из 2'));
  await handle(f,callback(1,'view:42:0:hide:s')); assert(f.api.edited.at(-1).text.includes('1 из 1'));
  await handle(f,callback(1,'job:42:full')); assert(f.api.edited.at(-1).text.includes('Вакансия скрыта'));
  await handle(f,callback(1,'restore:42:0')); assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[]);
  await handle(f,callback(1,'sources')); assert(!JSON.stringify(f.api.edited.at(-1).reply_markup).includes('source:'));
});
test('stale viewer anchors do not translate a different job; original map survives translation failure',async()=>{
  const f=await fixture(); await f.store.putJob(job(7,{title:'Chef',description:'We are hiring a chef with experience.'}),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'view:999:0:translate:s'));
  assert(f.api.edited.at(-1).text.includes('Подборка изменилась')); assert(!f.api.edited.at(-1).text.includes('Перевод сейчас'));
  await handle(f,callback(1,'view:7:0:translate:s'));
  assert(f.api.edited.at(-1).text.includes('Перевод сейчас недоступен')); assert(f.api.edited.at(-1).text.includes('maps/search'));
});
test('notifications baseline, filters, deduplication and edit do not resend',async()=>{
  const f=await fixture(); await f.store.putJob(job(5),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'notify:instant'));
  assert.equal((await f.store.user(1)).settings.notifications_after_id,5);
  assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.putJob(job(6)); const first=await notifyOne(f.store,f.api,1); assert.equal(first.sent,1);
  assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.putJob(job(6,{title:'Updated'})); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await f.store.putJob(job(7)); await f.store.patch(1,{hidden_jobs:[7]}); assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
});
test('simultaneous notification claims and ambiguous errors never duplicate',async()=>{
  const f=await fixture(); await f.store.ensure(1,1); await f.store.patch(1,{notifications:'instant'}); await f.store.putJob(job(1),true);
  const results=await Promise.all([notifyOne(f.store,f.api,1),notifyOne(f.store,f.api,1)]);
  assert.equal(results.reduce((n,r)=>n+r.sent,0),1);
  await f.store.putJob(job(2)); f.api.sendMessage=async()=>{throw new Error('timeout after delivery');};
  assert.equal((await notifyOne(f.store,f.api,1)).uncertain,true);
  assert.equal((await notifyOne(f.store,f.api,1)).sent,0); assert.equal((await f.store.stats()).uncertain,1);
});
test('429 is retryable, blocked users are disabled, delete removes private records',async()=>{
  const f=await fixture(); await f.store.ensure(1,1); await f.store.patch(1,{notifications:'instant'}); await f.store.putJob(job(1),true);
  f.api.sendMessage=async()=>{throw {code:429,parameters:{retry_after:7}};};
  assert.equal((await notifyOne(f.store,f.api,1)).retry_after,7); assert.equal((await f.store.stats()).deliveries,0);
  await f.store.setMeta('notification_cooldown',0);
  f.api.sendMessage=async()=>{throw {code:403};}; await notifyOne(f.store,f.api,1); assert.equal((await f.store.user(1)).settings.notifications,'off');
  await f.store.importRows('favorites',[{user_id:1,job_id:1}]);
  await f.store.deleteUser(1); assert.equal(await f.store.user(1),null); assert.equal((await f.store.stats()).deliveries,0); assert.equal((await f.store.stats()).favorites,0);
});
test('update replay is suppressed and ordinary Mini App cannot invoke migration',async()=>{
  const f=await fixture(), u=message(1,'/start'); await handle(f,u); await handle(f,u); assert.equal(f.api.sent.length,1);
  await assert.rejects(administer({operation:'reset_stage'},{ownerRun:true,initData:{user:{id:1}}},f),/Owner CLI/);
  await assert.rejects(administer({operation:'reset_stage'},{ownerRun:true},f),/Cannot erase/);
  await f.store.setMeta('active',false); await f.store.setMeta('ever_active',true);
  await assert.rejects(administer({operation:'reset_stage'},{ownerRun:true},f),/Cannot erase/);
});
test('migration preserves IDs and history, new jobs continue after imported IDs',async()=>{
  const f=await fixture(); await f.store.setMeta('active',false);
  await administer({operation:'reset_stage'},{ownerRun:true},f);
  const user={user_id:1,chat_id:1,settings:{hidden_jobs:[500],notifications:'instant',notifications_after_id:499}};
  await f.store.importRows('users',[user]); await f.store.importRows('jobs',[job(500)]);
  await f.store.importRows('deliveries',[{user_id:1,job_id:500,delivered_at:'2026-01-01T00:00:00Z'}]);
  assert.deepEqual(await f.store.rows('users'),[user]); assert.equal((await f.store.rows('jobs'))[0].id,500);
  await f.store.putJob(job(501)); assert.equal(await f.store.latest(),501);
  assert.equal(settings({notifications:'daily'}).notifications_after_id,null);
});
test('HTML is escaped and UTF-16 truncation keeps intact emoji',()=>{
  assert(card(job(1)).includes('Повар &lt;&amp;&gt;')); assert.equal(clip('😀😀😀',4),'😀…');
  assert(card(job(1)).includes('https://www.google.com/maps/'));
});
test('display order follows original creation time; update keeps first publication',async()=>{
  const f=await fixture();
  const older=job(80,{created_at:'2026-10-14T12:00:00Z',published_at:'2026-10-14T12:00:00Z'});
  older._cloud.published_ms=Date.parse(older.published_at); older._cloud.published_day=belgradeDay(older._cloud.published_ms);
  await f.store.putJob(older,true);
  await f.store.putJob(job(79,{created_at:'2026-10-15T12:00:00Z'}),true);
  assert.deepEqual((await f.store.jobs()).map(j=>j.id),[79,80]);
  await f.store.putJob(job(80,{published_at:'2026-10-15T00:00:00Z'}));
  const saved=await f.store.job(80);
  assert.equal(saved.published_at,older.published_at);
  assert.equal(saved._cloud.published_ms,older._cloud.published_ms);
});
test('staging cannot notify; activation requires verified digest and stopped legacy service',async()=>{
  const f=await fixture(); await f.store.setMeta('active',false);
  await administer({operation:'reset_stage'},{ownerRun:true},f);
  await assert.rejects(administer({operation:'notify',user_id:1},{ownerRun:true},f),/not active/);
  await assert.rejects(administer({operation:'activate',digest:'a'.repeat(64),legacyStopped:true},{ownerRun:true},f),/Verified snapshot/);
  const counts=await f.store.stats();
  await administer({operation:'verified',digest:'a'.repeat(64),counts},{ownerRun:true},f);
  await assert.rejects(administer({operation:'activate',digest:'a'.repeat(64)},{ownerRun:true},f),/Verified snapshot/);
  await administer({operation:'activate',digest:'a'.repeat(64),legacyStopped:true},{ownerRun:true},f);
  await administer({operation:'pause'},{ownerRun:true},f);
  assert.equal(await f.store.meta('active'),false);
  await assert.rejects(administer({operation:'reset_stage'},{ownerRun:true},f),/Cannot erase/);
  assert.equal(f.api.sent.length,0);
});
