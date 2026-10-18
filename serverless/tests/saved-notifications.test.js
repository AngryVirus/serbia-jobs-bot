import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job} from './fixtures.js';
import {notifyOne,notifyBatch,administer} from '../tgcloud/lib/admin.js';
import {userStatistics} from '../tgcloud/lib/analytics.js';
import {snapshotFilters,notificationPlans} from '../tgcloud/lib/searches.js';
import {Store} from '../tgcloud/lib/store.js';

const saved=(id,filters={},extra={})=>({id,name:`Поиск ${id}`,filters:snapshotFilters(filters),notifications:'instant',notifications_after_id:0,last_viewed_id:null,...extra});
async function subscribe(f,plans,fields={},uid=1){await f.store.ensure(uid,uid);await f.store.patch(uid,{notifications:'off',saved_searches:plans,...fields});}
const cli=(f,operation,fields={})=>administer({operation,...fields},{ownerRun:true},f);

test('three saved searches deliver independently while main notifications and unrelated current filters are off',async()=>{
 const f=await fixture();
 await subscribe(f,[saved('cook',{keywords:['повар'],city:['belgrade']}),saved('waiter',{keywords:['официант'],city:['novi_sad']}),saved('remote',{remote:['only']})],{keywords:['несуществующее'],city:['nis']});
 await f.store.putJob(job(1),true);
 await f.store.putJob(job(2,{title:'Официант',description:'Нужен официант.',location:'Novi Sad'}),true);
 await f.store.putJob(job(3,{title:'Разработчик',description:'Разработка приложений.',remote:true}),true);
 await f.store.putJob(job(4,{title:'Водитель',description:'Грузовые перевозки.'}),true);
 for(let i=0;i<3;i++)assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 assert.equal((await notifyOne(f.store,f.api,1)).done,true);
 assert.equal(f.api.sent.length,3);
 assert.match(f.api.sent[0].text,/Поиск cook/);assert.match(f.api.sent[1].text,/Поиск waiter/);assert.match(f.api.sent[2].text,/Поиск remote/);
 assert.equal((await f.store.user(1)).settings.notifications,'off');
});

test('initializing a saved baseline skips history only for that plan and retains ready main delivery',async()=>{
 const f=await fixture();await f.store.putJob(job(10),true);
 await subscribe(f,[saved('fresh',{}, {notifications_after_id:null})],{notifications:'instant',notifications_after_id:0});
 assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 let s=(await f.store.user(1)).settings;assert.equal(s.saved_searches[0].notifications_after_id,10);assert.equal(s.notifications_after_id,0);
 await f.store.patch(1,{notifications:'off'});assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await f.store.putJob(job(11,{title:'Другая вакансия'}),true);assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 s=(await f.store.user(1)).settings;assert.equal(s.saved_searches[0].notifications_after_id,10);
});

test('initializing a main baseline does not swallow a ready saved search and missing saved baselines survive restart',async()=>{
 const f=await fixture();await f.store.putJob(job(7),true);
 await subscribe(f,[saved('ready'),saved('new',{}, {notifications_after_id:null})],{notifications:'instant',notifications_after_id:null});
 assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 const s=(await f.store.user(1)).settings;assert.equal(s.notifications_after_id,7);assert.equal(s.saved_searches[0].notifications_after_id,0);assert.equal(s.saved_searches[1].notifications_after_id,7);
 assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,0);
});

test('overlapping searches matching different copies send one group and escape saved names',async()=>{
 const f=await fixture();await subscribe(f,[saved('b',{city:['belgrade']},{name:'<Белград & работа>'}),saved('n',{city:['novi_sad']})]);
 const url='https://radim.rs/jobs/777';
 await f.store.putJob(job(1,{url,source:'radim'}),true);
 await f.store.putJob(job(2,{url:'https://t.me/radim_serbia/777',source:'tg_radim_serbia',location:'Novi Sad',description:`Подробнее и откликнуться: ${url}`}),true);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
 assert.match(f.api.sent[0].text,/&lt;Белград &amp; работа&gt;/);assert.match(f.api.sent[0].text,/Поиск n/);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 const rows=await f.db.all('SELECT job_id,state FROM sjc_deliveries');assert.equal(rows.length,1);assert.equal(rows[0].state,'sent');
});

test('saved baselines and shared hidden groups prevent old reposts or hidden deliveries',async()=>{
 const f=await fixture();const url='https://t.me/rabotavserbii/888';
 await f.store.putJob(job(1,{url}),true);await subscribe(f,[saved('fresh',{}, {notifications_after_id:1})]);
 await f.store.putJob(job(2,{url,source:'tg_radim_serbia'}),true);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await f.store.putJob(job(3,{title:'Новая вакансия'}),true);await f.store.patch(1,{hidden_jobs:[3]});
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await f.store.patch(1,{hidden_jobs:[]});assert.equal((await notifyOne(f.store,f.api,1)).sent,1);
});

test('turning off or deleting a saved search and deleting the profile cancel future delivery',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);await subscribe(f,[saved('cook',{}, {notifications:'off'})]);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await f.store.patch(1,{saved_searches:[]});assert.equal((await notifyOne(f.store,f.api,1)).sent,0);
 await f.store.patch(1,{saved_searches:[saved('cook')]});await f.store.deleteUser(1);
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);assert.equal(f.api.sent.length,0);
});

test('saved-only subscriptions are counted once, included in workers and share one prepared catalog',async()=>{
 const f=await fixture();await f.store.putJob(job(1),true);
 await subscribe(f,[saved('a'),saved('b')]);await subscribe(f,[saved('c')],{},2);
 await f.store.ensure(3,3);await f.store.patch(3,{saved_searches:[saved('off',{}, {notifications:'off'})]});
 await f.store.ensure(4,4);await f.store.patch(4,{notifications:'instant',notifications_after_id:0});
 assert.equal((await userStatistics(f.store)).subscribed,3);
 assert.deepEqual((await cli(f,'subscribers')).ids,[1,2,4]);
 let scans=0;const jobs=f.store.jobs.bind(f.store);f.store.jobs=async()=>{scans++;return jobs();};
 assert.equal((await notifyBatch(f.store,f.api,10)).sent,3);
 assert.equal(scans,1);assert.deepEqual(f.api.sent.map(p=>p.chat_id),[1,2,4]);
});

test('parallel saved delivery, retry_after and ambiguous failures preserve global deduplication',async()=>{
 const f=await fixture();await subscribe(f,[saved('a'),saved('b')]);await f.store.putJob(job(1),true);
 f.api.sendMessage=async()=>{throw {code:429,parameters:{retry_after:12}};};
 const results=await Promise.all([notifyOne(f.store,f.api,1),notifyOne(new Store(f.db),f.api,1)]);
 assert(results.some(result=>result.retry_after===12));assert(results.some(result=>result.busy));
 assert.equal((await f.db.all('SELECT * FROM sjc_deliveries')).length,0);
 let sends=0;f.api.sendMessage=async()=>{sends++;return {message_id:41};};
 assert.equal((await notifyOne(f.store,f.api,1)).sent,0);assert.equal(sends,0);
 await f.store.setMeta('notification_cooldown',0);
 const retried=await Promise.all([notifyOne(f.store,f.api,1),notifyOne(new Store(f.db),f.api,1)]);
 assert.equal(retried.reduce((n,result)=>n+result.sent,0),1);assert.equal(sends,1);
 await f.store.putJob(job(2,{title:'Другая вакансия'}),true);f.api.sendMessage=async()=>{sends++;throw new Error('timeout after Telegram accepted message');};
 assert.equal((await notifyOne(f.store,f.api,1)).uncertain,true);
 assert.equal((await notifyOne(new Store(f.db),f.api,1)).sent,0);assert.equal(sends,2);
});

test('403 disables saved subscriptions too, while paused, banned and newly moderated users receive none',async()=>{
 const f=await fixture();await subscribe(f,[saved('a')]);await f.store.putJob(job(1),true);
 await f.store.setMeta('active',false);assert.equal((await notifyOne(f.store,f.api,1)).paused,true);
 await f.store.setMeta('active',true);await f.store.record('user_ban','1',{uid:1,active:true});assert.equal((await notifyOne(f.store,f.api,1)).banned,true);
 await f.store.record('user_ban','1',{uid:1,active:false});
 const catalog=async()=>{const {groupJobs}=await import('../tgcloud/lib/catalog.js');const groups=groupJobs(await f.store.jobs());await f.store.record('moderation','job:1',{blocked:true,ids:[1]});return groups;};
 assert.equal((await notifyOne(f.store,f.api,1,catalog)).sent,0);assert.equal(f.api.sent.length,0);
 await f.store.record('moderation','job:1',{blocked:false,ids:[1]});f.api.sendMessage=async()=>{throw {code:403,description:'bot was blocked by the user'};};
 assert.equal((await notifyOne(f.store,f.api,1)).blocked,true);
 assert.equal(notificationPlans((await f.store.user(1)).settings).length,0);assert.equal((await userStatistics(f.store)).subscribed,0);
});
