import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,callback,handle,job} from './fixtures.js';
import {OWNER_ID,notifyReports,ownerRoute,reportAuthorsPanel} from '../tgcloud/lib/owner.js';
import {renderImage} from '../tgcloud/lib/image-renderer.js';

const last=f=>f.api.edited.at(-1);
const buttons=f=>last(f).reply_markup.inline_keyboard.flat();
async function legacy(f,uid,extra={}){
 await f.store.record('report',uid+':1',{user_id:uid,job_id:1,group_id:1,reason:'outdated',state:'open',created_at:'2026-10-21T10:00:00Z',owner_notice:'sent',...extra});
}
test('complaint records the authenticated author and notifies only the owner with an escaped stable contact',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);
 const update=callback(77,'report:1:not_job');Object.assign(update.callback_query.from,{first_name:'Иван <b>',last_name:'& Тест',username:'ActualSender'});
 await handle(f,callback(77,'report:1'));assert.match(last(f).text,/Он увидит ваш профиль Telegram/);
 await handle(f,update);await handle(f,update);
 const [r]=await f.store.records('report');assert.deepEqual(r.reporter,{id:77,name:'Иван <b> & Тест',username:'ActualSender'});
 const notices=f.api.sent.filter(p=>p.chat_id===OWNER_ID);assert.equal(notices.length,1);assert.equal(f.api.sent.length,1);
 assert.match(notices[0].text,/Иван &lt;b&gt; &amp; Тест · @ActualSender/);assert.match(notices[0].text,/ID: 77/);
 assert.deepEqual(notices[0].reply_markup.inline_keyboard.flat().map(b=>b.url||b.callback_data),['admin:review:1','tg://user?id=77']);
 await f.store.captureUsername(77,'ChangedTag');
 await handle(f,callback(OWNER_ID,'admin:review:1'));assert.equal(buttons(f).filter(b=>b.callback_data==='admin:reporters:1:0').length,1);
 await handle(f,callback(OWNER_ID,'admin:reporters:1:0'));assert.match(last(f).text,/@ActualSender/);assert.doesNotMatch(last(f).text,/@ChangedTag/);
 assert.equal(buttons(f).find(b=>b.url).url,'tg://user?id=77');
});
test('legacy reports use cached usernames or numeric IDs without rewriting data or requiring Telegram lookup',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await f.store.ensure(77,77);await f.store.captureUsername(77,'LegacySender');
 await legacy(f,77,{owner_notice:'pending'});await legacy(f,78,{reporter:{id:999,username:'WrongPerson',name:'Неверный автор'}});
 f.api.getChat=async()=>assert.fail('No contact lookup is needed');
 await Promise.all([notifyReports(f.store,f.api),notifyReports(f.store,f.api)]);
 assert.equal(f.api.sent.length,1);assert.match(f.api.sent[0].text,/@LegacySender/);assert.equal(f.api.sent[0].reply_markup.inline_keyboard[1][0].url,'tg://user?id=77');
 const before=await f.store.records('report');await handle(f,callback(OWNER_ID,'admin:reporters:1:0'));
 assert.match(last(f).text,/@LegacySender/);assert.match(last(f).text,/ID: 78/);assert.doesNotMatch(last(f).text,/WrongPerson|Неверный автор/);
 assert.deepEqual(buttons(f).filter(b=>b.url).map(b=>b.url).sort(),['tg://user?id=77','tg://user?id=78']);
 assert.deepEqual(await f.store.records('report'),before);
});
test('authors of all copies are paginated in bounded queries and unrelated or resolved reports stay out',async()=>{
 const f=await fixture();await f.store.putJob(job(1,{url:'https://example.rs/same'}),true);await f.store.putJob(job(2,{url:'https://example.rs/same?utm_source=test'}),true);
 await f.store.putJob(job(3,{url:'https://example.rs/other'}),true);
 for(let uid=100;uid<112;uid++)await legacy(f,uid,{job_id:uid%2?1:2,group_id:uid%2?1:2});
 await legacy(f,900,{job_id:3,group_id:3});await legacy(f,901,{state:'reviewed'});
 const all=f.db.all;f.db.all=async(sql,params)=>{const rows=await all(sql,params);if(sql.startsWith('SELECT payload FROM sjc_records')&&sql.includes("kind='report'"))assert(rows.length<=5);return rows;};
 for(const page of [0,1,2,999999]){
  await handle(f,callback(OWNER_ID,`admin:reporters:2:${page}`));const panel=last(f),links=buttons(f).filter(b=>b.url);
  assert.equal(links.length,page<2?5:2);assert.match(panel.text,/Всего открытых жалоб: 12/);assert.doesNotMatch(panel.text,/ID: 90[01]/);
  assert.equal(new Set(buttons(f).map(b=>b.callback_data||b.url)).size,buttons(f).length);
  assert(buttons(f).some(b=>b.callback_data==='admin:review:1'));
 }
 await handle(f,callback(OWNER_ID,'admin:keep:1'));await handle(f,callback(OWNER_ID,'admin:reporters:1:0'));
 assert.match(last(f).text,/Открытых жалоб.*больше нет/);assert.equal(buttons(f).filter(b=>b.url).length,0);
});
test('owner numeric identity and matching private chat protect authors against forged callbacks',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await legacy(f,777,{reporter:{id:777,name:'Личный автор',username:'PrivateSender'}});
 for(const [uid,role] of [[1,'moderator'],[2,'administrator'],[3,'user']]){
  await f.store.ensure(uid,uid);if(role!=='user')await f.store.record('staff_role',uid,{uid,role});
  await handle(f,callback(uid,'admin:reporters:1:0'));assert.doesNotMatch(last(f).text,/777|PrivateSender|Личный автор/);assert(!buttons(f).some(b=>b.url?.startsWith('tg://')));
 }
 for(const [uid,chat] of [[OWNER_ID,1],[1,OWNER_ID],[OWNER_ID,-100]]){
  const c=callback(uid,'admin:reporters:1:0'),before=f.api.edited.length;c.callback_query.message.chat.id=chat;await handle(f,c);assert.equal(f.api.edited.length,before);
 }
 const panels=[],panel=async text=>panels.push(text);
 for(const [uid,chat] of [[String(OWNER_ID),OWNER_ID],[OWNER_ID,String(OWNER_ID)],[1,1]]){
  const bot={uid,chat,panel,store:{db:{get:()=>assert.fail('Authorization precedes database reads')}}};
  await ownerRoute(bot,'admin:reporters:1:0');await reportAuthorsPanel(bot,{id:1,members:[{id:1}]});assert(panels.every(p=>p.includes('только владельцу')));
 }
 assert.equal(f.api.sent.length,0);
});
test('privacy rejection keeps the owner notice and numeric ID, while ambiguous delivery is never retried',async()=>{
 for(const kind of ['privacy','timeout']){
  const f=await fixture();await legacy(f,77,{owner_notice:'pending'});let calls=0;
  f.api.sendMessage=async p=>{calls++;if(calls===1)throw kind==='privacy'?{code:400,description:'Bad Request: BUTTON_USER_PRIVACY_RESTRICTED'}:{code:500};assert.match(p.text,/ID: 77/);assert.equal(p.reply_markup.inline_keyboard.length,1);return {message_id:1};};
  await notifyReports(f.store,f.api);await notifyReports(f.store,f.api);
  assert.equal(calls,kind==='privacy'?2:1);assert.equal((await f.store.records('report'))[0].owner_notice,kind==='privacy'?'sent':'uncertain');
 }
});
test('profile deletion removes author snapshots and contact rows from stored complaints',async()=>{
 const f=await fixture();await f.store.ensure(77,77);await f.store.putJob(job(1),true);await legacy(f,77,{reporter:{id:77,name:'Удалённый автор',username:'DeletedPerson'}});
 await f.store.deleteUser(77);assert.equal((await f.store.records('report')).length,0);
 await handle(f,callback(OWNER_ID,'admin:reporters:1:0'));assert.doesNotMatch(last(f).text,/77|DeletedPerson|Удалённый автор/);assert(!buttons(f).some(b=>b.url));
});
test('a definite privacy rejection cannot hide the author page and ambiguous errors propagate without a second attempt',async()=>{
 const f=await fixture();await legacy(f,77);const group={id:1,members:[{id:1}]};
 for(const code of [400,500]){
  let calls=0;
  const bot={store:f.store,uid:OWNER_ID,chat:OWNER_ID,panel:async(text,rows)=>{calls++;if(calls===1)throw {code,description:'BUTTON_USER_PRIVACY_RESTRICTED'};assert.match(text,/ID: 77/);assert.match(text,/не разрешил/);assert(!rows.flat().some(b=>b.url));}};
  if(code===400)await reportAuthorsPanel(bot,group);else await assert.rejects(reportAuthorsPanel(bot,group));
  assert.equal(calls,code===400?2:1);
 }
});
test('long author names and unsafe HTML render within panel and callback limits without writes',async()=>{
 const f=await fixture();const group={id:1,members:[{id:1}]},panels=[];
 for(let uid=100;uid<105;uid++)await legacy(f,uid,{reporter:{id:uid,name:'<b>&'.repeat(80),username:'a'.repeat(32)}});
 const before=await f.db.all('SELECT * FROM sjc_records');
 await reportAuthorsPanel({store:f.store,uid:OWNER_ID,chat:OWNER_ID,panel:async(text,rows)=>panels.push({text,rows})},group);
 const p=panels[0];assert(p.text.length<4096);assert(!p.text.includes('<b>&'));assert(p.rows.flat().every(b=>!b.callback_data||b.callback_data.length<=64));
 const image=renderImage(p.text);assert(image.bytes.length<10000000);assert(image.width+image.height<=10000);
 assert.deepEqual(await f.db.all('SELECT * FROM sjc_records'),before);
});
