import asyncio
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from bot import Bot
from sources import Job, SOURCES
from store import Store
from test_bot import FakeAPI, callback, vacancy
from test_cloud_store import MemorySupabaseStore


class InstantNotificationTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_migrates_legacy_before_saving_newly_discovered_jobs(self):
        store = MemorySupabaseStore()
        store.ensure_user(1, 1)
        store.tables['sj_users'][0]['settings'] = {'notifications': 'daily'}
        store.save_jobs([vacancy()])
        api = FakeAPI(); bot = Bot(api, store)
        def collect(*, on_source):
            jobs = [Job(**vacancy(url='https://www.poslovi.rs/job/new'))]
            status = {'state': 'ok', 'count': 1}
            on_source('poslovi', jobs, status)
            return jobs, {'poslovi': status}
        with patch('bot.collect_all', side_effect=collect):
            self.assertTrue(await bot.scan())
        self.assertEqual(len(api.sent), 1)
        self.assertIn('/job/new', api.sent[0]['text'])

    async def test_long_scan_renews_its_collection_lease(self):
        store = MemorySupabaseStore(); bot = Bot(FakeAPI(), store)
        original_acquire = store.acquire_lease
        original_sleep = asyncio.sleep
        renewed = asyncio.Event(); release = threading.Event()
        loop = asyncio.get_running_loop()
        calls = []
        def acquire(key, owner, seconds=900):
            calls.append(key)
            result = original_acquire(key, owner, seconds)
            if calls.count('collection') > 1:
                loop.call_soon_threadsafe(renewed.set)
            return result
        async def sleep(seconds):
            await original_sleep(0.01 if seconds == 60 else seconds)
        def collect(*, on_source):
            if not release.wait(5): raise RuntimeError('Slow test source not released')
            return [], {}
        with patch.object(store, 'acquire_lease', side_effect=acquire), \
                patch('bot.asyncio.sleep', side_effect=sleep), patch('bot.collect_all', side_effect=collect):
            task = asyncio.create_task(bot.scan())
            try:
                await asyncio.wait_for(renewed.wait(), 2)
                self.assertFalse(task.done())
            finally:
                release.set()
                self.assertTrue(await task)
        self.assertNotIn('collection', store.leases)

    async def test_legacy_subscription_sets_baseline_without_sending_archive(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            for store in (Store(Path(directory) / 'legacy.db'), MemorySupabaseStore()):
                store.ensure_user(1, 1)
                raw = {'notifications': 'daily', 'daily_hour': 23}
                if isinstance(store, Store):
                    with store._connection() as conn:
                        conn.execute('UPDATE users SET settings=? WHERE user_id=1', (json.dumps(raw),))
                else:
                    store.tables['sj_users'][0]['settings'] = raw
                store.save_jobs([vacancy()])
                api = FakeAPI(); bot = Bot(api, store)
                await bot.notify()
                self.assertEqual(api.sent, [])
                self.assertEqual(store.get_settings(1)['notifications_after_id'], store.latest_job_id())
                store.save_jobs([vacancy(url='https://www.poslovi.rs/job/new')])
                await bot.notify()
                self.assertEqual(len(api.sent), 1)

    async def test_telegram_post_flows_through_filters_storage_maps_and_notifications(self):
        from telegram_sources import post_job
        from test_telegram_sources import DATE
        post = {'id': 123, 'date': DATE, 'text':
                'Вакансия\nPython developer\nBeograd\nEnglish required\nAddress: Knez Mihailova 12'}
        job = post_job(SOURCES['telegram_serbia_jobs'], post)
        with tempfile.TemporaryDirectory() as directory:
            for store in (Store(Path(directory) / 'telegram.db'), MemorySupabaseStore()):
                api = FakeAPI(); bot = Bot(api, store)
                await bot.handle(callback(1, 'notify:instant'))
                store.update_settings(1, city=['belgrade'], language=['english'], sources=['poslovi'])
                store.save_jobs([job])
                await bot.notify()
                self.assertEqual(len(api.sent), 1)
                self.assertIn('https://t.me/serbia_jobs/123', api.sent[0]['text'])
                self.assertIn('Google Maps', str(api.sent[0]['rows']))
                # Editing a source post preserves identity and delivery history.
                job.description += '\nSalary: 2000 EUR / month'
                store.save_jobs([job])
                await Bot(api, store).notify()
                self.assertEqual(len(api.sent), 1)

    async def test_enable_ignores_old_catalog_repeated_click_and_reenable_are_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            for store in (Store(Path(directory) / 'jobs.db'), MemorySupabaseStore()):
                with self.subTest(store=type(store).__name__):
                    api = FakeAPI(); bot = Bot(api, store)
                    store.save_jobs([vacancy()])
                    await bot.handle(callback(1, 'notify:instant'))
                    baseline = store.get_settings(1)['notifications_after_id']
                    self.assertEqual(baseline, store.latest_job_id())
                    store.save_jobs([vacancy(url='https://www.poslovi.rs/job/2')])
                    # A stale enable button cannot move the baseline past a new job.
                    await bot.handle(callback(1, 'notify:instant'))
                    self.assertEqual(store.get_settings(1)['notifications_after_id'], baseline)
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    await Bot(api, store).notify()
                    self.assertEqual(len(api.sent), 1)
                    await bot.handle(callback(1, 'notify:off'))
                    store.save_jobs([vacancy(url='https://www.poslovi.rs/job/3')])
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    await bot.handle(callback(1, 'notify:instant'))
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    store.save_jobs([vacancy(url='https://www.poslovi.rs/job/4')])
                    await bot.notify()
                    self.assertEqual(len(api.sent), 2)

    async def test_all_new_matches_send_without_daily_wait_or_ten_job_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'jobs.db')
            api = FakeAPI(); bot = Bot(api, store)
            store.ensure_user(1, 1)
            # Previously enabled daily users now receive new jobs immediately.
            store.update_settings(1, notifications='daily', daily_hour=23, city=['belgrade'])
            store.ensure_user(2, 2)
            jobs = [vacancy(url=f'https://www.poslovi.rs/job/{number}') for number in range(12)]
            jobs.append(vacancy(url='https://www.poslovi.rs/job/nis', location='Nis'))
            store.save_jobs(jobs)
            hidden = store.list_jobs()[-1]['id']
            store.update_settings(1, hidden_jobs=[hidden])
            await bot.notify()
            self.assertEqual(len(api.sent), 11)
            self.assertEqual({m['chat_id'] for m in api.sent}, {1})
            self.assertFalse(store.has_delivered(1, hidden))
            await bot.notify()
            self.assertEqual(len(api.sent), 11)

    async def test_menu_is_a_direct_explicit_switch_without_daily_or_source_choices(self):
        store = MemorySupabaseStore(); api = FakeAPI(); bot = Bot(api, store)
        await bot.handle(callback(1, 'menu'))
        panel = api.calls[-1][1]
        self.assertIn('🔕 Уведомления: выкл', str(panel))
        self.assertIn('notify:instant', str(panel))
        await bot.handle(callback(1, 'notify:instant'))
        panel = api.calls[-1][1]
        self.assertIn('🔔 Уведомления: вкл', str(panel))
        self.assertIn('notify:off', str(panel))
        await bot.handle(callback(1, 'notifications'))  # Previously sent menu button.
        panel = api.calls[-1][1]
        self.assertNotIn('Раз в день', str(panel))
        self.assertNotIn('input:hour', str(panel))
        self.assertNotIn('source:', str(panel))

    async def test_completed_source_sends_before_slow_source_finishes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'jobs.db')
            api = FakeAPI(); bot = Bot(api, store)
            store.ensure_user(1, 1); store.update_settings(1, notifications='instant')
            sent = asyncio.Event()
            release = threading.Event()
            original_send = api.send
            async def send(*args, **kwargs):
                result = await original_send(*args, **kwargs)
                sent.set()
                return result
            api.send = send
            def collect(source):
                if source.id == 'workforce':
                    if not release.wait(10): raise RuntimeError('Test did not release slow source')
                    return [], {'state': 'empty', 'count': 0}
                return [Job(**vacancy())], {'state': 'ok', 'count': 1}
            with patch.dict('sources.SOURCES', {key: SOURCES[key] for key in ('poslovi', 'workforce')}, clear=True), \
                    patch('sources.collect_source', side_effect=collect):
                task = asyncio.create_task(bot.scan())
                try:
                    await asyncio.wait_for(sent.wait(), 5)
                    self.assertFalse(task.done())
                    self.assertEqual(len(api.sent), 1)
                finally:
                    release.set()
                    self.assertTrue(await task)
            await bot.notify()
            self.assertEqual(len(api.sent), 1)
