"""Cross-runtime behavioral checks and migration invariants; no live credentials."""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import sys
import unittest
from unittest.mock import patch
from filters import matches
from store import default_settings

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'serverless'))
from enrich_jobs import enrich_job
from migrate import digest_snapshot, stage, TABLES


class MigrationTests(unittest.TestCase):
    def test_python_js_filter_parity(self):
        rng = random.Random(4301)
        cases = []
        now = datetime(2026, 10, 25, 23, 30, tzinfo=timezone.utc)
        dates = [None, 'garbage', '2026-10-26', '2026-10-25T23:45:00Z', '2026-10-25T01:00:00+02:00', '2026-10-19', '2026-09-26', '2026-10-25']
        for i in range(1500):
            job = dict(id=i+1, source='tg_rabotavserbii', url=f'https://t.me/rabotavserbii/{i+1}',
                       title=rng.choice(['Повар', 'Повариха', 'Python Developer', 'Waiter']),
                       description=rng.choice(['English required. ВНЖ обязателен.', 'ВНЖ не требуется.', 'Russian speakers welcome', 'Помощь с оформлением ВНЖ']),
                       location=rng.choice(['Beograd', 'Нови Сад', 'Niš', 'Business office', '']),
                       remote=rng.choice([None, True, False]), languages=rng.choice([None, [], ['en'], ['ru'], ['sr']]),
                       russian=rng.choice([None, True, False]), serbian_required=rng.choice([None, True, False]),
                       country=rng.choice([None, 'Serbia', 'DE']), eligible_countries=rng.choice([[], ['europe'], ['USA']]),
                       salary_min=rng.choice([None, 900, 1500]), salary_currency=rng.choice([None, 'EUR', 'RSD']),
                       salary_period=rng.choice([None, 'month', 'hour']), published_at=rng.choice(dates),
                       expires_at=rng.choice([None, '2026-10-25', '2026-10-26', '2026-10-25T23:29:00Z']), publication_date_only=rng.choice([False, True]))
            s = default_settings()
            s.update(city=rng.choice(['any', ['belgrade', 'novi_sad'], 'nis']), remote=rng.choice(['any','only','office']),
                     language=rng.choice(['any','russian','serbian','english','no_serbian']),
                     residence_permit=rng.choice(['any','yes','no']), freshness=rng.choice(['any','today','yesterday','7','30']),
                     keywords=rng.choice([[],['повар'],['python']]), exclusions=rng.choice([[],['waiter']]),
                     min_salary=rng.choice([None,1000]), include_unknown_salary=rng.choice([True,False]))
            cases.append({'job':enrich_job(job), 'settings':s, 'expected':matches(job,s,now)})
        # Also ensure many positive paths: a heavily constrained random set is mostly false.
        for case in list(cases[:200]):
            case = dict(case, settings=default_settings())
            case['expected'] = matches(case['job'],case['settings'],now)
            cases.append(case)
        script = "import {matches} from './serverless/tgcloud/lib/filters.js'; let b=''; for await (const c of process.stdin)b+=c; const p=JSON.parse(b); console.log(JSON.stringify(p.cases.map(c=>matches(c.job,c.settings,p.now))));"
        completed = subprocess.run(['node','--input-type=module','-e',script], cwd=ROOT, input=json.dumps({'cases':cases,'now':int(now.timestamp()*1000)}), text=True, capture_output=True, check=True)
        actual = json.loads(completed.stdout)
        self.assertEqual(actual,[c['expected'] for c in cases])
        self.assertGreater(sum(actual),20)

    def test_digest_ignores_row_and_key_order_but_detects_settings_changes(self):
        snapshot = {table:[] for table in TABLES}
        snapshot['users'] = [{'user_id':1,'settings':{'hidden_jobs':[44]}}, {'user_id':2,'settings':{}}]
        reordered = {**snapshot,'users':list(reversed(snapshot['users']))}
        self.assertEqual(digest_snapshot(snapshot),digest_snapshot(reordered))
        changed = {**snapshot,'users':[{'user_id':1,'settings':{'hidden_jobs':[]}}]}
        self.assertNotEqual(digest_snapshot(snapshot),digest_snapshot(changed))

    def test_numeric_json_roundtrip_does_not_break_snapshot_hash(self):
        before = {table: [] for table in TABLES}
        before['jobs'] = [{'id': 1, 'salary_min': 1000.0}]
        after = {**before, 'jobs': [{'id': 1, 'salary_min': 1000}]}
        self.assertEqual(digest_snapshot(before), digest_snapshot(after))

    def test_stage_verifies_private_rows_without_publishing(self):
        snapshot = {table:[] for table in TABLES}
        snapshot['users'] = [{'user_id':1,'chat_id':1,'settings':{'notifications':'off'}}]
        calls = []
        def invoke(op, **fields):
            calls.append(op)
            if op == 'export': return {'rows': snapshot[fields['table']]}
            return {}
        with patch('migrate.invoke',side_effect=invoke), patch('migrate.call',return_value={'url':'https://example.com/old','allowed_updates':['message']}), patch('builtins.print'):
            stage(snapshot)
        self.assertIn('verified',calls)
        self.assertNotIn('activate',calls)
        self.assertNotIn('notify',calls)

    def test_stage_rejects_truncated_export(self):
        snapshot = {table:[] for table in TABLES}
        snapshot['deliveries'] = [{'user_id':1,'job_id':88}]
        def invoke(op, **fields): return {'rows':[]} if op=='export' else {}
        with patch('migrate.invoke',side_effect=invoke), patch('migrate.call',return_value={'url':'https://example.com/old'}):
            with self.assertRaisesRegex(RuntimeError,'verification failed'):
                stage(snapshot)

    def test_stated_address_and_language_facts_survive_export(self):
        j=enrich_job({'title':'Повар','description':'English required. Адрес: Knez Mihailova 12, Beograd','location':'Beograd','url':'https://t.me/test/12'})
        self.assertIn('en',j['_cloud']['languages'])
        self.assertTrue(j['_cloud']['map_url'].startswith('https://www.google.com/maps/'))
        self.assertIsNone(j['_cloud']['permit'])


if __name__ == '__main__': unittest.main()
