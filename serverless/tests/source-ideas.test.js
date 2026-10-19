import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,message,callback } from './fixtures.js';
import { OWNER_ID } from '../tgcloud/lib/permissions.js';
import { sourceUsername,notifySourceIdeas } from '../tgcloud/lib/source-ideas.js';
const last=f=>f.api.sent.at(-1)||f.api.edited.at(-1);
async function submit(f,uid,text){await handle(f,callback(uid,'idea:start'));await handle(f,message(uid,text));}
test('only public Telegram names are accepted and input never fetches submitted URLs',async()=>{
 for(const value of ['@SerbiaWork','https://t.me/serbiawork/123','https://telegram.me/s/serbiawork'])assert.equal(sourceUsername(value),'serbiawork');
 for(const value of ['https://evil.test/serbiawork','https://t.me/+private','https://t.me/joinchat/x','https://t.me/c/123/5','https://t.me/share?url=evil','@foo @bar','https://t.me/user/5?token=secret'])assert.equal(sourceUsername(value),null);
 const f=await fixture();f.fetch=()=>assert.fail('suggestion fetched arbitrary URL');
 await submit(f,1,'https://t.me/example_jobs');
 assert.match(last(f).text,/сохранён для проверки/);assert.equal((await f.store.records('source_idea')).length,1);
 assert.equal(f.api.sent.filter(p=>p.chat_id===OWNER_ID).length,1);
});
test('known and duplicate sources do not create repeated owner notices or enable collection',async()=>{
 const f=await fixture();await submit(f,1,'@rabotavserbii');assert.match(last(f).text,/уже подключён/);assert.equal((await f.store.records('source_idea')).length,0);
 await submit(f,1,'@example_jobs');await submit(f,2,'https://t.me/Example_Jobs');
 assert.equal((await f.store.records('source_idea')).length,1);assert.equal(f.api.sent.filter(p=>p.chat_id===OWNER_ID).length,1);
 assert.equal(await f.store.meta('collection_run'),null);
 assert(!JSON.stringify(await f.store.records('source_idea')).includes('user_id'));
});
test('only the numeric owner in their private chat can review proposals',async()=>{
 const f=await fixture();await submit(f,1,'@example_jobs');
 for(const [uid,chat] of [[2,2],[2,OWNER_ID],[OWNER_ID,2]]){const u=callback(uid,'admin:ideas:reject:example_jobs');u.callback_query.message.chat.id=chat;await handle(f,u);assert.equal((await f.store.records('source_idea'))[0].state,'pending');}
 await handle(f,callback(OWNER_ID,'admin:ideas:work:example_jobs'));assert.equal((await f.store.records('source_idea'))[0].state,'work');
 await handle(f,callback(OWNER_ID,'admin:ideas:reject:example_jobs'));assert.equal((await f.store.records('source_idea'))[0].state,'work');
 await handle(f,callback(OWNER_ID,'admin:ideas:reviewed:0'));assert.match(f.api.edited.at(-1).text,/в работе/);
});
test('daily source proposal limit survives restarts; repeats do not consume more quota',async()=>{
 const f=await fixture();for(const name of ['alpha_jobs','bravo_jobs','charlie_jobs'])await submit(f,1,'@'+name);
 await submit(f,1,'@delta_jobs');assert.match(last(f).text,/уже предложили три/);
 await submit(f,1,'@alpha_jobs');assert.match(last(f).text,/уже предложен/);
 assert.equal((await f.store.records('source_idea')).length,3);
});
test('ambiguous source alerts never repeat; explicit 429 is retried after cooldown',async()=>{
 for(const code of [500,429]){
  const f=await fixture();f.api.sendMessage=async p=>{if(p.chat_id===OWNER_ID)throw {code,parameters:{retry_after:5}};return {message_id:1};};
  await submit(f,1,'@example_jobs');const [row]=await f.store.records('source_idea');assert.equal(row.notice,code===429?'pending':'uncertain');
  let sent=0;f.api.sendMessage=async()=>{sent++;return {message_id:1};};await notifySourceIdeas(f.store,f.api);assert.equal(sent,0);
  if(code===429){await f.store.record('source_idea','example_jobs',{...row,notice_after:0});await Promise.all([notifySourceIdeas(f.store,f.api),notifySourceIdeas(f.store,f.api)]);assert.equal(sent,1);}
 }
});
test('the pending-source cap remains atomic for simultaneous proposals from different users',async()=>{
 const f=await fixture();for(let i=0;i<99;i++)await f.store.record('source_idea','seed'+String(i).padStart(4,'0'),{state:'pending',notice:'sent'});
 await Promise.all([submit(f,1,'@alpha_jobs'),submit(f,2,'@bravo_jobs')]);
 assert.equal((await f.store.records('source_idea')).length,100);
});
