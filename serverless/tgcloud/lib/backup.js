import { Store, assert } from './store.js';
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
// SDK db.all serializes payload strings again; leave room for escaping and the envelope.
const PAGE_BYTES=100*1024, PAGE_ROWS=200;
function manifest(id,counts) {
 return {id,version:1,pagination:'keyset-v1',counts:Object.fromEntries(queries.map(([t])=>[t,counts.find(r=>r.table_name===t)?.n || 0]))};
}
// A small CLI-only entrypoint lets backup requests omit image assets and bot UI code.
export async function backupAdmin(input,ctx,{db,api}) {
 assert(ctx?.ownerRun===true && !ctx.initData && !ctx.update,'Owner CLI context required');
 const me=await api.getMe();
 assert(me.is_bot && me.id===8802394224 && me.username?.toLowerCase()==='serbiajobsbot','Wrong bot; stopped');
 return backupOperation(new Store(db),input);
}
export async function backupOperation(store,input) {
 const id=input.id;
 assert(typeof id==='string' && /^[a-f0-9-]{36}$/.test(id),'Invalid snapshot ID');
 await store.db.run('CREATE TABLE IF NOT EXISTS sjc_backup_rows (snapshot TEXT NOT NULL, table_name TEXT NOT NULL, row_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(snapshot,table_name,row_key))');
 if(input.operation==='backup_create') {
  await store.db.run('DELETE FROM sjc_backup_rows WHERE created_at<:before',{':before':Date.now()-86400000});
  const saved=await store.db.get("SELECT 1 AS found FROM sjc_backup_rows WHERE snapshot=:id AND table_name='_snapshot'",{':id':id});
  if(saved) {
   assert(input.resume===true,'Snapshot already exists');
   return manifest(id,await store.db.all('SELECT table_name,COUNT(*) AS n FROM sjc_backup_rows WHERE snapshot=:id GROUP BY table_name',{':id':id}));
  }
  // A single SQLite statement takes one read snapshot across all UNION branches.
  // Plain INSERT makes accidental replay fail closed instead of mixing generations.
  const select=[...queries.map(([table,key,row])=>`SELECT :id,'${table}',${key},${row},:now FROM ${table}${table==='sqlite_sequence'?" WHERE name='sjc_jobs'":''}`),"SELECT :id,'_snapshot','','{}',:now"].join(' UNION ALL ');
  await store.db.run('INSERT INTO sjc_backup_rows(snapshot,table_name,row_key,payload,created_at) '+select,{':id':id,':now':Date.now()});
  const counts=await store.db.all('SELECT table_name,COUNT(*) AS n FROM sjc_backup_rows WHERE snapshot=:id GROUP BY table_name',{':id':id});
  return manifest(id,counts);
 }
 if(input.operation==='backup_page') {
  const table=input.table;
  if(Object.hasOwn(input,'after')) {
   assert(queries.some(([t])=>t===table) && (input.after===null || typeof input.after==='string'),'Invalid backup cursor');
   assert(await store.db.get("SELECT 1 AS found FROM sjc_backup_rows WHERE snapshot=:id AND table_name='_snapshot'",{':id':id}),'Snapshot expired or missing');
   const params={':id':id,':table':table,':after':input.after,':bytes':PAGE_BYTES};
   const rows=await store.db.all(`SELECT row_key,payload FROM (
    SELECT row_key,payload,SUM(length(CAST(payload AS BLOB))+2) OVER (ORDER BY row_key) AS bytes
    FROM (SELECT row_key,payload FROM sjc_backup_rows WHERE snapshot=:id AND table_name=:table AND (:after IS NULL OR row_key>:after) ORDER BY row_key LIMIT ${PAGE_ROWS})
   ) WHERE bytes<=:bytes ORDER BY row_key`,params);
   if(!rows.length)assert(!await store.db.get('SELECT 1 AS found FROM sjc_backup_rows WHERE snapshot=:id AND table_name=:table AND (:after IS NULL OR row_key>:after) LIMIT 1',{':id':id,':table':table,':after':input.after}),'Snapshot row exceeds safe response limit');
   return {rows:rows.map(r=>JSON.parse(r.payload)),next:rows.length?rows.at(-1).row_key:input.after};
  }
  assert(queries.some(([t])=>t===table) && Number.isSafeInteger(input.offset) && input.offset>=0,'Invalid backup page');
  return {rows:(await store.db.all('SELECT payload FROM sjc_backup_rows WHERE snapshot=:id AND table_name=:table ORDER BY row_key LIMIT 20 OFFSET :offset',{':id':id,':table':table,':offset':input.offset})).map(r=>JSON.parse(r.payload))};
 }
 if(input.operation==='backup_release') {
  await store.db.run('DELETE FROM sjc_backup_rows WHERE snapshot=:id',{':id':id});return {released:true};
 }
 throw Error('Unknown backup operation');
}
