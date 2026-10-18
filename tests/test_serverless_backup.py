"""Current-state backup, authenticated encryption and isolated recovery validation."""
import contextlib
import gzip
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'serverless'))
import backup


class BackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
import { fixture,job } from './serverless/tests/fixtures.js';
import { backupOperation } from './serverless/tgcloud/lib/backup.js';
const f=await fixture();await f.store.ensure(1,1);await f.store.ensure(2,2);await f.store.deleteUser(2);
await f.store.patch(1,{keywords:['Кухня'],notifications:'instant',notifications_after_id:1});
await f.store.putJob(job(1),true);await f.store.putJob(job(90),true);await f.db.run('DELETE FROM sjc_jobs WHERE id=90');
await f.store.record('ad_campaign','campaign',{state:'running',cursor:0});
await f.store.record('ad_delivery','campaign:1',{state:'sending'});
await f.store.record('moderation','1',{ids:[1],blocked:true});
await f.store.record('report','1:1',{user_id:1,job_id:1,state:'open'});
await f.store.record('usage','2026-10-18',{searches:5});
await f.store.claimUpdate('update-1');await f.store.finishUpdate('update-1');
const id='00000000-0000-0000-0000-000000000001';
const m=await backupOperation(f.store,{operation:'backup_create',id}),rows={};
for(const t of Object.keys(m.counts)) rows[t]=(await backupOperation(f.store,{operation:'backup_page',id,table:t,offset:0})).rows;
process.stdout.write(JSON.stringify(rows));
"""
        r = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True)
        cls.rows = json.loads(r.stdout)
        cls.env = dict(os.environ, TGCLOUD_TOKEN='app8802394224:'+'synthetic_backup_test_'*3)

    def test_full_database_roundtrip_preserves_records_ids_sequence_and_pending_claims(self):
        db = backup.build_database(self.rows)
        self.assertEqual(backup.digest(backup.read_database(db)), backup.digest(self.rows))
        self.assertEqual(db.execute('SELECT seq FROM sqlite_sequence WHERE name=?', ('sjc_jobs',)).fetchone()[0], 90)
        encrypted = backup.crypt(gzip.compress(db.serialize()), 'encrypt', self.env)
        self.assertNotIn('Кухня'.encode(), encrypted)
        report = backup.restore_drill(encrypted, backup.digest(self.rows), self.env)
        self.assertTrue(report['offline_bot']);self.assertEqual(report['sends'], 0)
        self.assertEqual(report['counts']['sjc_users'], 1)
        restored = sqlite3.connect(':memory:');restored.deserialize(gzip.decompress(backup.crypt(encrypted, 'decrypt', self.env)))
        claimed = restored.execute("SELECT payload FROM sjc_records WHERE kind='ad_delivery'").fetchone()[0]
        self.assertEqual(json.loads(claimed)['state'], 'sending')
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM sjc_locks').fetchone()[0], 0)
        self.assertEqual(restored.execute("SELECT state FROM sjc_updates WHERE key='update-1'").fetchone()[0], 'done')

    def test_recovery_handles_a_banned_first_or_only_user_without_removing_bans(self):
        rows=json.loads(json.dumps(self.rows))
        rows['sjc_records'].append({'kind':'user_ban','record_key':'1','payload':json.dumps({'uid':1,'at':'2026-10-18'})})
        db=backup.build_database(rows)
        encrypted=backup.crypt(gzip.compress(db.serialize()),'encrypt',self.env)
        report=backup.restore_drill(encrypted,backup.digest(rows),self.env)
        self.assertTrue(report['offline_bot'])
        restored=sqlite3.connect(':memory:');restored.deserialize(gzip.decompress(backup.crypt(encrypted,'decrypt',self.env)))
        self.assertEqual(restored.execute("SELECT COUNT(*) FROM sjc_records WHERE kind='user_ban'").fetchone()[0],1)
        self.assertEqual(restored.execute('SELECT COUNT(*) FROM sjc_users').fetchone()[0],1)

    def test_current_moderation_reason_actor_and_delivery_receipt_survive_recovery(self):
        rows=json.loads(json.dumps(self.rows))
        payload={'uid':1,'active':False,'version':'urevision','reason':'Спам','by':340780041,
                 'actor':{'id':340780041,'username':'ActualAdmin'},'notice':{'state':'pending'}}
        rows['sjc_records'].append({'kind':'user_ban','record_key':'1','payload':json.dumps(payload,ensure_ascii=False)})
        db=backup.build_database(rows)
        encrypted=backup.crypt(gzip.compress(db.serialize()),'encrypt',self.env)
        report=backup.restore_drill(encrypted,backup.digest(rows),self.env)
        self.assertTrue(report['offline_bot'])
        restored=sqlite3.connect(':memory:');restored.deserialize(gzip.decompress(backup.crypt(encrypted,'decrypt',self.env)))
        saved=restored.execute("SELECT payload FROM sjc_records WHERE kind='user_ban'").fetchone()[0]
        self.assertEqual(json.loads(saved),payload)

    def test_staff_roles_and_action_audit_survive_encrypted_recovery(self):
        rows=json.loads(json.dumps(self.rows))
        entries=[{'kind':'staff_role','record_key':'1','payload':json.dumps({'uid':1,'role':'moderator','version':'v1'})},
                 {'kind':'staff_audit','record_key':'staff_role:1:v1','payload':json.dumps({'action':'grant_moderator','actor':{'id':340780041},'target':1,'at':'2026-10-18T00:00:00Z'})}]
        rows['sjc_records'].extend(entries)
        db=backup.build_database(rows)
        encrypted=backup.crypt(gzip.compress(db.serialize()),'encrypt',self.env)
        report=backup.restore_drill(encrypted,backup.digest(rows),self.env)
        self.assertTrue(report['offline_bot'])
        restored=sqlite3.connect(':memory:');restored.deserialize(gzip.decompress(backup.crypt(encrypted,'decrypt',self.env)))
        for row in entries:
            saved=restored.execute('SELECT payload FROM sjc_records WHERE kind=? AND record_key=?',(row['kind'],row['record_key'])).fetchone()[0]
            self.assertEqual(json.loads(saved),json.loads(row['payload']))

    def test_wrong_key_and_modified_header_tag_or_ciphertext_are_rejected(self):
        encrypted = backup.crypt(b'private test payload', 'encrypt', self.env)
        other = dict(self.env, TGCLOUD_TOKEN='app8802394224:'+'other_synthetic_key_'*3)
        with self.assertRaisesRegex(RuntimeError, 'authentication failed'):
            backup.crypt(encrypted, 'decrypt', other)
        for position in [0, 12, 45, 55, len(encrypted)-1]:
            modified = bytearray(encrypted);modified[position] ^= 1
            with self.subTest(position=position), self.assertRaises(RuntimeError):
                backup.crypt(bytes(modified), 'decrypt', self.env)

    def test_randomized_encryption_and_digest_mismatch(self):
        db = backup.build_database(self.rows)
        data = gzip.compress(db.serialize())
        a = backup.crypt(data, 'encrypt', self.env);b = backup.crypt(data, 'encrypt', self.env)
        self.assertNotEqual(a, b)
        with self.assertRaisesRegex(ValueError, 'comparison failed'):
            backup.restore_drill(a, 'incorrect', self.env)

    def test_export_pagination_artifact_readback_and_release_on_failure(self):
        calls = []
        def invoke(op, **kwargs):
            calls.append(op)
            if op == 'backup_create':
                return {'version': 1, 'counts': {t: len(r) for t, r in self.rows.items()}}
            if op == 'backup_page':
                return {'rows': self.rows[kwargs['table']][kwargs['offset']:kwargs['offset']+1]}
            return {'released': True}
        with tempfile.TemporaryDirectory() as d, patch.object(backup, 'invoke', side_effect=invoke), patch.object(backup, 'environment', return_value=self.env), contextlib.redirect_stdout(io.StringIO()):
            path = Path(d)/'snapshot.sjcbk';backup.create_backup(path)
            self.assertTrue(path.exists());self.assertTrue(path.with_suffix('.report.json').exists())
            self.assertEqual(calls[-1], 'backup_release');self.assertNotIn('backup_status', calls)
            with patch.object(backup, 'build_database', side_effect=ValueError('test')):
                with self.assertRaises(ValueError):backup.create_backup(Path(d)/'failed.sjcbk')
            self.assertEqual(calls[-1], 'backup_release')

    def test_local_recovery_is_paused_and_cannot_overwrite_an_existing_file(self):
        db = backup.build_database(self.rows)
        encrypted = backup.crypt(gzip.compress(db.serialize()), 'encrypt', self.env)
        with tempfile.TemporaryDirectory() as d, patch.object(backup, 'environment', return_value=self.env), contextlib.redirect_stdout(io.StringIO()):
            source = Path(d)/'backup.sjcbk';source.write_bytes(encrypted)
            target = Path(d)/'restored.sqlite'
            with patch.object(sys, 'argv', ['backup.py', 'restore-local', str(source), '--output', str(target)]):
                backup.main()
                with self.assertRaises(ValueError):backup.main()
            local = sqlite3.connect(target)
            self.assertEqual(local.execute("SELECT payload FROM sjc_meta WHERE key='active'").fetchone()[0], 'false')
            self.assertGreater(json.loads(local.execute("SELECT payload FROM sjc_meta WHERE key='ad_emergency'").fetchone()[0]), 10**15)

    def test_cleanup_failure_preserves_verified_pair_and_does_not_mask_export_error(self):
        def invoke(op,**fields):
            if op=='backup_create':return {'version':1,'counts':{t:len(v) for t,v in self.rows.items()}}
            if op=='backup_page':return {'rows':self.rows[fields['table']][fields['offset']:fields['offset']+20]}
            raise RuntimeError('Synthetic cleanup outage; details must stay private')
        with tempfile.TemporaryDirectory() as directory,patch.object(backup,'invoke',side_effect=invoke),patch.object(backup,'environment',return_value=self.env),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            path=Path(directory)/'ready.sjcbk';backup.create_backup(path)
            self.assertTrue(backup.verify_pair(path)['integrity'])
            self.assertFalse(path.with_suffix('.resume.sjcbk').exists())
            with patch.object(backup,'build_database',side_effect=ValueError('Original export failure')):
                with self.assertRaisesRegex(ValueError,'Original export failure'):backup.create_backup(Path(directory)/'failed.sjcbk')
            self.assertFalse((Path(directory)/'failed.report.json').exists())

    def test_interrupted_export_resumes_encrypted_checkpoint_without_rereading_saved_pages(self):
        calls=[];interrupt=True
        manifest={'version':1,'pagination':'keyset-v1','counts':{t:len(v) for t,v in self.rows.items()}}
        def invoke(op,**fields):
            calls.append((op,fields.copy()))
            if op=='backup_create':return manifest
            if op=='backup_release':return {'released':True}
            self.assertEqual(op,'backup_page')
            offset=int(fields['after'] or 0)
            if interrupt and fields['table']=='sjc_records' and offset==1:
                raise backup.CloudRequestError('Synthetic read timeout',transient=True)
            return {'rows':self.rows[fields['table']][offset:offset+1],'next':str(offset+1)}
        with tempfile.TemporaryDirectory() as directory,patch.object(backup,'invoke',side_effect=invoke),patch.object(backup,'environment',return_value=self.env),contextlib.redirect_stdout(io.StringIO()):
            path=Path(directory)/'runtime.sjcbk'
            with self.assertRaises(backup.CloudRequestError):backup.create_backup(path)
            checkpoint=path.with_suffix('.resume.sjcbk')
            self.assertTrue(checkpoint.exists());self.assertNotIn(b'sjc_records',checkpoint.read_bytes())
            self.assertNotIn('backup_release',[op for op,_ in calls])
            first_identifier=calls[0][1]['id'];calls.clear();interrupt=False
            backup.create_backup(path)
            self.assertEqual(calls[0][1]['id'],first_identifier);self.assertTrue(calls[0][1]['resume'])
            record_pages=[f for op,f in calls if op=='backup_page' and f['table']=='sjc_records']
            self.assertEqual(record_pages[0]['after'],'1')
            self.assertTrue(backup.verify_pair(path)['offline_bot']);self.assertFalse(checkpoint.exists())

    def test_pair_validation_rejects_report_from_a_different_artifact(self):
        def invoke(op,**fields):
            if op=='backup_create':return {'version':1,'counts':{t:len(v) for t,v in self.rows.items()}}
            if op=='backup_page':return {'rows':self.rows[fields['table']][fields['offset']:fields['offset']+20]}
            return {'released':True}
        with tempfile.TemporaryDirectory() as directory,patch.object(backup,'invoke',side_effect=invoke),patch.object(backup,'environment',return_value=self.env),contextlib.redirect_stdout(io.StringIO()):
            path=Path(directory)/'runtime.sjcbk';backup.create_backup(path)
            report=json.loads(path.with_suffix('.report.json').read_text());report['artifact_sha256']='0'*64
            path.with_suffix('.report.json').write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError,'pair required'):backup.verify_pair(path)


if __name__ == '__main__':
    unittest.main()
