import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,job,handle,callback } from './fixtures.js';
import { analyticsPanel,activity,deliveryForbidden,usage } from '../tgcloud/lib/analytics.js';
import { groupJobs } from '../tgcloud/lib/catalog.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';

const routes=['admin:stats','admin:stats:delivery','admin:stats:usage','admin:quality','admin:quality:sources:0'];
const reportBody=text=>text.replace(/^✅ Отчёт обновлён из сохранённых данных\.\n\n/,'').split('\n\n<i>Отчёт сформирован:')[0];

test('analytics refresh rereads saved reports with visible feedback and no writes, collection or delivery',async t=>{
 const f=await fixture();let now=Date.parse('2026-10-19T12:34:56Z');
 t.mock.method(Date,'now',()=>now);
 await f.store.ensure(1,1);await f.store.ensure(2,2);
 await activity(f.store,1,now);await f.store.patch(1,{notifications:'instant'});
 await deliveryForbidden(f.store,2,{code:403,description:'Forbidden: bot was blocked by the user'},now);
 await usage(f.store,'searches',now);await usage(f.store,'empty',now);await usage(f.store,'translations',now);
 await f.store.putJob(job(1),true);
 await f.store.sourceStatus('tg_rabotavserbii',{state:'ok',checked_at:'2026-10-19T06:07:08Z',discovered:12,inspected:8,parsed_count:5});
 const data={groups:groupJobs(await f.store.jobs())};
 // A report may read the database, but cannot change business data or call a collector/sender.
 t.mock.method(f.db,'run',()=>assert.fail('analytics report attempted to write to the database'));
 const bot={store:f.store,panel:(text,rows)=>({text,rows}),api:new Proxy({},{get:()=>assert.fail('analytics report attempted a Telegram API call')}),fetch:()=>assert.fail('analytics report attempted a source request')};
 for(const action of routes){
  now=Date.parse('2026-10-19T12:34:56Z');
  const before=await analyticsPanel(bot,action,data);
  now+=1000;
  const after=await analyticsPanel(bot,action+':refresh',data);
  assert.match(before.text,/Отчёт сформирован: 19\.10\.2026 14:34:56 · Белград/);
  assert.match(after.text,/Отчёт сформирован: 19\.10\.2026 14:34:57 · Белград/);
  assert.match(after.text,/^✅ Отчёт обновлён из сохранённых данных\./);
  assert.match(after.text,/Обновление отчёта не запускает сбор и рассылку вакансий/);
  assert.equal(reportBody(after.text),reportBody(before.text),'unchanged data must keep every statistic unchanged');
  assert.deepEqual(after.rows,before.rows);
  assert(after.rows.flat().some(b=>b.callback_data===action+':refresh'));
  if(action==='admin:stats'){
   assert.match(after.text,/Всего в базе:<\/b> 2/);
   assert.match(after.text,/Уведомления включены:<\/b> 1/);
  }
  if(action==='admin:stats:delivery'){
   assert.match(after.text,/Доставка сообщений/);
   assert.match(after.text,/Блокировка подтверждена Telegram: 1/);
   assert.match(after.text,/Сообщения для проверки не отправляются/);
  }
  if(action==='admin:stats:usage')assert.match(after.text,/Поисков: 1\nБез результатов: 1 · 100%\nЗапросов перевода: 1/);
  if(action==='admin:quality'){
   assert.match(after.text,/Проверка базы/);
   assert.match(after.text,/Просмотр и обновление отчёта ничего не удаляют/);
   assert.match(after.text,/Публикаций: 1 · групп: 1/);
  }
  if(action==='admin:quality:sources:0'){
   assert.match(after.text,/Последняя проверка: 19\.10\.2026 08:07:08 · Белград/);
   assert.match(after.text,/сохранённые результаты последней проверки каждого источника/);
   assert.match(after.text,/«записей» — публикации до объединения/);
   assert.match(after.text,/Обнаружено: 12 · проверено: 8 · разобрано: 5/);
   assert.match(after.text,/счётчики последней проверки, а не новых вакансий/);
  }
 }
});

test('rendered report time follows Belgrade winter offset and source refresh retains its page',async t=>{
 const f=await fixture(),now=Date.parse('2026-12-19T23:59:08Z');
 t.mock.method(Date,'now',()=>now);
 const bot={store:f.store,panel:(text,rows)=>({text,rows})},data={groups:[]};
 const report=await analyticsPanel(bot,'admin:quality:sources:1:refresh',data);
 assert.match(report.text,/Отчёт сформирован: 20\.12\.2026 00:59:08 · Белград/);
 assert(report.rows.flat().some(b=>b.callback_data==='admin:quality:sources:1:refresh'));
 assert(report.rows.flat().some(b=>b.callback_data==='admin:quality:sources:0'));
 assert.match(report.text,/Последняя проверка: ещё нет/);
});

test('old analytics routes and explicit refresh routes remain owner-only and only edit the owner report',async()=>{
 const f=await fixture();await f.store.ensure(OWNER_ID,OWNER_ID);await activity(f.store,OWNER_ID);
 await f.store.putJob(job(1),true);
 await f.store.sourceStatus('tg_rabotavserbii',{state:'ok',checked_at:'2026-10-19T06:07:08Z',parsed_count:1});
 const jobs=await f.store.jobs(),statuses=await f.store.records('source_status');
 const allRoutes=routes.flatMap(route=>[route,route+':refresh']);
 f.api.sendMessage=()=>assert.fail('opening or refreshing an existing report must not send a message');
 f.api.sendPhoto=()=>assert.fail('analytics must not start a vacancy/photo delivery');
 for(const action of allRoutes){
  for(const [uid,chat] of [[1,OWNER_ID],[OWNER_ID,1],[OWNER_ID,-100]]){
   const edited=f.api.edited.length,u=callback(uid,action);u.callback_query.message.chat.id=chat;
   await handle(f,u);assert.equal(f.api.edited.length,edited,'forged owner context must not display a report');
  }
  await handle(f,callback(1,action));assert.match(f.api.edited.at(-1).text,/только владельцу/);
  await handle(f,callback(OWNER_ID,action));
  assert.doesNotMatch(f.api.edited.at(-1).text,/только владельцу|Откройте раздел заново/);
  assert.match(f.api.edited.at(-1).text,/Отчёт сформирован:/);
 }
 assert.deepEqual(await f.store.jobs(),jobs);
 assert.deepEqual(await f.store.records('source_status'),statuses);
 assert.equal(await f.store.meta('collection_run'),null);
 assert.equal(await f.store.meta('last_collection'),null);
 assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM sjc_deliveries')).n,0);
});
