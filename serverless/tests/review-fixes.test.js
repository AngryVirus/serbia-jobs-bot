import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,callback,job } from './fixtures.js';
import { Bot } from '../tgcloud/lib/bot.js';
import { clip,safe } from '../tgcloud/lib/ui.js';
import { contains,keywordContains,matches,settings } from '../tgcloud/lib/filters.js';
import { groupJobs,visibleJobs } from '../tgcloud/lib/catalog.js';
import { OWNER_ID } from '../tgcloud/lib/owner.js';

test('text without a length limit is cleaned but never marked as shortened', () => {
 assert.equal(clip('  2026-11-10T10:00:00.000Z  '),'2026-11-10T10:00:00.000Z');
 assert.equal(safe('create <b>'),'create &lt;b&gt;');
 assert.equal(clip('abcdef',4),'abc…');
});

test('advertising journal shows stored values without a false ellipsis', async () => {
 const f=await fixture();
 await f.store.ensure(OWNER_ID,OWNER_ID);
 await f.store.record('ad_audit','a1',{owner:OWNER_ID,action:'create',id:'abc123',at:'2026-11-10T10:00:00.000Z'});
 await new Bot(f).handle(callback(OWNER_ID,'ads:audit'));
 const text=[...f.api.sent,...f.api.edited].at(-1).text;
 assert.match(text,/2026-11-10T10:00:00\.000Z · create · abc123/);
 assert.doesNotMatch(text,/…/);
});

test('review list buttons never split an emoji in a long vacancy title', async () => {
 const f=await fixture(),title='x'.repeat(34)+'😀 повар';
 await f.store.ensure(OWNER_ID,OWNER_ID);
 await f.store.record('vacancy_review','1:5',{key:'1:5',job_id:1,uid:5,author:{id:5},title,stars:4,text:'Хороший работодатель',state:'pending',version:'abcdefgh1234',at:new Date().toISOString()});
 await new Bot(f).handle(callback(OWNER_ID,'admin:ratings:pending:0'));
 const sent=[...f.api.sent,...f.api.edited].at(-1),label=sent.reply_markup.inline_keyboard[0][0].text;
 assert.ok(label.startsWith('4 ⭐ · '+'x'.repeat(34)));
 assert.equal(label.isWellFormed?label.isWellFormed():!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(label),true);
});

test('cached search text follows the record and keeps exact word boundaries', () => {
 const now=Date.now(),record=job(1,{title:'Повар',description:'Ресторан в центре',location:'Beograd'});
 const cook=settings({keywords:['повар']}),driver=settings({keywords:['водитель']});
 assert.equal(matches(record,cook,now),true);
 assert.equal(matches(record,driver,now),false);
 record.title='Водитель';
 assert.equal(matches(record,cook,now),false);
 assert.equal(matches(record,driver,now),true);
 record.location='Niš';
 assert.equal(matches(record,settings({city:['belgrade']}),now),false);
 assert.equal(matches(record,settings({city:['nis']}),now),true);
 assert.equal(matches(record,settings({hidden_jobs:[1]}),now),false);
 assert.equal(contains('повариха','повар'),false);
 assert.equal(contains('Нужен ПОВАР.','повар'),true);
 assert.equal(keywordContains('ищем повара','повар'),true);
 assert.equal(contains('c++ developer','c++'),true);
});

test('repeated filtering of one catalogue returns the same selection', () => {
 const jobs=[job(1,{title:'Повар',location:'Beograd'}),job(2,{title:'Официант',description:'Кафе, Нови-Сад',location:'Novi Sad'}),job(3,{title:'Курьер',description:'Доставка',location:'Zemun'})];
 const groups=groupJobs(jobs),s=settings({keywords:['повар','официант'],exclusions:['доставка'],city:['belgrade','novi_sad']});
 const first=visibleJobs(groups,s).map(j=>j.id);
 assert.deepEqual(first,[1,2]);
 assert.deepEqual(visibleJobs(groups,s).map(j=>j.id),first);
 assert.deepEqual(visibleJobs(groups,settings({exclusions:['повар']})).map(j=>j.id),[2,3]);
});

test('an in-place panel update does not rewrite the unchanged panel pointer', async () => {
 const f=await fixture();let message=0;
 class InputFile {constructor(bytes){this.bytes=bytes;}}
 f.InputFile=InputFile;
 f.api.sendPhoto=async()=>({message_id:++message+500,photo:[{file_id:'file'+message}]});
 f.api.editMessageMedia=async p=>({message_id:p.message_id,photo:[{file_id:'edited'}]});
 f.api.deleteMessage=async()=>{};f.api.editMessageReplyMarkup=async()=>{};
 await new Bot(f).handle(callback(77,'menu'));
 const saved=async()=>(await f.store.user(77));
 const first=await saved();
 const id=first.settings.ui_panel_id;
 assert.ok(id>0);assert.equal(first.settings.ui_panel_kind,'photo');
 const update=callback(77,'filters');update.callback_query.message.message_id=id;update.callback_query.message.photo=[{file_id:'file1'}];
 const run=f.db.run;let rewrites=0;
 f.db.run=async(sql,params)=>{if(/^UPDATE sjc_users SET payload=:payload WHERE id=:id$/.test(sql))rewrites++;return run(sql,params);};
 await new Bot(f).handle(update);
 f.db.run=run;
 const second=await saved();
 assert.equal(second.settings.ui_panel_id,id);assert.equal(second.settings.ui_panel_kind,'photo');
 assert.equal(rewrites,0);
});
