from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from filters import matches, parse_datetime, active
from job_metadata import enrich, language_facts, remote_fact, text_salary
from sources import Job
from store import Store, default_settings
from helpers import vacancy


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.settings = default_settings()
        self.job = vacancy()
        self.now = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)

    def check(self, period, date, expected, now=None):
        self.settings['freshness'] = period
        self.job['published_at'] = date
        self.assertEqual(matches(self.job, self.settings, now or self.now), expected, (period,date,now))

    def test_all_calendar_windows_and_boundaries(self):
        for period, dates in {'today': [('2026-10-14',True),('2026-10-13',False)],
                              'yesterday': [('2026-10-13',True),('2026-10-14',False),('2026-10-12',False)],
                              '7': [('2026-10-08',True),('2026-10-07',False)],
                              '30': [('2026-09-15',True),('2026-09-14',False)],
                              'any': [('2001-01-01',False),(None,True)]}.items():
            for date,expected in dates:
                with self.subTest(period=period,date=date): self.check(period,date,expected)

    def test_unknown_and_future_dates_never_become_fresh(self):
        self.job['created_at']='2026-10-14T12:00:00Z'
        for period in ('today','yesterday','7','30'):
            self.check(period,None,False)
            self.check(period,'2026-10-15',False)
        self.check('any','2026-10-14T23:00:00Z',False)
        self.check('any','invalid',True)

    def test_belgrade_midnight_in_winter_and_summer(self):
        self.check('today','2026-01-02',True,datetime(2026,1,1,23,10,tzinfo=timezone.utc))
        self.check('today','2026-07-02',True,datetime(2026,7,1,22,10,tzinfo=timezone.utc))
        self.check('yesterday','2026-07-01',True,datetime(2026,7,1,22,10,tzinfo=timezone.utc))

    def test_dst_23_and_25_hour_days(self):
        for now in (datetime(2026,3,29,20,tzinfo=timezone.utc),datetime(2026,10,25,22,tzinfo=timezone.utc)):
            today=now.astimezone(parse_datetime('2026-01-01').tzinfo).date()
            self.check('today',today.isoformat(),True,now)
        for hour in (0,1):
            self.check('today','2026-10-25',True,datetime(2026,10,25,hour,30,tzinfo=timezone.utc))

    def test_date_only_expiry_includes_entire_day(self):
        job={'expires_at':'2026-10-14'}
        self.assertTrue(active(job,datetime(2026,10,14,21,59,tzinfo=timezone.utc)))
        self.assertFalse(active(job,datetime(2026,10,14,22,0,tzinfo=timezone.utc)))
        job={'expires_at':'2026-10-14T00:00:00+00:00','expires_date_only':True}
        self.assertTrue(active(job,datetime(2026,10,14,21,59,tzinfo=timezone.utc)))

    def test_filters_combine_with_and(self):
        self.settings.update(keywords=['python','kuvar'],exclusions=['senior'],city='belgrade',remote='only',language='russian',freshness='7',min_salary=1000)
        self.job.update(location='Београд',languages=['ru','en'],published_at='2026-10-14')
        self.assertTrue(matches(self.job,self.settings,self.now))
        for change in [{'description':'Senior Python'}, {'location':'Novi Sad'}, {'remote':None,'description':'Russian speakers welcome'}, {'languages':[],'description':'Remote role'}, {'salary_min':900}, {'published_at':None}]:
            self.assertFalse(matches(dict(self.job,**change),self.settings,self.now),change)


class FactsTests(unittest.TestCase):
    def test_explicit_languages_and_multiple_requirements(self):
        self.assertEqual(language_facts('Russian language required; English language mandatory; Serbian is not required.'),(['ru','en'],['ru','en']))
        self.assertEqual(language_facts('Мы ищем разработчика. Сербская компания.'),([],[]))
        self.assertEqual(language_facts('Experience with Russian language datasets required.'),([],[]))
        settings=default_settings();settings['language']='serbian'
        self.assertFalse(matches(vacancy(languages=[]),settings))
        self.assertTrue(matches(vacancy(languages=['sr','en']),settings))

    def test_remote_hybrid_and_technical_remote_mentions(self):
        self.assertIsNone(remote_fact('Implement remote procedure calls and remote debugging.'))
        self.assertFalse(remote_fact('Hybrid position with remote work twice a week'))
        self.assertTrue(remote_fact('Fully remote role'))
        self.assertFalse(remote_fact('On-site only, no remote work'))

    def test_salary_period_range_and_maximum(self):
        self.assertEqual(text_salary('1000–2000 EUR / month'),(1000,'EUR','month'))
        self.assertEqual(text_salary('до 2000 EUR в месяц'),(None,'EUR','month'))
        self.assertEqual(text_salary('25 EUR / hour'),(None,'EUR','hour'))
        self.assertEqual(text_salary('60000 EUR / year'),(None,'EUR','year'))
        self.assertEqual(text_salary('120.000,50 RSD mesečno'),(120000.5,'RSD','month'))
        settings=default_settings();settings['include_unknown_salary']=False
        self.assertFalse(matches(vacancy(salary_min=None),settings))

    def test_foreign_country_and_remote_residency(self):
        settings=default_settings()
        for fields in [{'country':'DE'}, {'eligible_countries':['US']}, {'country':'RU','remote':True}]:
            self.assertFalse(matches(vacancy(**fields),settings))
        self.assertTrue(matches(vacancy(eligible_countries=['Serbia']),settings))
        foreign=enrich(Job('radim','https://radim.rs/jobs/1','Developer',location='Berlin, Germany'))
        self.assertFalse(matches(foreign.__dict__,settings))



class MigrationTests(unittest.TestCase):
    def test_original_sqlite_migrates_without_losing_users_or_history(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'legacy.db'
            store=Store(path);store.ensure_user(1,1);store.update_settings(1,keywords=['python'],notifications='daily')
            store.save_jobs([vacancy(published_at='2026-10-01',publication_date_only=True)])
            job=store.list_jobs()[0];store.mark_delivered(1,job['id'])
            with sqlite3.connect(path) as db:
                for col in Store.JSON_FIELDS+('country','salary_period','salary_display','publication_date_only','expires_date_only'):
                    db.execute(f'ALTER TABLE jobs DROP COLUMN {col}')
                settings=json.loads(db.execute('SELECT settings FROM users WHERE user_id=1').fetchone()[0]);settings.pop('freshness')
                db.execute('UPDATE users SET settings=?',(json.dumps(settings),))
            migrated=Store(path)
            self.assertEqual(migrated.get_settings(1)['keywords'],['python'])
            self.assertEqual(migrated.get_settings(1)['freshness'],'any')
            self.assertEqual(migrated.delivered_job_ids(1),{job['id']})
            migrated.save_jobs([vacancy(published_at='2026-10-14')])
            self.assertEqual(migrated.list_jobs()[0]['published_at'],'2026-10-01')

    def test_threaded_settings_updates_and_database_leases(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as tmp:
            store=Store(Path(tmp)/'test.db');store.ensure_user(1,1)
            with ThreadPoolExecutor(2) as pool:
                futures=[pool.submit(store.update_settings,1,**fields) for fields in [{'city':'nis'},{'freshness':'7'}]]
                for future in futures:future.result()
            self.assertEqual((store.get_settings(1)['city'],store.get_settings(1)['freshness']),('nis','7'))
            self.assertTrue(store.acquire_lease('collection','a'))
            self.assertFalse(Store(store.path).acquire_lease('collection','b'))
            store.release_lease('collection','b')
            self.assertFalse(store.acquire_lease('collection','b'))
            store.release_lease('collection','a')
            self.assertTrue(store.acquire_lease('collection','b'))
