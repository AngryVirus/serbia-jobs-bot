import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import build_opener, ProxyHandler, Request
import socket
from bot import Bot, MENU, HELP_URL, job_text, job_buttons
from filters import matches, parse_datetime, active
from job_metadata import enrich, language_facts, remote_fact, text_salary
from sources import SOURCES, Job, extract_jobs, collect_source
from store import Store, default_settings
from version import VERSION
from web_server import serve, WebhookProcessor
from test_bot import FakeAPI, message, callback, vacancy


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
                              'any': [('2001-01-01',True),(None,True)]}.items():
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
        for change in [{'description':'Senior Python'}, {'location':'Novi Sad'}, {'remote':None}, {'languages':[]}, {'salary_min':900}, {'published_at':None}]:
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

    def test_actual_contact_extraction_and_unsafe_link(self):
        job=enrich(Job('radim','https://radim.rs/jobs/1','Support',description='Contact hr@example.org or https://t.me/ExampleHR'))
        self.assertEqual(job.contacts,['hr@example.org','https://t.me/ExampleHR'])
        self.assertEqual(job_buttons(vacancy(url='javascript:alert(1)')),[])
        self.assertEqual(job_buttons(vacancy(url='https://example.org/')),[])


class ProductTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'jobs.db'
        self.store=Store(self.path);self.api=FakeAPI();self.bot=Bot(self.api,self.store)
        await self.bot.handle(message(1,'/start'))

    async def asyncTearDown(self): self.temp.cleanup()

    async def test_menu_help_retired_commands_and_language_options(self):
        flat=[b for row in MENU for b in row]
        self.assertEqual([b['text'] for b in flat],['🔎 Найти вакансии','⚙️ Фильтры','🔔 Уведомления','🙈 Скрытые вакансии','💬 Помощь'])
        await self.bot.handle(callback(1, flat[-1]['callback_data']))
        help_panel = self.api.calls[-1][1]
        self.assertIn('В случае неисправностей или выявленных ошибок', help_panel['text'])
        self.assertIn('@AngryVirus', help_panel['text'])
        help_rows = help_panel['reply_markup']['inline_keyboard']
        self.assertEqual(help_rows[0][0]['url'], 'https://t.me/AngryVirus')
        await self.bot.handle(callback(1, help_rows[-1][0]['callback_data']))
        self.assertEqual(self.api.calls[-1][1]['reply_markup']['inline_keyboard'], MENU)
        await self.bot.configure()
        commands=next(p['commands'] for m,p in self.api.calls if m=='setMyCommands')
        self.assertEqual([c['command'] for c in commands],['start','menu','cancel','delete_me'])
        await self.bot.handle(callback(1,'language'))
        rows=self.api.calls[-1][1]['reply_markup']['inline_keyboard']
        options=[b for row in rows for b in row if b.get('callback_data','').startswith('choose:language:')]
        self.assertEqual([b['text'] for b in options],['▫️ 🇷🇺 Русский','▫️ 🇷🇸 Сербский','▫️ 🇬🇧 Английский','✅ 🌍 Не важно'])
        for text in ['/sources','/favorites']:
            await self.bot.handle(message(1,text))
            self.assertEqual(self.api.sent[-1]['rows'],MENU)

    async def test_freshness_isolation_reset_and_cancel(self):
        await self.bot.handle(message(2,'/start'))
        await self.bot.handle(callback(1,'set:freshness:today'))
        self.assertEqual(Store(self.path).get_settings(1)['freshness'],'today')
        self.assertEqual(self.store.get_settings(2)['freshness'],'any')
        await self.bot.handle(callback(1,'input:keywords'))
        self.assertIn('Отменить',self.api.calls[-1][1]['reply_markup']['inline_keyboard'][0][0]['text'])
        await self.bot.handle(callback(1,'cancel'))
        self.assertIsNone(self.store.get_settings(1)['pending_input'])
        await self.bot.handle(callback(1,'reset'))
        self.assertEqual(self.store.get_settings(1)['freshness'],'any')

    async def test_collection_empty_and_failure_are_different(self):
        await self.bot.results(1,1)
        self.assertIn('База ещё наполняется',self.api.sent[-1]['text'])
        self.bot.scanning=True
        await self.bot.results(1,1)
        self.assertIn('проверяем вакансии',self.api.sent[-1]['text'])
        self.bot.scanning=False
        self.store.set_source_status({'poslovi':{'state':'error'}})
        await self.bot.results(1,1)
        self.assertIn('временно недоступны',self.api.sent[-1]['text'])
        self.store.set_source_status({'poslovi':{'state':'ok'}})
        await self.bot.results(1,1)
        self.assertIn('Подходящих вакансий нет',self.api.sent[-1]['text'])

    async def test_complete_parse_save_filter_search_notification_path(self):
        node={'@type':'JobPosting','title':'Support & A','url':'https://radim.rs/jobs/support-1',
              'description':'Russian language required. English language mandatory. Contact hr@example.org',
              'datePosted':datetime.now(timezone.utc).isoformat(),'jobLocationType':'TELECOMMUTE',
              'jobLocation':{'address':{'addressLocality':'Beograd','addressCountry':'RS'}},
              'baseSalary':{'currency':'EUR','value':{'minValue':1500,'unitText':'MONTH'}}}
        jobs=extract_jobs(SOURCES['radim'],'<script type="application/ld+json">'+json.dumps(node)+'</script>',node['url'])
        self.assertEqual(self.store.save_jobs(jobs),1)
        self.assertEqual(self.store.save_jobs(jobs),0)
        self.store.update_settings(1,city='belgrade',language='russian',remote='only',freshness='today',notifications='instant')
        await self.bot.results(1,1)
        card=next(m for m in self.api.sent if 'Support &amp; A' in m['text'])
        self.assertIn('href="https://radim.rs/jobs/support-1"',card['text'])
        self.assertEqual(card['rows'][0][0]['url'],node['url'])
        self.api.sent.clear()
        await self.bot.notify()
        self.assertIn('Support &amp; A',self.api.sent[0]['text'])
        self.assertEqual(self.api.sent[0]['rows'][0][0]['url'],node['url'])
        restarted=Bot(self.api,Store(self.path))
        await asyncio.gather(self.bot.notify(),restarted.notify())
        self.assertEqual(len(self.api.sent),1)

    async def test_pagination_and_missing_contacts(self):
        self.store.save_jobs([vacancy(url=f'https://www.poslovi.rs/job/{i}') for i in range(12)])
        await self.bot.results(1,1)
        cards=[m for m in self.api.sent if '<b>Python developer</b>' in m['text']]
        self.assertEqual(len(cards),5)
        self.assertTrue(all(m['rows'][0][0]['text']=='🔗 Открыть объявление' for m in cards))
        self.assertEqual(self.api.sent[-1]['rows'][0][0]['callback_data'],
                         f'search:1:{self.store.list_jobs()[4]["id"]}')

    async def test_durable_webhook_claim_in_two_processors(self):
        first=WebhookProcessor(self.bot);second=WebhookProcessor(Bot(self.api,Store(self.path)))
        update={'update_id':100,**callback(1,'toggle_salary')}
        await asyncio.gather(first.update(update),second.update(update))
        self.assertFalse(self.store.get_settings(1)['include_unknown_salary'])
        await second.update(update)
        self.assertFalse(self.store.get_settings(1)['include_unknown_salary'])

    async def test_slow_user_does_not_block_other_user(self):
        started=threading.Event();release=threading.Event()
        original=self.bot._handle
        async def handle(update, prepared_settings=None, acknowledged=False):
            uid=update.get('message',{}).get('from',{}).get('id')
            if uid==1:
                started.set();await asyncio.to_thread(release.wait,2)
            await original(update, prepared_settings, acknowledged)
        self.bot._handle=handle
        task=asyncio.create_task(self.bot.handle(message(1,'/menu')))
        await asyncio.to_thread(started.wait,1)
        try:
            await asyncio.wait_for(self.bot.handle(message(2,'/start')),1)
            self.assertIsNotNone(self.store.get_subscriber(2))
        finally:
            release.set();await task

    async def test_startup_starts_collector_and_serves_versioned_health(self):
        event=asyncio.Event()
        async def scan():event.set();return True
        self.bot.scan=scan
        self.bot.notify=lambda: asyncio.sleep(0)
        sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
        server=asyncio.create_task(serve(self.bot,'https://example.test','w'*32,'c'*32,port))
        try:
            await asyncio.wait_for(event.wait(),3)
            def request():
                with build_opener(ProxyHandler({})).open(f'http://127.0.0.1:{port}/health',timeout=2) as r:return json.load(r)
            body=await asyncio.to_thread(request)
            self.assertEqual(body,{'ok':True,'version':VERSION})
        finally:
            server.cancel();await asyncio.gather(server,return_exceptions=True)


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
