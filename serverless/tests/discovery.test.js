import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../tgcloud/lib/bot.js';
import { defaults,settings } from '../tgcloud/lib/filters.js';
import { groupJobs,visibleJobs } from '../tgcloud/lib/catalog.js';
import { openDiscovery,discoveryRoute,replayDiscovery,similarJobs } from '../tgcloud/lib/discovery.js';
import { menu,filtersPanel,cardActions,translatedCard } from '../tgcloud/lib/ui.js';
import { fixture,job,handle,message,callback as updateCallback } from './fixtures.js';

let key=0;
async function context(f,uid=1) {
  const bot=new Bot(f);bot.uid=uid;bot.chat=uid;bot.mid=1;bot.updateKey=`discovery-test:${++key}`;
  bot.s=settings((await f.store.ensure(uid,uid)).settings);return bot;
}
const panel=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const buttons=f=>panel(f).reply_markup.inline_keyboard.flat();
const data=(f,fragment)=>buttons(f).find(b=>b.text.includes(fragment))?.callback_data;
const current=async f=>(await f.store.user(1)).settings.discovery_current;
const click=async(f,action,uid=1)=>discoveryRoute(await context(f,uid),action);

test('first search keeps the home unchanged and introduces new only after a previous visit',async()=>{
  const f=await fixture();await f.store.putJob(job(1),true);
  assert.equal(menu(defaults())[1].flat().length,5);
  assert(!JSON.stringify(menu(defaults())).includes('plans'));
  assert.equal(filtersPanel(defaults())[1].flat().filter(b=>b.callback_data==='plans').length,1);
  await openDiscovery(await context(f));
  assert(!data(f,'С прошлого просмотра'));assert.equal((await f.store.user(1)).settings.last_viewed_id,1);
  await f.store.putJob(job(2),true);await openDiscovery(await context(f));
  assert(data(f,'С прошлого просмотра'));assert.match(data(f,'С прошлого просмотра'),/^discover:/);
  const next=data(f,'С прошлого просмотра');await click(f,next);
  assert.match(panel(f).text,/Новое с прошлого просмотра/);assert.match(panel(f).text,/1 из 1/);
  assert.equal((await f.store.user(1)).settings.last_viewed_id,2);
  await click(f,data(f,'Все подходящие'));assert.match(panel(f).text,/1 из 2/);
});

test('new excludes old reposts, hidden, expired, moderated and disabled-source jobs',async()=>{
  const f=await fixture();await f.store.putJob(job(1,{url:'https://example.rs/old/1'}),true);
  await openDiscovery(await context(f));
  await f.store.putJob(job(2,{url:'http://www.example.rs/old/1?utm_source=new'}),true);
  await f.store.putJob(job(3,{title:'Hidden'}),true);
  const expired=job(4);expired._cloud={...expired._cloud,expires_ms:Date.now()-1000};await f.store.putJob(expired,true);
  await f.store.putJob(job(5),true);await f.store.record('moderation','5',{blocked:true,ids:[5]});
  await f.store.putJob(job(6,{source:'telegram_python_jobs'}),true);
  await f.store.putJob(job(7,{title:'Новая работа поваром'}),true);await f.store.patch(1,{hidden_jobs:[3]});
  await openDiscovery(await context(f));await click(f,data(f,'С прошлого просмотра'));
  assert.match(panel(f).text,/Новая работа поваром/);assert.match(panel(f).text,/1 из 1/);
  // The snapshot does not pull new arrivals into an already-opened session.
  await f.store.putJob(job(8,{title:'Пришло позже'}),true);
  const token=await current(f);await click(f,`discover:${token}:7:0:show:s`);
  assert.match(panel(f).text,/1 из 1/);assert(!panel(f).text.includes('Пришло позже'));
});

test('opening an older snapshot cannot move the last-view marker backwards',async()=>{
  const f=await fixture();await f.store.putJob(job(1),true);await openDiscovery(await context(f));
  await f.store.putJob(job(2),true);await openDiscovery(await context(f));const oldNew=data(f,'С прошлого просмотра');
  await f.store.putJob(job(3),true);await openDiscovery(await context(f));assert.equal((await f.store.user(1)).settings.last_viewed_id,3);
  await click(f,oldNew);assert.equal((await f.store.user(1)).settings.last_viewed_id,3);assert.match(panel(f).text,/1 из 1/);
  await openDiscovery(await context(f));assert(!data(f,'С прошлого просмотра'));
});

test('saved searches have independent view markers and keep their scope through details, translation and hiding',async()=>{
  const f=await fixture();await f.store.putJob(job(1,{title:'Повар кухни',description:'Готовить ужин'}),true);
  await f.store.putJob(job(2,{title:'Водитель',description:'Развозить заказы'}),true);
  await f.store.ensure(1,1);await f.store.patch(1,{saved_searches:[{id:'chef',name:'Кухня',filters:{...defaults(),keywords:['повар']},notifications:'off',last_viewed_id:null},{id:'driver',name:'Машина',filters:{...defaults(),keywords:['водитель']},notifications:'off',last_viewed_id:null}]});
  await openDiscovery(await context(f),'chef');assert.match(panel(f).text,/Поиск: Кухня/);assert.match(panel(f).text,/1 из 1/);
  let saved=(await f.store.user(1)).settings.saved_searches;assert.equal(saved[0].last_viewed_id,2);assert.equal(saved[1].last_viewed_id,null);
  await f.store.putJob(job(3,{title:'Повар пиццерии'}),true);
  await openDiscovery(await context(f),'chef');await click(f,data(f,'С прошлого просмотра'));
  assert.match(panel(f).text,/Повар пиццерии/);await click(f,data(f,'Подробнее'));assert.match(panel(f).text,/Поиск: Кухня/);
  await click(f,data(f,'Ещё'));const translation=data(f,'Перевести');assert(translation.startsWith('discover:'));
  await click(f,translation);assert.match(panel(f).text,/Перевод сейчас недоступен/);assert.match(panel(f).text,/Поиск: Кухня/);
  await click(f,data(f,'Ещё'));await click(f,data(f,'Скрыть'));
  assert.match(panel(f).text,/Новых вакансий.*нет/);assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[3]);
  saved=(await f.store.user(1)).settings.saved_searches;assert.equal(saved[1].last_viewed_id,null);assert.equal((await f.store.user(1)).settings.last_viewed_id,undefined);
});

test('similar jobs exclude every seed copy, reject generic overlap and keep other filters',async()=>{
  const f=await fixture();
  const raw=[job(1,{title:'Повар',url:'https://example.rs/jobs/1',description:'Готовим ужины'}),job(2,{title:'Chef',url:'http://www.example.rs/jobs/1',description:'Готовим ужины'}),
    job(3,{title:'Kuvar',description:'Kuhinja u restoranu'}),job(4,{title:'Повар',location:'Novi Sad'}),job(5,{title:'Водитель',description:'Доставка продуктов'}),job(6,{title:'Повар'}),job(7,{title:'Повар'})];
  for(const j of raw)await f.store.putJob(j,true);
  await f.store.ensure(1,1);await f.store.patch(1,{keywords:['готовим'],city:['belgrade'],hidden_jobs:[6]});
  await f.store.record('moderation','7',{blocked:true,ids:[7]});
  await openDiscovery(await context(f));await click(f,data(f,'Ещё'));assert(data(f,'Похожие'));
  await click(f,data(f,'Похожие'));assert.match(panel(f).text,/Kuvar/);assert.match(panel(f).text,/1 из 1/);
  assert(!JSON.stringify(panel(f)).includes('view:'));assert(data(f,'исходной'));
  const generic=job(10,{title:'Требуется сотрудник ресторана',description:'Хорошие условия и оплата'});
  assert.equal(similarJobs([job(11,{title:'Требуется сотрудник ресторана',description:'Другие условия'})],generic).length,0);
  assert.equal(similarJobs([job(12,{title:'Junior Accountant',description:'Bookkeeping'})],job(13,{title:'Junior Developer',description:'Software'})).length,0);
  assert.equal(similarJobs([job(14,{title:'Шеф-редактор',description:'Выпуск журнала'})],job(15,{title:'Повар',description:'Готовить блюда'})).length,0);
});

test('session tokens are private, expire, stay bounded and callback payloads fit Telegram',async()=>{
  const f=await fixture();await f.store.putJob(job(9007199254740991,{title:'Повар'}),true);
  for(let i=0;i<9;i++)await openDiscovery(await context(f));
  const user=await f.store.user(1),token=user.settings.discovery_current;
  assert.equal(user.settings.discovery_sessions.length,6);
  for(const b of buttons(f))if(b.callback_data)assert(Buffer.byteLength(b.callback_data)<=64,b.callback_data);
  await click(f,`discover:${token}:9007199254740991:0:actions:s`);
  for(const b of buttons(f))if(b.callback_data)assert(Buffer.byteLength(b.callback_data)<=64,b.callback_data);
  await click(f,`discover:${token}:9007199254740991:0:show:s`,2);assert.match(panel(f).text,/устарела/);
  await f.store.patch(1,{discovery_sessions:user.settings.discovery_sessions.map(s=>({...s,expires:Date.now()-1}))});
  await click(f,`discover:${token}:9007199254740991:0:show:s`);assert.match(panel(f).text,/устарела/);
});

test('committed search and hide render correctly after a failed response without moving the baseline twice',async()=>{
  const f=await fixture();await f.store.putJob(job(1),true);await openDiscovery(await context(f));await f.store.putJob(job(2),true);
  const bot=await context(f),edit=f.api.editMessageText;
  f.api.editMessageText=async()=>{throw {code:429,parameters:{retry_after:1}};};
  await assert.rejects(openDiscovery(bot),e=>e.code===429);
  const committed=await f.store.user(1);assert.equal(committed.settings.last_viewed_id,2);
  const count=committed.settings.discovery_sessions.length;f.api.editMessageText=edit;
  await replayDiscovery(await context(f));assert(data(f,'С прошлого просмотра'));assert.equal((await f.store.user(1)).settings.discovery_sessions.length,count);
  const token=await current(f);f.api.editMessageText=async()=>{throw {code:429};};
  await assert.rejects(click(f,`discover:${token}:2:0:hide:s`),e=>e.code===429);
  assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[2]);f.api.editMessageText=edit;
  await replayDiscovery(await context(f));assert.match(panel(f).text,/1 из 1/);
});

test('the real update handler replays a committed scoped hide after 429 without repeating the mutation',async()=>{
  const f=await fixture();await f.store.putJob(job(1),true);await f.store.putJob(job(2),true);
  await handle(f,message(1,'/start'));await handle(f,updateCallback(1,'search:0'));
  const token=await current(f),update=updateCallback(1,`discover:${token}:2:0:hide:s`),edit=f.api.editMessageText;
  f.api.editMessageText=async()=>{throw {code:429,parameters:{retry_after:1}};};
  await assert.rejects(handle(f,update),e=>e.code===429);
  f.api.editMessageText=edit;await handle(f,update);
  assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[2]);assert.match(panel(f).text,/1 из 1/);
  assert.equal((await f.store.user(1)).settings.discovery_current,token);
  const responses=f.api.edited.length;await handle(f,update);assert.equal(f.api.edited.length,responses);
});

test('safety warning is contextual, factual and survives translation; hidden jobs expose no reasons',async()=>{
  const f=await fixture(),j=job(1,{title:'Повар',description:'Для получения работы необходимо заплатить предоплату 100 евро.'});
  await f.store.putJob(j,true);await openDiscovery(await context(f));assert.match(panel(f).text,/требующие осторожности/);
  assert(!data(f,'Почему'));await click(f,data(f,'Ещё'));const risk=data(f,'Почему');assert(risk);
  await click(f,risk);assert.match(panel(f).text,/автоматическая подсказка/);assert(!panel(f).text.includes('это мошенник'));
  assert(data(f,'К вакансии').startsWith('discover:'));
  const translated=await translatedCard(j,'rf',async()=>({ok:true,json:async()=>[[['Безобидный перевод']]]}),f.store);
  assert.match(translated.text,/требующие осторожности/);
  await f.store.patch(1,{hidden_jobs:[1]});await click(f,'risk:1');assert.match(panel(f).text,/больше не доступна/);
});
