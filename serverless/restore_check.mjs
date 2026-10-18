// Offline only: never import SDK or an HTTP client, never log private records.
import { DatabaseSync } from 'node:sqlite';
import { Store } from './tgcloud/lib/store.js';
import { Bot } from './tgcloud/lib/bot.js';
import { adTick } from './tgcloud/lib/ads.js';
import { groupJobs, visibleJobs } from './tgcloud/lib/catalog.js';
import { defaults } from './tgcloud/lib/filters.js';
import assert from 'node:assert/strict';
const connection=new DatabaseSync(process.argv[2]);
const db={async run(sql,p={}){return {rowsAffected:Number(connection.prepare(sql).run(p).changes)};},async get(sql,p={}){return connection.prepare(sql).get(p);},async all(sql,p={}){return connection.prepare(sql).all(p);}};
try {
 const store=new Store(db);await store.init();
 const jobs=await store.jobs();visibleJobs(groupJobs(jobs),defaults());await store.stats();
 const row=await db.get('SELECT id FROM sjc_users ORDER BY id LIMIT 1');
 await store.setMeta('active',false);
 const fail=()=>{throw Error('A restored queue tried to send');};
 assert((await adTick(store,{sendMessage:fail,sendPhoto:fail})).done);
 // Exercise a normal search against the restored catalog using a local API stub.
 if(row) {
  await store.setMeta('active',true);
  let responses=0;
  const api={async answerCallbackQuery(){},async editMessageText(){responses++;},async sendMessage(){responses++;return {message_id:1};}};
  // Clear transient leases only in this disposable database.
  await db.run('DELETE FROM sjc_locks');
  await new Bot({db,api,fetch:fail}).handle({update_id:Date.now(),callback_query:{id:'offline-drill',from:{id:row.id},message:{message_id:1,chat:{id:row.id,type:'private'}},data:'search:0'}});
  assert(responses>0);
 }
 await store.setMeta('active',false);
} finally {connection.close();}
