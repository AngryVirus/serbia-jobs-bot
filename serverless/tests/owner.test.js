import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,job,handle,message,callback } from './fixtures.js';
import { OWNER_ID,ownerReport } from '../tgcloud/lib/owner.js';
import { groupJobs,visibleJobs } from '../tgcloud/lib/catalog.js';
import { defaults } from '../tgcloud/lib/filters.js';
import { administer,notifyOne } from '../tgcloud/lib/admin.js';
import { card,translatedCard,viewerButtons,cardActions } from '../tgcloud/lib/ui.js';

test('compact cards keep paging and put secondary actions in a contextual submenu',()=>{
  const j=job(8),rows=viewerButtons(j,3,10,'rf',false);
  assert(rows.length<=3); assert(rows.flat().length<=5);
  assert(rows.flat().some(b=>b.callback_data==='actions:8:3:rf'));
  assert(rows.flat().some(b=>b.callback_data==='view:8:3:next:rf'));
  const [,actions]=cardActions(j,3,'rf');
  assert(actions.flat().some(b=>b.callback_data==='view:8:3:show:rf'));
  assert(actions.flat().some(b=>b.callback_data==='report:8:choose:3:rf'));
  assert(actions.flat().some(b=>b.callback_data==='view:8:3:translate:rf'));
});

test('complaints are personal, deduplicated and removed with personal data',async()=>{
  const f=await fixture();
  await f.store.putJob(job(1,{url:'https://example.rs/jobs/1'}),true);
  await f.store.putJob(job(2,{url:'http://www.example.rs/jobs/1?utm_source=test'}),true);
  await handle(f,message(1,'/start')); await handle(f,callback(1,'report:1:outdated'));
  await handle(f,callback(1,'report:2:not_job'));
  assert.equal((await f.store.records('report')).length,1);
  const groups=groupJobs(await f.store.jobs());
  assert.equal(visibleJobs(groups,(await f.store.user(1)).settings).length,0);
  assert.equal(visibleJobs(groups,defaults()).length,1);
  await f.store.deleteUser(1); assert.equal((await f.store.records('report')).length,0);
});

test('owner-only reports and moderation enforce authorization even for forged callbacks',async()=>{
  const f=await fixture(); await f.store.putJob(job(1),true);
  await handle(f,message(2,'/start'));
  assert(!JSON.stringify(f.api.sent.at(-1)).includes('Отчёт владельца'));
  await handle(f,callback(2,'admin:block:1')); assert.equal((await f.store.records('moderation')).length,0);
  assert(f.api.edited.at(-1).text.includes('только владельцу'));
  await handle(f,message(OWNER_ID,'/start')); assert(JSON.stringify(f.api.sent.at(-1)).includes('Отчёт владельца'));
  await handle(f,message(OWNER_ID,'/admin')); assert(f.api.sent.at(-1).text.includes('Каталог:'));
});

test('moderation removes every copy from search and notifications; restore retains delivery history',async()=>{
  const f=await fixture(); await f.store.putJob(job(1,{url:'https://example.rs/jobs/1'}),true);
  await f.store.putJob(job(2,{url:'https://www.example.rs/jobs/1'}),true);
  await handle(f,message(1,'/start')); await f.store.patch(1,{notifications:'instant'});
  await handle(f,callback(1,'report:2:duplicate'));
  await handle(f,callback(OWNER_ID,'admin:reports:0')); assert(f.api.edited.at(-1).text.includes('Повтор объявления'));
  await handle(f,callback(OWNER_ID,'admin:block:1'));
  assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
  await f.store.ensure(3,3); await f.store.patch(3,{notifications:'instant'});
  assert.equal((await notifyOne(f.store,f.api,3)).sent,0);
  await handle(f,callback(3,'job:2:full')); assert(f.api.edited.at(-1).text.includes('снято с выдачи'));
  await f.store.importRows('deliveries',[{user_id:3,job_id:1}]);
  await handle(f,callback(OWNER_ID,'admin:restore:2'));
  assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);
  assert.equal((await notifyOne(f.store,f.api,3)).sent,0);
  assert.equal((await f.store.records('report'))[0].state,'reviewed');
});

test('withdrawn source posts exclude the vacancy and copies; new original can reopen it',async()=>{
  const f=await fixture(); const a=job(1), b=job(2,{url:a.url.replace('https:','http:')});
  await f.store.putJob(a,true); await f.store.putJob(b,true);
  await f.store.withdraw(a.source,[a.url]);
  assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
  assert.equal((await f.store.job(1))._cloud.quality.reason,'closed');
  await f.store.putJob(a);
  assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);
});

test('requirements are explicit and survive translation; missing facts are not invented',async()=>{
  const j=job(1); j._cloud={...j._cloud,permit:false,experience:true,paperwork_assistance:true};
  const text=card(j); assert(text.includes('ВНЖ: не требуется')); assert(text.includes('Опыт: требуется')); assert(text.includes('Помощь с документами: указана'));
  const translated=await translatedCard(j,'rf',async()=>({ok:true,json:async()=>[[['Перевод']]]}));
  assert(translated.text.includes('ВНЖ: не требуется')); assert(translated.text.includes('Опыт: требуется'));
  const unknown=card(job(2)); assert(!unknown.includes('ВНЖ:')); assert(!unknown.includes('Опыт:')); assert(!unknown.includes('Помощь с документами:'));
});

test('fact refresh preserves IDs, source fields and concurrent edits',async()=>{
  const f=await fixture(); const a=job(1); await f.store.putJob(a,true);
  const fresh={...a,_cloud:{...a._cloud,quality:{version:1,reason:'services'},experience:false,paperwork_assistance:null}};
  assert.equal(await f.store.refreshFacts(fresh),true);
  const saved=await f.store.job(1); assert.equal(saved.description,a.description); assert.equal(saved.id,1);
  assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
  await f.store.putJob({...a,description:'New content'});
  assert.equal(await f.store.refreshFacts(fresh),false);
  assert.equal((await f.store.job(1)).description,'New content');
});

test('collection report records completion, counts, sources and uncertain deliveries without user IDs',async()=>{
  const f=await fixture(), owner='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await administer({operation:'collection_begin',owner},{ownerRun:true},f);
  await administer({operation:'collect',owner,source:'tg_rabotavserbii',jobs:[job(1)],status:{state:'ok',checked_at:new Date().toISOString()}},{ownerRun:true},f);
  await administer({operation:'collection_end',owner,failed:false,totals:{sources:1,added:1,sent:0,uncertain:0}},{ownerRun:true},f);
  const report=await ownerReport(f.store); assert(report.text.includes('Новых доступных вакансий: 1')); assert(report.text.includes('успешно'));
  assert(report.issues.length>0); assert(!report.text.includes(String(OWNER_ID)));
  await assert.rejects(administer({operation:'collection_end',owner:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'},{ownerRun:true},f),/owner mismatch/);
});
