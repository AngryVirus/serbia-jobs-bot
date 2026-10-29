import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,job,handle,callback} from './fixtures.js';
import {OWNER_ID} from '../tgcloud/lib/owner.js';
import {qualitySummary} from '../tgcloud/lib/analytics.js';
const panel=f=>f.api.edited.at(-1)||f.api.sent.at(-1);
const buttons=f=>panel(f).reply_markup.inline_keyboard.flat();
const click=async(f,text)=>{const b=buttons(f).find(b=>b.text.includes(text));assert(b?.callback_data);await handle(f,callback(OWNER_ID,b.callback_data));};
async function candidates(sizes=[2,3]) {
 const f=await fixture();let id=0;
 for(let group=0;group<sizes.length;group++)for(let n=0;n<sizes[group];n++){
  id++;await f.store.putJob(job(id,{company:'Компания '+group,description:('Нужен повар в ресторан. ').repeat(8)+' Смена '+n,url:`https://example.rs/jobs/${id}`,contacts:['https://t.me/hiring_person']}),true);
 }
 assert.equal(qualitySummary(await f.store.jobs()).candidates.length,sizes.length);
 return f;
}

test('removing one of three candidates returns to the same group and preserves the rest',async()=>{
 const f=await candidates([2,3,2]),groups=qualitySummary(await f.store.jobs()).candidates;
 const page=groups.findIndex(v=>v.length===3),group=groups[page],title=group[0].members[0].company;
 await handle(f,callback(OWNER_ID,`admin:quality:duplicates:${page}`));
 const remove=buttons(f).find(b=>b.text==='Убрать из выдачи').callback_data;
 await handle(f,callback(OWNER_ID,remove));assert.match(panel(f).text,/сняты с общей выдачи/);
 await click(f,'Продолжить проверку дублей');
 assert(panel(f).text.includes(title));assert.equal(buttons(f).filter(b=>b.text==='Убрать из выдачи').length,2);
 assert.equal((await f.store.records('moderation')).length,1);
 // Replaying an older button cannot remove the next group now occupying its index.
 await handle(f,callback(OWNER_ID,remove));await click(f,'Продолжить проверку дублей');
 assert.equal((await f.store.records('moderation')).length,1);assert(panel(f).text.includes(title));
});

test('resolved groups disappear, the last page clamps, and finishing review offers a route back',async()=>{
 const f=await candidates([2,2]);
 await handle(f,callback(OWNER_ID,'admin:quality:duplicates:1'));
 await click(f,'Убрать из выдачи');await click(f,'Продолжить проверку дублей');
 assert.match(panel(f).text,/Возможные дубли · 1\/1/);
 await click(f,'Убрать из выдачи');await click(f,'Продолжить проверку дублей');
 assert.match(panel(f).text,/Подозрительных совпадений.*не найдено/);
 assert(buttons(f).some(b=>b.callback_data==='admin:quality'));
});

test('opening a candidate and its source chooser preserves the duplicate-review return path',async()=>{
 const f=await candidates([2]);await handle(f,callback(OWNER_ID,'admin:quality:duplicates:0'));
 await click(f,'Открыть');assert(buttons(f).some(b=>b.text.includes('К проверке дублей')));
 await click(f,'Открыть объявление');assert.equal(buttons(f).filter(b=>b.url).length,2);
 await click(f,'К вакансии');await click(f,'К проверке дублей');assert.match(panel(f).text,/Возможные дубли/);
 await click(f,'Открыть');await click(f,'Убрать из выдачи');await click(f,'Продолжить проверку дублей');
 assert.match(panel(f).text,/Подозрительных совпадений.*не найдено/);
});

test('contextual callbacks retain owner access checks and missing rows retain the return button',async()=>{
 const f=await candidates([2]);await handle(f,callback(OWNER_ID,'admin:quality:duplicates:0'));
 const actions=buttons(f).map(b=>b.callback_data).filter(Boolean);
 for(const action of actions)await handle(f,callback(2,action));
 assert.equal((await f.store.records('moderation')).length,0);
 await handle(f,callback(OWNER_ID,'admin:block:999:dupes:0:1'));
 assert.match(panel(f).text,/больше не найдено/);await click(f,'Продолжить проверку дублей');
 assert.match(panel(f).text,/Возможные дубли/);
});
