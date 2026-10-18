import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, job } from './fixtures.js';
import { settings } from '../tgcloud/lib/filters.js';
import { MAX_SEARCHES, notificationPlans, replaySearches, savedSearches, searchInput, searchRoute, snapshotFilters } from '../tgcloud/lib/searches.js';

let update=0;
async function context(uid=812) {
  const f=await fixture();await f.store.ensure(uid,uid);
  return { ...f,uid,chat:uid,s:settings((await f.store.user(uid)).settings),panels:[],opened:[],
    async patch(fields){this.s=await this.store.patch(this.uid,fields);},
    async patchInput(fields,screen){this.s=await this.store.patchInput(this.uid,fields,this.updateKey,screen);},
    async panel(text,rows){this.panels.push({text,rows});},
    async showPlan(id,fresh=false){this.opened.push({id,fresh});},
  };
}
async function route(bot,action){bot.updateKey=`searches:${++update}`;await searchRoute(bot,action);}
async function input(bot,text){bot.updateKey=`searches:${++update}`;return searchInput(bot,{text});}
async function create(bot,name){await route(bot,'plans:create');assert.equal(await input(bot,name),true);return savedSearches(bot.s).at(-1);}
const buttons=bot=>bot.panels.at(-1).rows.flat();
const callback=bot=>buttons(bot).map(button=>button.callback_data);

test('saved snapshots copy only supported filtering preferences and never private service state',()=>{
  const source={city:['belgrade'],keywords:['повар'],hidden_jobs:[14],notifications:'instant',notifications_after_id:200,pending_input:'ban_reason',ban_draft:{reason:'private'},staff_draft:{uid:1},telegram_username:'private'};
  const copy=snapshotFilters(source);
  assert.deepEqual(Object.keys(copy).sort(),['city','currency','exclusions','freshness','include_unknown_salary','keywords','language','min_salary','remote','residence_permit'].sort());
  assert.deepEqual(copy.city,['belgrade']);assert.deepEqual(copy.keywords,['повар']);
  source.city.push('nis');source.keywords[0]='водитель';
  assert.deepEqual(copy.city,['belgrade']);assert.deepEqual(copy.keywords,['повар']);
  assert.deepEqual(snapshotFilters({city:['unknown'],min_salary:-10,currency:'USD'}).city,['any']);
  assert.equal(snapshotFilters({min_salary:-10}).min_salary,null);
});

test('three independently named snapshots can be saved; the fourth and duplicate names are rejected',async()=>{
  const bot=await context();
  await bot.patch({keywords:['повар'],city:['belgrade'],notifications:'instant',notifications_after_id:99});
  const first=await create(bot,'Повар в Белграде');
  assert.match(first.id,/^[a-z0-9]{1,12}$/);assert.equal(first.notifications,'off');assert.equal(first.last_viewed_id,null);
  await bot.patch({keywords:['водитель'],city:['nis']});
  await route(bot,'plans:create');await input(bot,'  ПОВАР   В БЕЛГРАДЕ  ');
  assert.equal(savedSearches(bot.s).length,1);assert.match(bot.panels.at(-1).text,/названием уже есть/);
  const second=await input(bot,'Водитель');assert.equal(second,true);
  await create(bot,'Без опыта');
  assert.equal(savedSearches(bot.s).length,MAX_SEARCHES);
  assert.deepEqual(savedSearches(bot.s)[0].filters.keywords,['повар']);assert.deepEqual(savedSearches(bot.s)[0].filters.city,['belgrade']);
  await route(bot,'plans:create');assert.equal(savedSearches(bot.s).length,3);assert.match(bot.panels.at(-1).text,/не более трёх/);
  assert.equal(bot.s.notifications,'instant');assert.equal(bot.s.notifications_after_id,99);
});

test('rename and filter loading retain independent notification baselines, hidden jobs and viewed markers',async()=>{
  const bot=await context(),first=await create(bot,'Мой поиск');
  await bot.patch({saved_searches:[{...first,notifications:'instant',notifications_after_id:17,last_viewed_id:20}],keywords:['старая настройка'],city:['nis'],hidden_jobs:[14],notifications:'instant',notifications_after_id:88});
  await route(bot,`plans:rename:${first.id}`);await input(bot,'Новое название');
  const renamed=savedSearches(bot.s)[0];assert.equal(renamed.name,'Новое название');assert.equal(renamed.notifications_after_id,17);assert.equal(renamed.last_viewed_id,20);
  await route(bot,`plans:load:${first.id}`);
  assert.deepEqual(bot.s.keywords,[]);assert.deepEqual(bot.s.city,['any']);assert.deepEqual(bot.s.hidden_jobs,[14]);
  assert.equal(bot.s.notifications,'instant');assert.equal(bot.s.notifications_after_id,88);
  assert.equal(savedSearches(bot.s)[0].notifications_after_id,17);assert.equal(savedSearches(bot.s)[0].last_viewed_id,20);
  await route(bot,`plans:open:${first.id}`);await route(bot,`plans:new:${first.id}`);
  assert.deepEqual(bot.opened,[{id:first.id,fresh:false},{id:first.id,fresh:true}]);
});

test('saved notification toggles use explicit states and individual activation baselines',async()=>{
  const bot=await context();await bot.patch({notifications:'instant',notifications_after_id:2,hidden_jobs:[4]});
  const first=await create(bot,'Первый'),second=await create(bot,'Второй');
  await bot.store.putJob(job(5),true);
  await route(bot,`plans:notify:${first.id}:instant`);
  await bot.store.putJob(job(6),true);
  await route(bot,`plans:notify:${second.id}:instant`);
  assert.deepEqual(notificationPlans(bot.s).map(plan=>[plan.id,plan.after_id]),[['main',2],[first.id,5],[second.id,6]]);
  assert.ok(notificationPlans(bot.s).every(plan=>plan.filters.hidden_jobs[0]===4));
  await bot.store.putJob(job(7),true);
  await route(bot,`plans:notify:${first.id}:instant`);
  assert.equal(savedSearches(bot.s)[0].notifications_after_id,5,'repeat enable must not skip newly discovered jobs');
  await route(bot,`plans:notify:${first.id}:off`);
  assert.deepEqual(notificationPlans(bot.s).map(plan=>[plan.id,plan.after_id]),[['main',2],[second.id,6]]);
  await route(bot,`plans:notify:${first.id}:instant`);
  assert.equal(savedSearches(bot.s)[0].notifications_after_id,7);
  await bot.patch({notifications:'off'});
  assert.deepEqual(notificationPlans(bot.s).map(plan=>plan.id),[first.id,second.id]);
});

test('deletion needs the current confirmation and leaves current filters and other searches intact',async()=>{
  const bot=await context(),first=await create(bot,'Удалить'),second=await create(bot,'Оставить');
  await bot.patch({keywords:['текущие'],notifications:'instant',notifications_after_id:55});
  await route(bot,`plans:remove:${first.id}:forged`);assert.equal(savedSearches(bot.s).length,2);
  await route(bot,`plans:delete:${first.id}`);const stale=callback(bot).find(value=>value?.startsWith('plans:remove:'));
  await route(bot,`plans:delete:${second.id}`);
  await route(bot,stale);assert.equal(savedSearches(bot.s).length,2);
  await route(bot,`plans:delete:${first.id}`);const confirm=callback(bot).find(value=>value?.startsWith('plans:remove:'));
  await route(bot,confirm);await route(bot,confirm);
  assert.deepEqual(savedSearches(bot.s).map(saved=>saved.id),[second.id]);
  assert.deepEqual(bot.s.keywords,['текущие']);assert.equal(bot.s.notifications_after_id,55);assert.equal(bot.s.search_operation,null);
});

test('message failure after creation saves one result and a replay receipt without the entered name',async()=>{
  const bot=await context();await route(bot,'plans:create');
  bot.updateKey=`searches:${++update}`;
  const render=bot.panel;bot.panel=async()=>{throw Object.assign(new Error('retry'),{code:429});};
  await assert.rejects(searchInput(bot,{text:'Без повторов'}));
  const saved=savedSearches(bot.s);assert.equal(saved.length,1);assert.equal(bot.s.pending_input,null);
  const receipt=await bot.store.inputEffectStatus(bot.uid,bot.updateKey);
  assert.equal(receipt.status,'applied');assert.equal(receipt.effect.screen,'plans');assert.ok(!JSON.stringify(receipt.effect).includes('Без повторов'));
  bot.panel=render;await searchRoute(bot,'plans');
  assert.equal(savedSearches(bot.s).length,1);assert.ok(bot.panels.at(-1).rows.flat().some(button=>button.callback_data===`plans:view:${saved[0].id}`));
});

test('bad input is rejected and stale or deleted search references cannot create a replacement',async()=>{
  const bot=await context();await route(bot,'plans:create');
  for(const value of ['', 'x'.repeat(41), 'Имя\u200b']){await input(bot,value);assert.equal(savedSearches(bot.s).length,0);assert.equal(bot.s.pending_input,'search_name');}
  assert.equal(await searchInput(bot,{text:'/cancel'}),false);assert.equal(await searchInput(bot,{photo:[{}]}),false);
  await bot.patch({search_operation:{type:'rename',id:'deleted'}});await input(bot,'Не создавать');
  assert.equal(savedSearches(bot.s).length,0);assert.equal(bot.s.pending_input,null);
  await route(bot,'plans:notify:unknown:instant');assert.equal(savedSearches(bot.s).length,0);
  await route(bot,'plans:remove:unknown:token');assert.equal(savedSearches(bot.s).length,0);
});

test('replay renders the committed name prompt or deletion token without another state change',async()=>{
  const bot=await context();await route(bot,'plans:create');
  const original=JSON.stringify((await bot.store.user(bot.uid)).settings);
  await replaySearches(bot);assert.match(bot.panels.at(-1).text,/Название поиска/);
  assert.equal(JSON.stringify((await bot.store.user(bot.uid)).settings),original);
  const first=await input(bot,'С подтверждением');assert.equal(first,true);
  const id=savedSearches(bot.s)[0].id;await route(bot,`plans:view:${id}`);
  assert.ok(!callback(bot).includes(`plans:new:${id}`),'new-only action stays hidden until the first view');
  await bot.patch({saved_searches:savedSearches(bot.s).map(saved=>({...saved,last_viewed_id:0}))});
  await route(bot,`plans:view:${id}`);assert.ok(!callback(bot).includes(`plans:new:${id}`),'new-only entry belongs inside search results');
  await route(bot,`plans:delete:${id}`);const operation=structuredClone(bot.s.search_operation),before=JSON.stringify((await bot.store.user(bot.uid)).settings);
  await replaySearches(bot);assert.ok(callback(bot).includes(`plans:remove:${id}:${operation.token}`));
  assert.deepEqual(bot.s.search_operation,operation);assert.equal(JSON.stringify((await bot.store.user(bot.uid)).settings),before);
});

test('legacy settings preserve their main subscription, while malformed saved data is ignored safely',async()=>{
  assert.deepEqual(notificationPlans({notifications:'daily',keywords:['повар']}),[{id:'main',name:'Текущие фильтры',filters:{...snapshotFilters({keywords:['повар']}),hidden_jobs:[]},after_id:null}]);
  const valid={id:'first',name:'<Поиск>',filters:{city:['belgrade']},notifications:'instant',notifications_after_id:9,last_viewed_id:10};
  const raw={saved_searches:[null,{...valid,id:'main'},{...valid,id:'a:b'},{...valid,name:''},valid,{...valid,name:'Дубликат'},...Array.from({length:5},(_,index)=>({...valid,id:'ok'+index}))]};
  const result=savedSearches(raw);assert.equal(result.length,3);assert.equal(result[0].name,'<Поиск>');assert.equal(result[0].notifications_after_id,9);
  const bot=await context();await bot.patch({saved_searches:[valid]});await route(bot,'plans:view:first');
  assert.match(bot.panels.at(-1).text,/&lt;Поиск&gt;/);
  await route(bot,'plans:more:first');assert.ok(!callback(bot).includes('plans:open:first'));
  await route(bot,'plans:delete:first');
  assert.ok(bot.panels.flatMap(panel=>panel.rows).flat().filter(button=>button.callback_data).every(button=>Buffer.byteLength(button.callback_data)<=64));
});

test('updating one saved snapshot requires confirmation and preserves unrelated plans and subscriptions',async()=>{
 const bot=await context(),first=await create(bot,'Первый'),second=await create(bot,'Второй');
 await bot.patch({saved_searches:savedSearches(bot.s).map(s=>({...s,notifications:'instant',notifications_after_id:3,last_viewed_id:5})),notifications:'instant',notifications_after_id:2,keywords:['водитель'],discovery_sessions:[{token:'oldscope',scope:first.id},{token:'otherone',scope:second.id}],discovery_current:'oldscope'});
 await bot.store.putJob(job(10),true);await route(bot,`plans:update:${first.id}`);const operation=structuredClone(bot.s.search_operation);
 assert.deepEqual(savedSearches(bot.s)[0].filters.keywords,[]);await replaySearches(bot);assert.ok(callback(bot).includes(`plans:replace:${first.id}:${operation.token}`));
 await route(bot,`plans:replace:${first.id}:wrong`);assert.deepEqual(savedSearches(bot.s)[0].filters.keywords,[]);
 await route(bot,`plans:replace:${first.id}:${operation.token}`);let plans=savedSearches(bot.s);
 assert.deepEqual(plans[0].filters.keywords,['водитель']);assert.equal(plans[0].name,'Первый');assert.equal(plans[0].notifications,'instant');assert.equal(plans[0].notifications_after_id,10);assert.equal(plans[0].last_viewed_id,null);
 assert.equal(plans[1].notifications_after_id,3);assert.equal(plans[1].last_viewed_id,5);assert.equal(bot.s.notifications_after_id,2);assert.deepEqual(bot.s.discovery_sessions,[{token:'otherone',scope:second.id}]);assert.equal(bot.s.discovery_current,null);
 await bot.store.putJob(job(11),true);await route(bot,`plans:replace:${first.id}:${operation.token}`);assert.equal(savedSearches(bot.s)[0].notifications_after_id,10);
});

test('deleting a saved search clears only its own cached browsing context',async()=>{
 const bot=await context(),first=await create(bot,'Первый'),second=await create(bot,'Второй');
 await bot.patch({discovery_sessions:[{token:'mainctx1',scope:'main'},{token:'oldscope',scope:first.id}],discovery_current:'mainctx1'});
 await route(bot,`plans:delete:${first.id}`);await route(bot,`plans:remove:${first.id}:${bot.s.search_operation.token}`);
 assert.deepEqual(savedSearches(bot.s).map(s=>s.id),[second.id]);assert.deepEqual(bot.s.discovery_sessions,[{token:'mainctx1',scope:'main'}]);assert.equal(bot.s.discovery_current,'mainctx1');
});
