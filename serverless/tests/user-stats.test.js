import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,callback,message,handle,job } from './fixtures.js';
import { activity,deliveryForbidden,userStatistics } from '../tgcloud/lib/analytics.js';
import { notifyOne } from '../tgcloud/lib/admin.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';

test('unique users, UTC activity windows, registration dates, legacy profiles and empty database',async()=>{
 const f=await fixture(),now=Date.parse('2026-10-18T12:00:00Z');
 assert(Object.values(await userStatistics(f.store,now)).every(n=>n===0));
 for(let uid=1;uid<=4;uid++){
  const u=await f.store.ensure(uid,uid);u.created_at=new Date(now-(uid-1)*10*86400000).toISOString();await f.store.saveUser(u);
 }
 await Promise.all(Array.from({length:25},()=>activity(f.store,1,now)));
 await activity(f.store,2,now-6*86400000);await activity(f.store,3,now-30*86400000);
 await f.store.patch(1,{notifications:'instant'});
 const s=await userStatistics(f.store,now);
 assert.equal(s.total,4);assert.equal(s.observed,3);assert.equal(s.active_today,1);assert.equal(s.active_week,2);assert.equal(s.active_month,2);
 assert.equal(s.new_today,1);assert.equal(s.new_week,1);assert.equal(s.new_month,3);assert.equal(s.subscribed,1);
 await f.store.deleteUser(1);assert.equal((await userStatistics(f.store,now)).total,3);
});
test('403 reasons are distinct, repeated concurrent receipts are idempotent and real return clears current status',async()=>{
 const f=await fixture();for(let uid=1;uid<=4;uid++)await f.store.ensure(uid,uid);
 await Promise.all(Array.from({length:20},()=>deliveryForbidden(f.store,1,{code:403,description:'Forbidden: bot was blocked by the user'})));
 await deliveryForbidden(f.store,2,{code:403,message:'Forbidden: user is deactivated'});
 await deliveryForbidden(f.store,3,{code:403,description:'Forbidden: other reason, sensitive raw text'});
 await f.store.patch(4,{bot_blocked:true}); // Older version did not store an exact reason.
 await deliveryForbidden(f.store,4,{code:429});
 let s=await userStatistics(f.store);assert.equal(s.unavailable,4);assert.equal(s.blocked,1);assert.equal(s.deactivated,1);assert.equal(s.ever_blocked,1);
 assert(!JSON.stringify(await f.store.user(3)).includes('sensitive raw text'));
 await handle(f,message(1,'/start'));s=await userStatistics(f.store);
 assert.equal(s.unavailable,3);assert.equal(s.blocked,0);assert.equal(s.ever_blocked,1);
 await f.store.deleteUser(1);assert.equal((await userStatistics(f.store)).ever_blocked,0);
});
test('vacancy worker records confirmed blocks without sending again or changing advertising preferences',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.patch(1,{notifications:'instant',notifications_after_id:0});await f.store.putJob(job(1),true);
 let sends=0;f.api.sendMessage=async()=>{sends++;throw {code:403,description:'Forbidden: bot was blocked by the user'};};
 await Promise.all([notifyOne(f.store,f.api,1),notifyOne(f.store,f.api,1)]);await notifyOne(f.store,f.api,1);
 assert.equal(sends,1);const s=await userStatistics(f.store);assert.equal(s.blocked,1);assert.equal(s.subscribed,0);
 assert.equal((await f.store.user(1)).settings.bot_blocked,true);
});
test('all statistics subpages require both numeric owner and private owner chat',async()=>{
 const f=await fixture();
 for(const action of ['admin:stats','admin:stats:usage','admin:stats:delivery']){
  for(const [uid,chat] of [[1,OWNER_ID],[OWNER_ID,1],[OWNER_ID,-100]]){
   const edited=f.api.edited.length,sent=f.api.sent.length;
   const u=callback(uid,action);u.callback_query.message.chat.id=chat;await handle(f,u);
   assert.equal(f.api.edited.length,edited);assert.equal(f.api.sent.length,sent);
  }
  await handle(f,callback(1,action));assert.match(f.api.edited.at(-1).text,/только владельцу/);
  await handle(f,callback(OWNER_ID,action));assert.doesNotMatch(f.api.edited.at(-1).text,/только владельцу/);
 }
});
