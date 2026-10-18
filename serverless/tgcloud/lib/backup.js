import { assert } from './store.js';
// Durable application state only. Locks and snapshot staging are intentionally excluded.
const queries = [
 ['sjc_meta', "key", "json_object('key',key,'payload',payload)"],
 ['sjc_users', "printf('%020d',id)", "json_object('id',id,'payload',payload)"],
 ['sjc_jobs', "printf('%020d',id)", "json_object('id',id,'source_key',source_key,'payload',payload)"],
 ['sjc_deliveries', "printf('%020d:%020d',user_id,job_id)", "json_object('user_id',user_id,'job_id',job_id,'state',state,'payload',payload)"],
 ['sjc_records', "kind || ':' || record_key", "json_object('kind',kind,'record_key',record_key,'payload',payload)"],
 ['sjc_updates', "key", "json_object('key',key,'state',state,'expires',expires)"],
 ['sqlite_sequence', "name", "json_object('name',name,'seq',seq)"],
];
export async function backupOperation(store,input) {
 const id=input.id;
 assert(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id),'Invalid snapshot ID');
 await store.db.run('CREATE TABLE IF NOT EXISTS sjc_backup_rows (snapshot TEXT NOT NULL, table_name TEXT NOT NULL, row_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(snapshot,table_name,row_key))');
 if(input.operation==='backup_create') {
  await store.db.run('DELETE FROM sjc_backup_rows WHERE created_at<:before',{':before':Date.now()-86400000});
  // A single SQLite statement takes one read snapshot across all UNION branches.
  // Plain INSERT makes accidental replay fail closed instead of mixing generations.
  const select=queries.map(([table,key,row])=>`SELECT :id,'${table}',${key},${row},:now FROM ${table}${table==='sqlite_sequence'?" WHERE name='sjc_jobs'":''}`).join(' UNION ALL ');
  await store.db.run('INSERT INTO sjc_backup_rows(snapshot,table_name,row_key,payload,created_at) '+select,{':id':id,':now':Date.now()});
  const counts=await store.db.all('SELECT table_name,COUNT(*) AS n FROM sjc_backup_rows WHERE snapshot=:id GROUP BY table_name',{':id':id});
  return {id,version:1,counts:Object.fromEntries(queries.map(([t])=>[t,counts.find(r=>r.table_name===t)?.n || 0]))};
 }
 if(input.operation==='backup_page') {
  const table=input.table;
  assert(queries.some(([t])=>t===table) && Number.isSafeInteger(input.offset) && input.offset>=0,'Invalid backup page');
  return {rows:(await store.db.all('SELECT payload FROM sjc_backup_rows WHERE snapshot=:id AND table_name=:table ORDER BY row_key LIMIT 20 OFFSET :offset',{':id':id,':table':table,':offset':input.offset})).map(r=>JSON.parse(r.payload))};
 }
 if(input.operation==='backup_release') {
  await store.db.run('DELETE FROM sjc_backup_rows WHERE snapshot=:id',{':id':id});return {released:true};
 }
 throw Error('Unknown backup operation');
}
