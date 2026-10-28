import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../tgcloud/lib/bot.js';
import { defaults,settings } from '../tgcloud/lib/filters.js';
import { discoverySession,replayDiscovery } from '../tgcloud/lib/discovery.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';
import { fixture,job,handle,message,callback } from './fixtures.js';

const panel=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const state=async f=>(await f.store.user(1)).settings;
const current=async f=>(await state(f)).discovery_current;
const expired=f=>assert.match(panel(f).text,/подборка устарела или условия поиска изменились/);
async function replay(f) {
  const bot=new Bot(f);bot.uid=1;bot.chat=1;bot.mid=1;bot.s=settings(await state(f));
  return replayDiscovery(bot);
}
async function seed() {
  const f=await fixture();
  await f.store.putJob(job(1,{title:'Повар Белграда',languages:['ru'],description:'Для получения работы необходимо заплатить предоплату 100 евро.'}),true);
  await f.store.putJob(job(2,{title:'Kuvar Белграда',languages:['ru'],description:'Готовить обеды в ресторане.'}),true);
  await f.store.putJob(job(3,{title:'Повар Нови-Сада',languages:['ru'],location:'Novi Sad'}),true);
  await handle(f,message(1,'/start'));
  return f;
}

test('changed main filters expire old result actions, warnings and replay',async()=>{
  const f=await seed();await handle(f,callback(1,'choose:city:belgrade:1'));
  await handle(f,callback(1,'search:0'));const token=await current(f);
  // /start creates another menu while the earlier result message can remain.
  await handle(f,message(1,'/start'));
  await handle(f,callback(1,'choose:city:any:1'));await handle(f,callback(1,'choose:city:novi_sad:1'));
  let translated=0;f.fetch=async()=>{translated++;throw Error('Unexpected translation');};
  for(const action of ['show','details','translate','hide','actions','new','all']) {
    await handle(f,callback(1,`discover:${token}:1:0:${action}:s`));expired(f);
  }
  for(const action of [`risk:1:${token}:0:s`]) {
    await handle(f,callback(1,action));expired(f);
  }
  await replay(f);expired(f);
  assert.equal(translated,0);assert.deepEqual((await state(f)).hidden_jobs,[]);
  assert.equal(discoverySession(await state(f),token),undefined);
  assert(panel(f).reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='search:0'));
  await handle(f,callback(1,'search:0'));assert.match(panel(f).text,/Повар Нови-Сада/);
  assert(!panel(f).text.includes('Повар Белграда'));
});

test('stale scoped complaint cannot record or notify the owner',async()=>{
  const f=await seed();await handle(f,callback(1,'search:0'));const token=await current(f);
  await handle(f,callback(1,'choose:city:novi_sad:1'));
  for(const reason of ['choose','not_job']) {
    await handle(f,callback(1,`report:1:${reason}:0:s:${token}`));expired(f);
  }
  assert.deepEqual(await f.store.records('report'),[]);
  assert.deepEqual((await state(f)).hidden_jobs,[]);
  assert.equal(f.api.sent.filter(p=>p.chat_id===OWNER_ID).length,0);
});

test('saved sessions use their own filters and survive main, name, notification and hidden changes',async()=>{
  const f=await seed(),filters={...defaults(),city:['belgrade']};
  await f.store.patch(1,{saved_searches:[{id:'kitchen',name:'Кухня',filters,notifications:'off'}]});
  await handle(f,callback(1,'plans:open:kitchen'));const token=await current(f);
  await handle(f,callback(1,'choose:city:novi_sad:1'));
  const saved=(await state(f)).saved_searches;
  await f.store.patch(1,{hidden_jobs:[2],notifications:'instant',saved_searches:saved.map(p=>({...p,name:'Новая кухня',notifications:'instant'}))});
  await handle(f,callback(1,`discover:${token}:1:0:details:s`));
  assert.match(panel(f).text,/Поиск: Новая кухня/);assert.match(panel(f).text,/Повар Белграда/);
  assert.equal(discoverySession(await state(f),token)?.scope,'kitchen');
  await replay(f);assert.match(panel(f).text,/Повар Белграда/);
  await handle(f,callback(1,`report:1:choose:0:s:${token}`));assert.match(panel(f).text,/Выберите причину/);
  const changed=(await state(f)).saved_searches.map(p=>({...p,filters:{...p.filters,city:['novi_sad']}}));
  await f.store.patch(1,{saved_searches:changed});
  await handle(f,callback(1,`discover:${token}:1:0:show:s`));expired(f);
  await handle(f,callback(1,`report:1:not_job:0:s:${token}`));expired(f);
  assert.deepEqual(await f.store.records('report'),[]);
  await replay(f);expired(f);
});

test('equivalent filter order keeps main and saved session callbacks valid',async()=>{
  for(const scope of ['main','kitchen']) {
    const f=await seed(),filters={...defaults(),city:['belgrade','novi_sad'],remote:['office','only'],language:['russian','english'],keywords:['повар','chef'],exclusions:['intern','стажёр']};
    if(scope==='main')await f.store.patch(1,filters);
    else await f.store.patch(1,{saved_searches:[{id:scope,name:'Кухня',filters,notifications:'off'}]});
    await handle(f,callback(1,scope==='main'?'search:0':`plans:open:${scope}`));const token=await current(f);
    const reordered=Object.fromEntries(Object.entries(filters).map(([key,value])=>[key,Array.isArray(value)?[...value].reverse():value]));
    if(scope==='main')await f.store.patch(1,reordered);
    else await f.store.patch(1,{saved_searches:(await state(f)).saved_searches.map(p=>({...p,filters:reordered}))});
    await handle(f,callback(1,`discover:${token}:1:0:details:s`));assert.match(panel(f).text,/Повар Белграда/);
    assert.equal(discoverySession(await state(f),token)?.scope,scope);
  }
});
