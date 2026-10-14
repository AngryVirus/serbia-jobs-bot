from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json
import pgserver
import tempfile
import sys
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root))
from store import default_settings
temp=tempfile.TemporaryDirectory()
pg=pgserver.get_server(Path(temp.name)/'postgres',cleanup_mode='stop')
try:
 schema=(root/'supabase-schema.sql').read_text()
 pg.psql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;')
 pg.psql(schema)
 pg.psql("TRUNCATE sj_users,sj_jobs,sj_leases,sj_webhook_events CASCADE")
 defaults=json.dumps(default_settings()).replace("'","''")
 pg.psql("INSERT INTO sj_users(user_id,chat_id,settings) VALUES (1,1,'{\"keywords\":[\"python\"],\"notifications\":\"daily\"}'),(2,2,'{}')")
 pg.psql(schema)
 pg.psql("SET ROLE service_role; SELECT sj_patch_settings(1,'{\"city\":\"nis\"}','"+defaults+"'); SELECT sj_patch_settings(1,'{\"freshness\":\"7\"}','"+defaults+"');")
 pg.psql("""DO $$ BEGIN
   ASSERT (SELECT settings->>'city'='nis' AND settings->>'freshness'='7' AND settings->'keywords'='["python"]'::jsonb AND settings->>'notifications'='daily' FROM sj_users WHERE user_id=1), 'Existing settings lost';
   ASSERT (SELECT settings='{}' FROM sj_users WHERE user_id=2), 'Another user modified';
 END $$;""")
 pg.psql("""SET ROLE service_role;
 SELECT sj_patch_settings(1, '{"city":["belgrade","novi_sad"],"language":["russian","serbian"],"hidden_jobs":[10,20]}', '{}');
 DO $$ BEGIN
   ASSERT (SELECT settings->'city'='["belgrade","novi_sad"]'::jsonb AND settings->'language'='["russian","serbian"]'::jsonb AND settings->'hidden_jobs'='[10,20]'::jsonb AND settings->'keywords'='["python"]'::jsonb AND settings->>'notifications'='daily' FROM sj_users WHERE user_id=1), 'Multiple selections or hidden jobs lost';
 END $$;
 SELECT sj_patch_settings(1, '{"hidden_jobs":[20]}', '{}');
 DO $$ BEGIN
   ASSERT (SELECT settings->'hidden_jobs'='[20]'::jsonb AND settings->'city'='["belgrade","novi_sad"]'::jsonb FROM sj_users WHERE user_id=1), 'Restore damaged settings';
   ASSERT (SELECT settings='{}' FROM sj_users WHERE user_id=2), 'Another user modified';
 END $$;""")
 with ThreadPoolExecutor(2) as pool:
  calls=[pool.submit(pg.psql,"SET ROLE service_role; SELECT sj_acquire_lease('collection','"+owner+"',900);") for owner in ('a','b')]
  output=[f.result() for f in calls]
 assert sum('\n t\n' in s or '\nt\n' in s for s in output)==1,output
 pg.psql("""DO $$ BEGIN
   ASSERT sj_claim_update(1,'owner1',600)='claimed';
   ASSERT sj_claim_update(1,'owner2',600)='busy';
   ASSERT NOT sj_renew_update(1,'owner2',600);
   ASSERT sj_renew_update(1,'owner1',600);
   PERFORM sj_finish_update(1,'owner1');
   ASSERT sj_claim_update(1,'owner2',600)='completed';
 END $$;""")
 pg.psql("""INSERT INTO sj_jobs(source,url,title,published_at,publication_date_only) VALUES('radim','https://radim.rs/jobs/a','Test','2026-10-01',true);
 INSERT INTO sj_deliveries(user_id,job_id) SELECT 1,id FROM sj_jobs;
 UPDATE sj_jobs SET published_at='2026-10-14',publication_date_only=false;
 DO $$ BEGIN
   ASSERT (SELECT published_at='2026-10-01'::timestamptz AND publication_date_only FROM sj_jobs);
   ASSERT NOT has_function_privilege('anon','sj_acquire_lease(text,text,integer)','execute');
   ASSERT NOT has_function_privilege('authenticated','sj_patch_settings(bigint,jsonb,jsonb)','execute');
   ASSERT has_function_privilege('service_role','sj_acquire_lease(text,text,integer)','execute');
 END $$;
 DELETE FROM sj_users WHERE user_id=1;
 DO $$ BEGIN
   ASSERT NOT EXISTS(SELECT 1 FROM sj_deliveries WHERE user_id=1);
   ASSERT EXISTS(SELECT 1 FROM sj_jobs);
 END $$;""")
 print('PASS: PostgreSQL 16 schema and repeatable migration, preservation, role permissions, atomic settings merges, concurrent collection lease, webhook deduplication, publication-date trigger and personal-data deletion.')
finally:
 pg.cleanup()
 temp.cleanup()
