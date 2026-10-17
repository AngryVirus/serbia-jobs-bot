import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, selected, choose, defaults, matches, belgradeDay } from '../tgcloud/lib/filters.js';
import { choicePanel, summary } from '../tgcloud/lib/ui.js';
import { fixture, job, message, callback, handle } from './fixtures.js';
import { notifyOne } from '../tgcloud/lib/admin.js';

test('age is a single maximum period; legacy selections normalize without resetting notifications',()=>{
  for(const [old,expected] of [['today','7'],['yesterday','7'],[['today','yesterday'],'7'],[['7','30'],'30'],[['30','any'],'any']]) {
    const s=settings({freshness:old,notifications:'instant',notifications_after_id:42});
    assert.deepEqual(selected(s,'freshness'),[expected]);
    assert.equal(s.notifications_after_id,42);
    assert(!summary(s).includes('today'));
  }
  assert.deepEqual(choose({freshness:['30']},'freshness','7',true),['7']);
  assert.deepEqual(choose({freshness:['7']},'freshness','7',false),['7']);
  const [text,rows]=choicePanel(settings({freshness:['today','30']}),'freshness');
  const choices=rows.flat().filter(b=>b.callback_data.startsWith('choose:freshness:'));
  assert.equal(choices.length,3); assert.equal(choices.filter(b=>b.text.startsWith('✅')).length,1);
  assert(text.includes('Выберите один вариант')); assert(!text.includes('Можно отметить несколько'));
});

test('week and month use publication age; unknown dates only appear in all, expired and future never appear',()=>{
  const now=Date.parse('2026-10-17T12:00:00Z');
  const opening=age=>{const j=job(1); j._cloud={...j._cloud,published_day:belgradeDay(now)-age,published_ms:now-age*86400000};return j;};
  for(const [period,limit] of [['7',7],['30',30]]) {
    assert(matches(opening(limit-1),{...defaults(),freshness:period},now));
    assert(!matches(opening(limit),{...defaults(),freshness:period},now));
    assert(!matches(job(1),{...defaults(),freshness:period},now));
  }
  assert(matches(job(1),defaults(),now));
  assert(!matches(opening(-1),defaults(),now));
  const expired=opening(1);expired._cloud.expires_ms=now-1;
  assert(!matches(expired,defaults(),now));
});

test('old buttons still work; age settings do not resend the catalog and apply to new discoveries',async()=>{
  const f=await fixture(); await f.store.putJob(job(1),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'notify:instant'));
  await handle(f,callback(1,'choose:freshness:today:1'));
  assert.deepEqual((await f.store.user(1)).settings.freshness,['7']);
  await handle(f,callback(1,'choose:freshness:30:1'));
  assert.deepEqual((await f.store.user(1)).settings.freshness,['30']);
  assert.equal((await f.store.user(1)).settings.notifications_after_id,1);
  assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  const old=job(2,{title:'Old opening'});old._cloud={...old._cloud,published_day:belgradeDay(Date.now())-40};
  await f.store.putJob(old,true);assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
  await handle(f,callback(1,'choose:freshness:any:1'));
  assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
  assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
});
