import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,message,callback,job } from './fixtures.js';
import { Store } from '../tgcloud/lib/store.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { notifyOne } from '../tgcloud/lib/admin.js';
import { adTick } from '../tgcloud/lib/ads.js';
const ban=(f,id)=>handle(f,callback(OWNER_ID,`admin:bans:add:${id}`));

test('owner ban UI validates IDs, previews, persists across restart and unbans idempotently',async()=>{
 const f=await fixture();await handle(f,callback(OWNER_ID,'admin:bans:new'));
 for(const value of ['@someone','-1','1.5','9999999999999999',String(OWNER_ID)]){await handle(f,message(OWNER_ID,value));assert.equal((await f.store.records('user_ban')).length,0);assert.equal((await f.store.user(OWNER_ID)).settings.pending_input,'owner_ban');}
 await handle(f,message(OWNER_ID,'777'));assert.match(f.api.sent.at(-1).text,/Забанить пользователя 777/);assert.equal(await f.store.isBanned(777),false);
 await ban(f,777);await ban(f,777);assert.equal((await f.store.records('user_ban')).length,1);
 assert.equal(await new Store(f.db).isBanned(777),true);
 await handle(f,callback(OWNER_ID,'admin:bans:0'));assert(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='admin:bans:remove:777'));
 await handle(f,callback(OWNER_ID,'admin:bans:remove:777'));await handle(f,callback(OWNER_ID,'admin:bans:remove:777'));assert.equal(await f.store.isBanned(777),false);
});
test('banned users receive zero API responses and cannot recreate profiles or remove their ban',async()=>{
 const f=await fixture();await ban(f,77);let calls=0;
 for(const method of ['sendMessage','sendPhoto','editMessageText','answerCallbackQuery'])f.api[method]=async()=>{calls++;return {message_id:1};};
 for(const text of ['/start','/delete_me','/admin','hello'])await handle(f,message(77,text));
 for(const action of ['menu','search:0','delete_confirm','admin:bans:remove:77'])await handle(f,callback(77,action));
 assert.equal(calls,0);assert.equal(await f.store.user(77),null);assert.equal(await f.store.isBanned(77),true);
 await f.store.ensure(77,77);await f.store.deleteUser(77);assert.equal(await f.store.isBanned(77),true);
 await f.store.setMeta('active',false);await handle(f,message(77,'/start'));assert.equal(calls,0);
 await f.store.setMeta('active',true);await f.db.run("DELETE FROM sjc_records WHERE kind='user_ban'");await handle(f,message(77,'/start'));assert(calls>0);
});
test('forged callbacks and pending fields cannot ban or unban; owner cannot be banned',async()=>{
 const f=await fixture();
 for(const action of ['admin:bans:0','admin:bans:new','admin:bans:add:77','admin:bans:remove:77',`admin:bans:add:${OWNER_ID}`]){
  for(const [uid,chat] of [[1,1],[1,OWNER_ID],[OWNER_ID,1]]){const u=callback(uid,action);u.callback_query.message.chat.id=chat;await handle(f,u);assert.equal(await f.store.isBanned(77),false);}
 }
 await ban(f,OWNER_ID);assert.equal(await f.store.isBanned(OWNER_ID),false);
 await f.store.patch(1,{pending_input:'owner_ban'});await handle(f,message(1,'77'));assert.equal(await f.store.isBanned(77),false);
 await ban(f,77);const forged=callback(1,'admin:bans:remove:77');forged.callback_query.message.chat.id=OWNER_ID;await handle(f,forged);assert.equal(await f.store.isBanned(77),true);
});
test('ban shares target lease with inbound updates and workers; notification settings survive',async()=>{
 const f=await fixture();await f.store.ensure(77,77);await f.store.patch(77,{notifications:'instant',notifications_after_id:0});await f.store.putJob(job(1),true);
 await f.store.lock('user:77','inflight',180);await ban(f,77);assert.equal(await f.store.isBanned(77),false);assert.match(f.api.edited.at(-1).text,/Повторите действие/);
 await f.store.unlock('user:77','inflight');await Promise.all([ban(f,77),ban(f,77).catch(()=>{})]);
 assert.equal(await f.store.isBanned(77),true);const count=f.api.sent.length;
 await Promise.all([notifyOne(f.store,f.api,77),notifyOne(f.store,f.api,77)]);assert.equal(f.api.sent.length,count);
 assert.equal((await f.store.user(77)).settings.notifications,'instant');
 await handle(f,callback(OWNER_ID,'admin:bans:remove:77'));assert.equal((await notifyOne(f.store,f.api,77)).sent,1);
});
test('advertising excludes existing bans and skips a banned queued recipient without real sends',async()=>{
 const f=await fixture();for(let i=1;i<=12;i++)await f.store.ensure(i,i);await ban(f,1);
 await handle(f,callback(OWNER_ID,'ads:new'));await handle(f,message(OWNER_ID,'Local stub only'));
 const {id}=await f.store.meta('ad_draft');await handle(f,callback(OWNER_ID,'ads:confirm:'+id));await handle(f,callback(OWNER_ID,'ads:start:'+id));
 assert(!f.api.sent.some(p=>p.chat_id===1));await ban(f,11);
 await f.store.record('ad_campaign',id,{...(await f.store.records('ad_campaign'))[0],retry_at:0});await adTick(f.store,f.api);
 assert(!f.api.sent.some(p=>p.chat_id===11));
 const row=await f.db.get("SELECT payload FROM sjc_records WHERE kind='ad_delivery' AND record_key=:key",{':key':id+':11'});
 assert.equal(JSON.parse(row.payload).state,'skipped');
});

test('ban committed between initial check and acquiring the lease prevents even callback acknowledgement',async()=>{
 const f=await fixture(),get=f.db.get.bind(f.db);let first=true,calls=0;
 f.db.get=async(sql,params)=>{const result=await get(sql,params);if(first&&sql.includes("kind='user_ban'")){first=false;await f.store.record('user_ban','77',{uid:77});}return result;};
 f.api.answerCallbackQuery=async()=>{calls++;};f.api.sendMessage=async()=>{calls++;return {message_id:1};};f.api.editMessageText=async()=>{calls++;};
 await handle(f,callback(77,'menu'));assert.equal(calls,0);assert.equal(await f.store.user(77),null);
});
