import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,message,callback,job} from './fixtures.js';
import {OWNER_ID} from '../tgcloud/lib/permissions.js';
import {closeVacancy} from '../tgcloud/lib/vacancy-moderation.js';
import {groupJobs,visibleJobs} from '../tgcloud/lib/catalog.js';
import {defaults} from '../tgcloud/lib/filters.js';
import {notifyOne} from '../tgcloud/lib/admin.js';
import {Store} from '../tgcloud/lib/store.js';
const last=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const buttons=f=>last(f).reply_markup.inline_keyboard.flat();
const context=(f,uid)=>({uid,chat:uid,store:f.store,actor:{id:uid,username:'ActualAdmin'}});
async function setup(){const f=await fixture();await f.store.putJob(job(1,{url:'https://example.rs/jobs/chef'}),true);await f.store.putJob(job(2,{url:'https://example.rs/jobs/chef?utm_source=copy'}),true);for(const uid of [OWNER_ID,2,3,4,77])await f.store.ensure(uid,uid);for(const uid of [2,3])await f.store.record('staff_role',uid,{role:'administrator'});await f.store.record('staff_role',4,{role:'moderator'});return f;}
async function draft(f,uid,id=1){await handle(f,callback(uid,`admin:close:${id}:-1:s`));return (await f.store.user(uid)).settings.vacancy_close_draft.token;}
const confirm=token=>'admin:close:confirm:'+token;

test('only owner and administrators see close in vacancy actions; scoped cancel keeps the card position',async()=>{
 const f=await setup();
 for(const uid of [77,4,2,OWNER_ID]){
  await handle(f,callback(uid,'actions:1:-1:s'));
  assert.equal(buttons(f).some(b=>b.callback_data?.startsWith('admin:close:')),uid===2||uid===OWNER_ID);
 }
 await handle(f,callback(2,'search:0'));let action=buttons(f).find(b=>b.callback_data?.includes(':actions:')).callback_data;
 await handle(f,callback(2,action));const back=buttons(f).find(b=>b.text.includes('К вакансии')).callback_data;
 const close=buttons(f).find(b=>b.callback_data?.startsWith('admin:close:')).callback_data;assert(Buffer.byteLength(close)<=64);
 await handle(f,callback(2,close));assert.match(last(f).text,/для всех/);assert.equal((await f.store.records('moderation')).length,0);
 assert(buttons(f).some(b=>b.callback_data===back));const token=(await f.store.user(2)).settings.vacancy_close_draft.token;
 await handle(f,callback(2,back));await handle(f,callback(2,confirm(token)));assert.equal((await f.store.records('moderation')).length,0);
});
test('confirmation closes every known copy for search, notifications and old links and audits the actual actor',async()=>{
 const f=await setup();await f.store.patch(77,{notifications:'instant',notifications_after_id:0});const token=await draft(f,2),update=callback(2,confirm(token));update.callback_query.from.username='ActualAdmin';await handle(f,update);
 const [closed]=await f.store.records('moderation');assert.deepEqual([...closed.ids].sort((a,b)=>a-b),[1,2]);assert.equal(closed.reason,'manual_closed');
 assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);assert.equal((await notifyOne(f.store,f.api,77)).sent,0);
 await handle(f,callback(77,'job:2:short'));assert.match(last(f).text,/Вакансия закрыта/);
 await handle(f,callback(OWNER_ID,'admin:audit:0'));assert.match(last(f).text,/Вакансия закрыта/);assert.match(last(f).text,/@ActualAdmin/);assert.match(last(f).text,/Вакансия: #1/);assert(!last(f).text.includes('Пользователь: undefined'));
 const [event]=await f.store.records('staff_audit');assert.equal(event.actor.id,2);assert.equal(event.actor_role,'administrator');assert.equal(event.job_id,1);
});
test('concurrent administrators and replay after response loss create one closure and one audit event',async()=>{
 const f=await setup(),a=await draft(f,2),b=await draft(f,3);
 const results=await Promise.all([closeVacancy(context(f,2),a),closeVacancy(context(f,3),b)]);
 assert.equal(results.filter(r=>r?.closed).length,1);assert.equal((await f.store.records('staff_audit')).length,1);
 const event=(await f.store.records('staff_audit'))[0],uid=event.actor.id,token=uid===2?a:b;
 assert.equal((await closeVacancy({...context(f,uid),store:new Store(f.db)},token)).already,true);
 const edit=f.api.editMessageText;let failed=false;f.api.editMessageText=async p=>{if(!failed){failed=true;throw {code:429};}return edit(p);};
 const update=callback(uid,confirm(token));await assert.rejects(handle(f,update));await handle(f,update);await handle(f,update);
 assert.equal((await f.store.records('staff_audit')).length,1);assert.match(last(f).text,/Вакансия закрыта/);
});
test('revoked role is rechecked by the atomic SQL and a failed audit insert rolls closure back',async()=>{
 const f=await setup(),token=await draft(f,2),run=f.db.run.bind(f.db);let changed=false;
 f.db.run=async(sql,params)=>{if(sql.startsWith('WITH allowed AS')&&!changed){changed=true;await run("UPDATE sjc_records SET payload=json_set(payload,'$.role','moderator') WHERE kind='staff_role' AND record_key='2'");}return run(sql,params);};
 assert.equal(await closeVacancy(context(f,2),token),false);assert.equal((await f.store.records('moderation')).length,0);
 const ownerToken=await draft(f,OWNER_ID);
 await run("CREATE TRIGGER fail_close_audit BEFORE INSERT ON sjc_records WHEN NEW.kind='staff_audit' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 await assert.rejects(closeVacancy(context(f,OWNER_ID),ownerToken),/audit unavailable/);assert.equal((await f.store.records('moderation')).length,0);
});
test('forged identities, moderators, revoked and banned administrators cannot confirm',async()=>{
 const f=await setup(),token=await draft(f,2);
 for(const [uid,chat] of [[77,77],[4,4],[String(OWNER_ID),OWNER_ID],[OWNER_ID,77],[2,77]])assert.equal(await closeVacancy({...context(f,uid),chat},token),false);
 for(const uid of [77,4]){await handle(f,callback(uid,confirm(token)));assert.equal((await f.store.records('moderation')).length,0);}
 await f.store.record('user_ban',2,{active:true});assert.equal(await closeVacancy(context(f,2),token),false);await f.store.record('user_ban',2,{active:false});await f.store.record('staff_role',2,{role:'user'});assert.equal(await closeVacancy(context(f,2),token),false);
});
test('commands and expiry invalidate confirmation; source refresh cannot reopen, owner restore remains available',async()=>{
 const f=await setup();let token=await draft(f,2);await handle(f,message(2,'/menu'));await handle(f,callback(2,confirm(token)));assert.equal((await f.store.records('moderation')).length,0);
 token=await draft(f,2);await f.store.patch(2,{vacancy_close_draft:{id:1,token,expires:Date.now()-1}});assert.equal(await closeVacancy(context(f,2),token),false);
 token=await draft(f,2);await handle(f,callback(2,confirm(token)));
 await f.store.putJob(job(1,{url:'https://example.rs/jobs/chef',title:'Обновлённый повар'}));await f.store.putJob(job(3,{url:'https://example.rs/jobs/chef?utm_source=repost'}),true);
 assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,0);
 await handle(f,callback(OWNER_ID,'admin:restore:1'));assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);
 await handle(f,callback(2,confirm(token)));assert.equal(visibleJobs(groupJobs(await f.store.jobs()),defaults()).length,1);assert.equal((await f.store.records('staff_audit')).length,1);
});
