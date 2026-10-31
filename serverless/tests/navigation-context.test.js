import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,handle,message,callback,job} from './fixtures.js';
import {OWNER_ID} from '../tgcloud/lib/permissions.js';
import {Bot} from '../tgcloud/lib/bot.js';
const last=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const buttons=f=>last(f).reply_markup.inline_keyboard.flat();
const click=async(f,uid,text)=>{const b=buttons(f).find(b=>b.text.includes(text));assert(b?.callback_data,text);await handle(f,callback(uid,b.callback_data));};
async function seed(){const f=await fixture();for(let id=1;id<=3;id++)await f.store.putJob(job(id,{title:'Повар '+id,url:`https://example.rs/jobs/${id}`,contacts:['https://t.me/contactperson']}),true);return f;}

test('review list, rating form and submitted review return to the same search and position',async()=>{
 const f=await seed();await handle(f,callback(1,'search:0'));await click(f,1,'➡️');
 const before=(await f.store.user(1)).settings.discovery_sessions.at(-1),more=buttons(f).find(b=>b.text.includes('Ещё')).callback_data;
 await click(f,1,'Отзывы');let back=buttons(f).find(b=>b.text.includes('К вакансии')).callback_data;
 assert.equal(back,`discover:${before.token}:${before.current_id}:${before.index}:show:s`);
 await click(f,1,'Оставить отзыв');await click(f,1,'4 ⭐');
 assert.equal(buttons(f).at(-1).callback_data,back);
 await handle(f,message(1,'Проходил собеседование. Всё объяснили.'));
 assert.equal(buttons(f).at(-1).callback_data,back);
 await click(f,1,'К вакансии');assert(buttons(f).some(b=>b.callback_data===more));assert.match(last(f).text,/Вакансия 2 из 3/);
});
test('saved-search reviews preserve saved filters and expired contexts do not switch searches',async()=>{
 const f=await seed();await f.store.ensure(1,1);await f.store.patch(1,{keywords:['Повар 1']});
 await handle(f,callback(1,'plans:create'));await handle(f,message(1,'Один'));
 const plan=(await f.store.user(1)).settings.saved_searches[0];await f.store.patch(1,{keywords:['Повар 3']});
 await handle(f,callback(1,`plans:open:${plan.id}`));const review=buttons(f).find(b=>b.text.includes('Отзывы')).callback_data;
 await handle(f,callback(1,review));await click(f,1,'К вакансии');assert.match(last(f).text,/Поиск: Один/);assert.match(last(f).text,/Повар 1/);
 await f.store.patch(1,{discovery_sessions:[]});await handle(f,callback(1,review));assert.match(last(f).text,/подборка устарела/);
});
test('legacy viewer and favorites review return paths retain their origin without duplicate remove controls',async()=>{
 const f=await seed();await handle(f,callback(1,'view:2:1:show:f'));await click(f,1,'Отзывы');
 assert.equal(buttons(f).at(-1).callback_data,'view:2:1:show:f');
 await f.store.setFavorite(1,[2],true,'seed');await handle(f,callback(1,'favorites:show:2'));
 assert(!buttons(f).some(b=>b.callback_data==='favorite:remove:2'));
 await click(f,1,'Отзывы');assert.equal(buttons(f).at(-1).callback_data,'favorites:show:2:s');
 await click(f,1,'К вакансии');assert(buttons(f).some(b=>b.callback_data==='favorites:0'));
 await click(f,1,'Ещё');assert.equal(buttons(f).filter(b=>b.callback_data?.startsWith('favorite:remove:2:')).length,1);
});
test('reports and withdrawn vacancies keep their moderation queue after choosing sources or a decision',async()=>{
 const f=await seed();
 for(const id of [1,2,3])await f.store.record('report',`77:${id}`,{user_id:77,job_id:id,group_id:id,reason:'outdated',state:'open'});
 await handle(f,callback(OWNER_ID,'admin:reports:1'));await click(f,OWNER_ID,'Открыть объявление');
 assert.equal(buttons(f).filter(b=>b.url).length,2);assert.equal(buttons(f).at(-1).callback_data,'admin:reports:1');
 await click(f,OWNER_ID,'К вакансии');await click(f,OWNER_ID,'Убрать из выдачи');await click(f,OWNER_ID,'Продолжить проверку жалоб');
 assert.match(last(f).text,/Жалобы · 2\/2/);
 await handle(f,callback(OWNER_ID,'admin:blocked:0'));await click(f,OWNER_ID,'Открыть объявление');await click(f,OWNER_ID,'К вакансии');
 assert.match(last(f).text,/Снятые с выдачи/);await click(f,OWNER_ID,'Вернуть в выдачу');await click(f,OWNER_ID,'Снятые вакансии');assert.match(last(f).text,/Снятых с выдачи вакансий нет/);
});
test('hidden favorites keep details, sources, translation and actions accessible without leaving favorites',async()=>{
 const f=await seed();await f.store.ensure(1,1);await f.store.setFavorite(1,[2],true,'seed');await f.store.patch(1,{hidden_jobs:[2]});
 await handle(f,callback(1,'favorites:show:2'));await click(f,1,'Подробнее');
 assert.match(last(f).text,/Нужен повар/);assert.match(last(f).text,/скрыта из вашего поиска/);
 await click(f,1,'Открыть объявление');assert.equal(buttons(f).filter(b=>b.url).length,2);
 await click(f,1,'К вакансии');assert(buttons(f).some(b=>b.text.includes('Свернуть')));
 await click(f,1,'Ещё');await click(f,1,'Перевести');assert(buttons(f).some(b=>b.callback_data==='favorites:0'));
 await click(f,1,'Ещё');await click(f,1,'Проблема');await click(f,1,'Пожаловаться');await click(f,1,'К объявлению');
 assert(buttons(f).some(b=>b.callback_data==='favorites:0'));
 await click(f,1,'Ещё');await click(f,1,'Убрать из избранного');assert.match(last(f).text,/Избранные вакансии/);
 assert.deepEqual(await f.store.favoriteIds(1),[]);assert.deepEqual((await f.store.user(1)).settings.hidden_jobs,[2]);
});
test('moderation source chooser includes a publisher website extracted from the Telegram publication',async()=>{
 const f=await fixture();await f.store.putJob(job(1,{source:'tg_radim_serbia',url:'https://t.me/radim_serbia/42',description:'Повар. Подробнее и откликнуться: https://radim.rs/jobs/cook-123/',contacts:[]}),true);
 await f.store.record('report','77:1',{user_id:77,job_id:1,group_id:1,reason:'outdated',state:'open'});
 await handle(f,callback(OWNER_ID,'admin:reports:0'));await click(f,OWNER_ID,'Открыть объявление');
 const urls=buttons(f).filter(b=>b.url).map(b=>b.url);assert(urls.some(u=>u.includes('radim.rs/')));assert(urls.some(u=>u.includes('t.me/')));
});
test('Telegram profile restrictions do not disable review moderation; ambiguous errors are not retried',async()=>{
 const f=await seed();await f.store.record('vacancy_review','1:77',{key:'1:77',job_id:1,uid:77,author:{name:'Автор'},title:'Повар',text:'Мой опыт собеседования',stars:3,state:'pending',version:'review123456'});
 class CheckedBot extends Bot {async panel(text,rows){if(rows.flat().some(b=>b.url?.startsWith('tg://')))throw {code:400,description:'BUTTON_USER_PRIVACY_RESTRICTED'};this.result={text,rows};}}
 const bot=new CheckedBot(f);await bot.handle(callback(OWNER_ID,'admin:ratings:view:1:77'));
 assert.match(bot.result.text,/ID: 77/);assert(bot.result.rows.flat().some(b=>b.text==='✅ Опубликовать'));
 const publish=bot.result.rows.flat().find(b=>b.text==='✅ Опубликовать').callback_data;
 await bot.handle(callback(OWNER_ID,publish));assert.equal((await f.store.records('vacancy_review'))[0].state,'published');
 for(const error of [{code:429},{code:500},{code:400,description:'Other invalid request'}]){
  let calls=0;bot.panel=async()=>{calls++;throw error;};await assert.rejects(bot.handle(callback(OWNER_ID,'admin:ratings:view:1:77')));assert.equal(calls,1);
 }
});
