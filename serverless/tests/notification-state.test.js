import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,callback,job } from './fixtures.js';
import { notificationState } from '../tgcloud/lib/notification-state.js';
import { administer,notifyOne } from '../tgcloud/lib/admin.js';
import { OWNER_ID } from '../tgcloud/lib/permissions.js';

test('opening notifications from the four-item menu does not toggle or reset a subscription',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.patch(1,{notifications:'instant',notifications_after_id:4});
 await handle(f,callback(1,'menu'));
 const buttons=f.api.edited.at(-1).reply_markup.inline_keyboard.flat();
 assert.equal(buttons.length,4);assert(buttons.some(b=>b.callback_data==='preferences'));
 assert(!buttons.some(b=>b.callback_data==='notify:off'));
 await handle(f,callback(1,'notifications'));
 assert.equal((await f.store.user(1)).settings.notifications,'instant');
 assert.equal((await f.store.user(1)).settings.notifications_after_id,4);
 assert.match(f.api.edited.at(-1).text,/включены/);
 assert(f.api.edited.at(-1).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='notify:off'));
 await handle(f,callback(1,'notify:off'));assert.equal((await f.store.user(1)).settings.notifications,'off');
});

test('new since viewing can already be delivered; diagnostics deduplicate copies and never send',async t=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.patch(1,{notifications:'instant',notifications_after_id:1});
 for(const id of [1,2,3,4])await f.store.putJob(job(id),true);
 await f.store.putJob(job(5,{url:job(2).url+'?utm_source=copy'}),true);
 await f.store.importRows('deliveries',[{user_id:1,job_id:2}]);
 await f.db.run("INSERT INTO sjc_deliveries VALUES(1,3,'uncertain',:p)",{':p':'{}'});
 t.mock.method(f.db,'run',()=>assert.fail('read-only diagnostics wrote data'));
 const s=await notificationState(f.store,1);
 assert.equal(s.matching,4);assert.equal(s.new_since_enabled,3);assert.equal(s.already_sent,1);
 assert.equal(s.unconfirmed,1);assert.equal(s.pending,1);assert.equal(f.api.sent.length,0);
 assert(!JSON.stringify(s).includes('user_id'));
});

test('saved-plan boundaries, paused delivery, and uninitialized legacy subscriptions remain distinct',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.putJob(job(1),true);
 await f.store.patch(1,{notifications:'instant',notifications_after_id:null,saved_searches:[{id:'saved',name:'Private query name',filters:{},notifications:'instant',notifications_after_id:0}]});
 await f.store.setMeta('notification_cooldown',Date.now()+60000);
 const s=await notificationState(f.store,1);
 assert.equal(s.uninitialized_plans,1);assert.equal(s.saved_enabled,1);assert.equal(s.pending,1);
 assert(s.cooldown_seconds>0);assert(!JSON.stringify(s).includes('Private query name'));
});

test('owner CLI diagnostics require trusted context and accept no target user override',async()=>{
 const f=await fixture();await f.store.ensure(OWNER_ID,OWNER_ID);await f.store.ensure(2,2);
 await f.store.patch(2,{notifications:'instant'});
 for(const ctx of [{},{ownerRun:true,update:{}},{ownerRun:true,initData:'forged'}])await assert.rejects(administer({operation:'owner_notification_check'},ctx,f),/Owner CLI/);
 const r=await administer({operation:'owner_notification_check',user_id:2},{ownerRun:true},f);
 assert.equal(r.current_enabled,false);assert.equal(f.api.sent.length,0);
});

test('a new matching vacancy is delivered once even when it remains new since viewing',async()=>{
 const f=await fixture();await f.store.ensure(1,1);await f.store.patch(1,{notifications:'instant',notifications_after_id:0});
 await f.store.putJob(job(1),true);
 assert.equal((await notificationState(f.store,1)).pending,1);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 const state=await notificationState(f.store,1);assert.equal(state.pending,0);assert.equal(state.already_sent,1);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
});
