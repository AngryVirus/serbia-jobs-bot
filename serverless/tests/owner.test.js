import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,job,handle,message,callback } from './fixtures.js';
import { OWNER_ID,ownerReport,ownerRoute,notifyReports } from '../tgcloud/lib/owner.js';
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

test('large catalog reads stay bounded and retain every job across sparse ID pages',async()=>{
  const f=await fixture();
  for(let i=1;i<=215;i++) await f.store.putJob(job(i*3,{description:'x'.repeat(15000)}),true);
  const original=f.db.all.bind(f.db),sizes=[];
  f.db.all=async(...args)=>{const rows=await original(...args); if(args[0].includes('FROM sjc_jobs')) {sizes.push(rows.length);assert(rows.length<=100,'oversized database response');} return rows;};
  const jobs=await f.store.jobs(); assert.equal(jobs.length,215); assert.equal(new Set(jobs.map(j=>j.id)).size,215);
  assert.deepEqual(sizes,[100,100,15]); assert.equal(jobs[0].id,645); assert.equal(jobs.at(-1).id,3);
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
  await handle(f,message(OWNER_ID,'/admin')); assert(f.api.sent.at(-1).text.includes('💼 Вакансии'));
  assert(f.api.sent.at(-1).text.length < 1000);
  await handle(f,callback(OWNER_ID,'admin:details')); assert(f.api.edited.at(-1).text.includes('Каталог:'));
  await handle(f,callback(2,'admin:details')); assert(f.api.edited.at(-1).text.includes('только владельцу'));
});

test('owner dashboard groups existing tools into readable sections with a route back',async()=>{
  const f=await fixture();
  await handle(f,callback(OWNER_ID,'admin'));
  const dashboard=f.api.edited.at(-1),rows=dashboard.reply_markup.inline_keyboard;
  assert(rows.every(row=>row.length===1));
  assert.deepEqual(rows.flat().map(b=>[b.text,b.callback_data]),[
    ['📋 Вакансии','admin:vacancies'],['👥 Пользователи','admin:users'],['🛡 Команда','admin:staff'],['📡 Сбор вакансий','admin:collection'],['📣 Реклама','ads'],['🔄 Обновить отчёт','admin:refresh'],['🏠 Главное меню','menu']
  ]);
  for(const [action,purpose,targets] of [
    ['admin:vacancies','жалобы',['admin:reports:0','admin:blocked:0']],
    ['admin:users','блокировки',['admin:people:0','admin:stats','admin:bans:0']],
    ['admin:staff','изменения прав',['admin:team:0','admin:audit:0']],
    ['admin:collection','сохранённые данные',['admin:sources:0','admin:quality:sources:0','admin:ideas:pending:0','admin:quality','admin:details']]
  ]) {
    await handle(f,callback(OWNER_ID,action));
    const panel=f.api.edited.at(-1),buttons=panel.reply_markup.inline_keyboard;
    assert(panel.text.includes(purpose)); assert(buttons.every(row=>row.length===1));
    assert.deepEqual(buttons.flat().map(b=>b.callback_data),[...targets,'admin','menu']);
    for(const target of targets) {
      await handle(f,callback(OWNER_ID,target));
      assert(!f.api.edited.at(-1).text.includes('Действие устарело'));
      const back=target==='admin:people:0'?'admin:users':'admin';
      assert(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data===back));
    }
    await handle(f,callback(OWNER_ID,'admin'));
    assert.deepEqual(f.api.edited.at(-1).reply_markup.inline_keyboard,rows);
  }
  assert(f.api.sent.every(p=>p.chat_id===OWNER_ID));
  assert.equal(await f.store.meta('collection_run'),null);
  assert.equal((await f.store.records('ad_campaign')).length,0);
});

test('owner sections need no catalog read and reject numeric-string or mismatched identities before reading',async()=>{
  const sections=['admin:vacancies','admin:users','admin:staff','admin:collection'];
  const actions=[...sections,'admin:refresh','admin:details:refresh','admin:collection:wake'];
  const panels=[],panel=async(text,rows)=>panels.push({text,rows});
  for(const action of sections) {
    await ownerRoute({uid:OWNER_ID,chat:OWNER_ID,panel,store:{meta:async()=>null,jobs:()=>assert.fail('Section must not read catalogue')}},action);
    assert(panels.at(-1).rows.flat().some(b=>b.callback_data==='admin'));
  }
  for(const [uid,chat] of [[String(OWNER_ID),OWNER_ID],[OWNER_ID,String(OWNER_ID)],[2,2],[OWNER_ID,2],[2,OWNER_ID]]) {
    for(const action of actions) {
      await ownerRoute({uid,chat,panel},action);
      assert.match(panels.at(-1).text,/только владельцу/);
      assert.equal(panels.at(-1).rows,undefined);
    }
  }
});

test('new owner callbacks cannot expose panels outside the owner private chat',async()=>{
  const f=await fixture(),actions=['admin:vacancies','admin:users','admin:staff','admin:collection','admin:refresh','admin:details:refresh'];
  for(const action of actions) {
    await handle(f,callback(2,action));
    assert.match(f.api.edited.at(-1).text,/только владельцу/);
    assert.deepEqual(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().map(b=>b.callback_data),['menu']);
    for(const alter of [u=>{u.callback_query.message.chat.type='group';},u=>{u.callback_query.message.chat.id=2;},u=>{u.callback_query.from.id=String(OWNER_ID);}]) {
      const u=callback(OWNER_ID,action),before=f.api.edited.length;
      alter(u); await handle(f,u); assert.equal(f.api.edited.length,before);
    }
  }
  assert.equal(f.api.sent.length,0);
});

test('summary and detailed refresh reread saved data and show report time without starting work',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-07-01T12:34:56Z')});
  const f=await fixture(),last={finished_at:'2026-07-01T11:00:00Z',totals:{sources:1,healthy_sources:1,sent:0},new_unique:1};
  await f.store.setMeta('last_collection',last);
  await f.store.setMeta('collection_run',{state:'done',finished_at:last.finished_at});
  await f.store.putJob(job(1),true);
  await handle(f,callback(OWNER_ID,'admin'));
  const first=f.api.edited.at(-1).text;
  assert.match(first,/В поиске: <b>1<\/b>/);
  assert.match(first,/Последний сбор завершён: 2026-07-01 13:00 \(Белград\)/);
  assert.match(first,/Время отчёта: 2026-07-01 14:34:56 \(Белград\)/);
  assert(!first.includes('Обновление:'));
  assert(!first.includes('✅ Отчёт обновлён из сохранённых данных.'));
  await f.store.putJob(job(2,{url:'https://example.rs/second'}),true);
  const snapshot=async()=>({meta:await f.db.all('SELECT key,payload FROM sjc_meta ORDER BY key'),records:await f.db.all('SELECT kind,record_key,payload FROM sjc_records ORDER BY kind,record_key')});
  const before=await snapshot();
  t.mock.timers.tick(2000);
  await handle(f,callback(OWNER_ID,'admin:refresh'));
  const summary=f.api.edited.at(-1).text;
  assert(summary.startsWith('✅ Отчёт обновлён из сохранённых данных.'));
  assert.match(summary,/В поиске: <b>2<\/b>/);
  assert.match(summary,/Время отчёта: 2026-07-01 14:34:58 \(Белград\)/);
  for(const action of ['admin:details','admin:details:refresh']) {
    t.mock.timers.tick(1000); await handle(f,callback(OWNER_ID,action));
    const detail=f.api.edited.at(-1);
    assert.equal(detail.text.startsWith('✅ Отчёт обновлён из сохранённых данных.'),action==='admin:details:refresh');
    assert.match(detail.text,/Подробный отчёт/); assert.match(detail.text,/Каталог: 2 публикаций/);
    assert.match(detail.text,/Последний сбор завершён: 2026-07-01 13:00 \(Белград\)/);
    assert(detail.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:details:refresh'));
  }
  assert.match(f.api.edited.at(-1).text,/Время отчёта: 2026-07-01 14:35:00 \(Белград\)/);
  for(const text of [summary,f.api.edited.at(-1).text]) {
    assert(text.includes('актуальные сохранённые данные'));
    assert(text.includes('Сбор вакансий выполняется автоматически'));
  }
  assert.deepEqual(await snapshot(),before);
  assert.equal(f.api.sent.length,0);
  assert(f.api.edited.every(p=>p.chat_id===OWNER_ID));
});

test('an uninitialized report separates its winter report time from unknown collection time',async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-01-01T23:59:58Z')});
  const f=await fixture(),report=await ownerReport(f.store);
  for(const text of [report.text,report.details]) {
    assert.match(text,/Последний сбор завершён: нет данных/);
    assert.match(text,/Время отчёта: 2026-01-02 00:59:58 \(Белград\)/);
  }
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
  const text=card(j); assert(text.includes('ВНЖ: не нужен')); assert(text.includes('Опыт: требуется')); assert(text.includes('Помощь с документами: указана'));
  const translated=await translatedCard(j,'rf',async()=>({ok:true,json:async()=>[[['Перевод']]]}));
  assert(translated.text.includes('ВНЖ: не нужен')); assert(translated.text.includes('Опыт: требуется'));
  const unknown=card(job(2)); assert(unknown.includes('🪪 ВНЖ: не указано')); assert(!unknown.includes('Опыт:')); assert(!unknown.includes('Помощь с документами:'));
  assert(card({...j,_cloud:{...j._cloud,permit:true}}).includes('🪪 ВНЖ: нужен'));
});

test('a new complaint notifies only the owner once and opens that exact vacancy',async()=>{
  const f=await fixture(); await f.store.putJob(job(1,{title:'Первое <&>'}),true); await f.store.putJob(job(2,{title:'Второе'}),true);
  await handle(f,callback(1,'report:1:not_job')); await handle(f,callback(1,'report:1:not_job'));
  const notices=f.api.sent.filter(m=>m.chat_id===OWNER_ID);
  assert.equal(notices.length,1); assert(notices[0].text.includes('Первое &lt;&amp;&gt;'));
  assert.equal(notices[0].reply_markup.inline_keyboard[0][0].callback_data,'admin:review:1');
  await handle(f,callback(2,'report:2:outdated'));
  await handle(f,callback(OWNER_ID,'admin:review:1')); assert(f.api.edited.at(-1).text.includes('Первое &lt;&amp;&gt;'));
  await handle(f,callback(2,'admin:review:1')); assert(f.api.edited.at(-1).text.includes('только владельцу'));
  assert.equal((await f.store.records('report'))[0].owner_notice,'sent');
});

test('owner notification failure preserves the complaint; 429 retries but ambiguous delivery never repeats',async()=>{
  for(const code of [429,403,500]) {
    const f=await fixture(); await f.store.putJob(job(1),true);
    f.api.sendMessage=async()=>{throw {code,parameters:{retry_after:5}};};
    await handle(f,callback(1,'report:1:outdated'));
    let [report]=await f.store.records('report'); assert.equal(report.state,'open');
    assert.equal(report.owner_notice,code===429?'pending':code===403?'blocked':'uncertain');
    assert(f.api.edited.at(-1).text.includes('Жалоба сохранена'));
    let sent=0; f.api.sendMessage=async()=>{sent++;return {message_id:1};};
    await notifyReports(f.store,f.api); assert.equal(sent,0);
    if(code===429) {await f.store.record('report','1:1',{...report,notice_after:0}); await Promise.all([notifyReports(f.store,f.api),notifyReports(f.store,f.api)]);assert.equal(sent,1);}
  }
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
  const previous=job(1,{source:'tg_rabotavserbii',url:'https://t.me/rabotavserbii/1'});
  await f.store.putJob(previous,true);
  await administer({operation:'collection_begin',owner},{ownerRun:true},f);
  await administer({operation:'collect',owner,source:'telegram_youritjob',jobs:[job(2,{source:'telegram_youritjob',url:previous.url})],status:{state:'error',detail:'Источник отвечает ошибкой',checked_at:new Date().toISOString()}},{ownerRun:true},f);
  await administer({operation:'collect',owner,source:'tg_radim_serbia',jobs:[job(3,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/3'})],status:{state:'ok',checked_at:new Date().toISOString()}},{ownerRun:true},f);
  await f.db.run("INSERT INTO sjc_deliveries(user_id,job_id,state,payload) VALUES(1,3,'blocked',:payload)",{':payload':JSON.stringify({user_id:1,job_id:3,delivered_at:new Date().toISOString()})});
  await administer({operation:'collection_end',owner,failed:false,totals:{sources:2,added:2,sent:0,uncertain:1}},{ownerRun:true},f);
  const report=await ownerReport(f.store);
  assert(report.text.includes('новых за сбор: <b>1</b>'));
  assert(report.details.includes('повторов за сбор: 1'));
  assert(report.details.includes('Ошибки доставки за сбор: 1 блокировок, 1 неопределённых отправок'));
  assert(report.details.includes('Последний сбор завершён:'));
  const failedSource=report.issues.findIndex(s=>s.id==='telegram_youritjob'&&s.state==='error');
  assert(!report.sources.some(s=>s.id==='halooglasi'||s.id==='telegram_python_jobs'));
  assert(failedSource>=0);
  await handle(f,callback(OWNER_ID,`admin:sources:${Math.floor(failedSource/4)}`));
  assert(f.api.edited.at(-1).text.includes('Telegram · IT Работа: Сербия и удалёнка — ошибка.'));
  assert.equal(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().find(b=>b.callback_data==='admin:quality:sources:0').text,'📡 Все источники');
  assert(!report.text.includes(String(OWNER_ID)));
  await assert.rejects(administer({operation:'collection_end',owner:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'},{ownerRun:true},f),/owner mismatch/);
});

test('large reviewed report history is not loaded; active review pages stay bounded and preserve concurrent new complaints',async()=>{
 const f=await fixture();await f.store.putJob(job(1,{url:'https://example.rs/one'}),true);await f.store.putJob(job(2,{url:'http://www.example.rs/one'}),true);
 for(let uid=1000;uid<1250;uid++)await f.store.record('report',uid+':1',{user_id:uid,job_id:1,group_id:1,reason:'outdated',state:'reviewed',owner_notice:'pending',job_title:'old'.repeat(4000)});
 for(let uid=2000;uid<2230;uid++)await f.store.record('report',uid+':1',{user_id:uid,job_id:2,group_id:1,reason:uid%2?'duplicate':'outdated',state:'open',owner_notice:uid<2005?'pending':'sent',job_title:'Open report'});
 const all=f.db.all,reads=[];
 f.db.all=async(sql,params)=>{const rows=await all(sql,params);if(sql.includes("kind='report'")){assert(rows.length<=100,'unbounded report response');for(const row of rows)if(row.payload)assert.equal(JSON.parse(row.payload).state,'open','reviewed history was fetched');reads.push(rows.length);}return rows;};
 const report=await ownerReport(f.store);assert.equal(report.pending_reports,230);assert(!('reports' in report));
 await notifyReports(f.store,f.api);assert.equal(f.api.sent.filter(p=>p.chat_id===OWNER_ID).length,5);
 await handle(f,callback(5000,'report:1:outdated'));await handle(f,callback(5000,'report:2:duplicate'));
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.user_id')=5000")).n,1);
 await handle(f,callback(OWNER_ID,'admin:reports:0'));assert.match(f.api.edited.at(-1).text,/231 жалоб/);assert.match(f.api.edited.at(-1).text,/Повтор объявления/);
 const run=f.db.run;let inserted=false;
 f.db.run=async(sql,params)=>{if(!inserted&&sql.startsWith('UPDATE sjc_records SET payload=:next')&&sql.includes("kind='report'")){inserted=true;await f.store.record('report','9999:1',{user_id:9999,job_id:2,group_id:1,reason:'not_job',state:'open',owner_notice:'pending'});}return run(sql,params);};
 await handle(f,callback(OWNER_ID,'admin:keep:2'));assert(inserted);assert(reads.includes(100));
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='open'")).n,1);
 assert.equal(JSON.parse((await f.db.get("SELECT payload FROM sjc_records WHERE kind='report' AND record_key='9999:1'")).payload).state,'open');
 assert.equal((await f.db.get("SELECT COUNT(*) AS n FROM sjc_records WHERE kind='report' AND json_extract(payload,'$.state')='reviewed'")).n,481);
});

test('reported vacancy IDs page across sparse catalog IDs without losing the last review card',async()=>{
 const f=await fixture();
 for(let i=1;i<=115;i++){const id=i*3;await f.store.putJob(job(id,{title:'Вакансия '+id}),true);await f.store.record('report',i+':'+id,{user_id:i,job_id:id,group_id:id,reason:'outdated',state:'open',owner_notice:'sent'});}
 const all=f.db.all,sizes=[];
 f.db.all=async(sql,params)=>{const rows=await all(sql,params);if(sql.startsWith('SELECT id FROM ('))sizes.push(rows.length);return rows;};
 await handle(f,callback(OWNER_ID,'admin:reports:114'));
 assert.match(f.api.edited.at(-1).text,/115\/115/);assert.match(f.api.edited.at(-1).text,/Вакансия 3/);assert.deepEqual(sizes,[100,15]);
});
