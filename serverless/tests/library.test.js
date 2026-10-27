import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,callback,message,job } from './fixtures.js';
import { Store } from '../tgcloud/lib/store.js';
import { notifyOne } from '../tgcloud/lib/admin.js';
const last=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
test('four-item home groups favorites and hidden; duplicate sources save as one vacancy',async()=>{
 const f=await fixture();await handle(f,message(1,'/start'));assert.equal(last(f).reply_markup.inline_keyboard.flat().length,4);
 assert(last(f).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='library'));
 await f.store.putJob(job(1),true);await f.store.putJob(job(2,{url:job(1).url+'?utm_source=copy'}),true);
 await handle(f,callback(1,'favorite:add:2'));await handle(f,callback(1,'favorite:add:1'));
 assert.deepEqual(await f.store.favoriteIds(1),[1]);
 await handle(f,callback(1,'library'));assert.match(last(f).reply_markup.inline_keyboard[0][0].text,/Избранные · 1/);
 await handle(f,callback(1,'actions:2:-1:s'));assert(last(f).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='favorite:remove:2'));
 await handle(f,callback(1,'favorite:remove:2'));assert.deepEqual(await f.store.favoriteIds(1),[]);
});
test('a failed response replay cannot restore a favorite removed by a newer update',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await f.store.ensure(1,1);
 const saved=callback(1,'favorite:add:1'),edit=f.api.editMessageText;
 f.api.editMessageText=async()=>{throw {code:503};};await assert.rejects(handle(f,saved));
 assert.deepEqual(await f.store.favoriteIds(1),[1]);f.api.editMessageText=edit;
 await handle(f,callback(1,'favorite:remove:1'));await handle(f,saved);
 assert.deepEqual(await f.store.favoriteIds(1),[]);
 assert.match(last(f).text,/с тех пор изменилось/);
});
test('favorites remain personal across workers/restarts and leave filters and notification delivery unchanged',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await f.store.ensure(1,1);await f.store.ensure(2,2);
 await f.store.patch(1,{notifications:'instant',notifications_after_id:0,keywords:['повар']});
 const before=(await f.store.user(1)).settings;
 await Promise.all(Array.from({length:10},(_,i)=>f.store.setFavorite(1,[1],true,'parallel'+i)));
 assert.deepEqual(await new Store(f.db).favoriteIds(1),[1]);assert.deepEqual(await f.store.favoriteIds(2),[]);
 assert.deepEqual((await f.store.user(1)).settings,before);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,1);assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await handle(f,callback(2,'favorites:show:1'));assert.match(last(f).text,/нет в вашем избранном/);
 await f.store.deleteUser(1);assert.deepEqual(await f.store.favoriteIds(1),[]);
});
test('legacy saved IDs survive, unavailable favorites stay labelled and cannot bypass moderation',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await f.store.importRows('favorites',[{user_id:1,job_id:1},{user_id:1,job_id:999}]);
 await f.store.ensure(1,1);await f.store.patch(1,{hidden_jobs:[999]});await handle(f,callback(1,'library'));assert.match(last(f).reply_markup.inline_keyboard[1][0].text,/Скрытые · 1/);
 await f.store.record('moderation','1',{ids:[1],blocked:true});
 await handle(f,callback(1,'favorites:0'));assert.match(last(f).text,/недоступна/);
 await handle(f,callback(1,'favorites:show:1'));assert.match(last(f).text,/закрыто, снято/);assert(!last(f).reply_markup.inline_keyboard.flat().some(b=>b.url));
 await handle(f,callback(1,'favorite:add:1'));assert.match(last(f).text,/сейчас недоступна/);
 await handle(f,callback(1,'favorite:remove:999'));assert.deepEqual(await f.store.favoriteIds(1),[1]);
});
test('favorites cap is atomic and removing a favorite frees capacity',async()=>{
 const f=await fixture();for(let i=1;i<=199;i++)await f.store.setFavorite(1,[i],true,'seed'+i);
 const result=await Promise.all([f.store.setFavorite(1,[200],true,'a'),f.store.setFavorite(1,[201],true,'b')]);
 assert.equal(result.filter(Boolean).length,1);assert.equal((await f.store.favoriteIds(1)).length,200);
 await f.store.setFavorite(1,[1],false,'remove');assert.equal(await f.store.setFavorite(1,[202],true,'next'),true);
});
test('failure writing a favorite replay receipt rolls the whole save back',async()=>{
 const f=await fixture();
 await f.db.run("CREATE TRIGGER reject_favorite_action BEFORE INSERT ON sjc_records WHEN NEW.kind='favorite_action' BEGIN SELECT RAISE(ABORT,'receipt unavailable'); END");
 await assert.rejects(f.store.setFavorite(1,[1],true,'failed'),/receipt unavailable/);
 assert.deepEqual(await f.store.favoriteIds(1),[]);
});
