import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,handle,callback } from './fixtures.js';
import { OWNER_ID } from '../tgcloud/lib/permissions.js';

test('report refresh acknowledges the request only to the owner in their private chat',async()=>{
 const f=await fixture(),answers=[];
 f.api.answerCallbackQuery=async p=>{answers.push(p);};
 for(const action of ['admin:refresh','admin:details:refresh','admin:stats:refresh','admin:stats:delivery:refresh','admin:quality:sources:0:refresh']) {
  await handle(f,callback(OWNER_ID,action));
  assert.equal(answers.at(-1).text,'Обновляю сохранённые данные…');
  assert.match(f.api.edited.at(-1).text,/Белград/);
  await handle(f,callback(1,action));
  assert.equal(answers.at(-1).text,undefined);
  assert.match(f.api.edited.at(-1).text,/только владельцу/);
  const count=answers.length,edits=f.api.edited.length,forged=callback(1,action);
  forged.callback_query.message.chat.id=OWNER_ID;
  await handle(f,forged);
  assert.equal(answers.length,count+1);
  assert.equal(answers.at(-1).text,'Откройте личный чат с ботом.');
  assert.equal(f.api.edited.length,edits);
 }
 assert.equal(f.api.sent.length,0);
 assert.equal((await f.store.records('ad_campaign')).length,0);
 assert.equal(await f.store.meta('collection_run'),null);
});
