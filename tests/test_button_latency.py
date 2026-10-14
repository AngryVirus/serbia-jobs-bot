"""Bound database round trips without weakening webhook consistency."""
import asyncio
from pathlib import Path
import tempfile
import unittest

from bot import Bot
from cloud_store import CloudStoreError
from store import Store
from telegram_api import TelegramError
from test_bot import FakeAPI, callback
from test_cloud_store import MemorySupabaseStore
from web_server import WebhookProcessor


class ButtonLatencyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        claims = Store(Path(self.temp.name) / 'claims.db')
        self.trace = trace = []

        class Cloud(MemorySupabaseStore):
            fail_patch = False

            def _request(self, method, table, params=None, data=None, prefer=None):
                trace.append(('db', table))
                if table == 'rpc/sj_patch_settings' and self.fail_patch:
                    raise CloudStoreError('Simulated failed write')
                if table in ('rpc/sj_claim_update', 'rpc/sj_finish_update', 'rpc/sj_release_update'):
                    name = table.removeprefix('rpc/sj_')
                    args = [data['p_update_id'], data['p_owner']]
                    if name == 'claim_update': args.append(data['p_seconds'])
                    return getattr(claims, name)(*args)
                return super()._request(method, table, params, data, prefer)

        class API(FakeAPI):
            fail_ack = False

            async def call(self, method, **params):
                trace.append(('telegram', method))
                if method == 'answerCallbackQuery' and self.fail_ack:
                    raise TelegramError('query is too old', 400)
                return await super().call(method, **params)

        self.store, self.api = Cloud(), API()
        self.bot = Bot(self.api, self.store)
        self.processor = WebhookProcessor(self.bot)

    def tearDown(self):
        self.temp.cleanup()

    async def press(self, update_id, action, uid=1):
        await self.processor.update({'update_id': update_id, **callback(uid, action)})

    async def test_acknowledgement_precedes_db_and_buttons_have_bounded_round_trips(self):
        for update_id, action, total, before_edit in ((1, 'menu', 5, 3),
                                                     (2, 'choose:language:english:1', 6, 4)):
            with self.subTest(action=action):
                self.trace.clear()
                await self.press(update_id, action)
                self.assertEqual(self.trace[0], ('telegram', 'answerCallbackQuery'))
                edit = self.trace.index(('telegram', 'editMessageText'))
                db = [table for kind, table in self.trace if kind == 'db']
                self.assertLessEqual(len(db), total)
                self.assertLessEqual(sum(kind == 'db' for kind, _ in self.trace[:edit]), before_edit)
                for rpc in ('sj_claim_update', 'sj_acquire_lease', 'sj_finish_update', 'sj_release_lease'):
                    self.assertIn('rpc/' + rpc, db)
        panel = self.api.calls[-1][1]
        self.assertIn('✅ 🇬🇧 Английский', str(panel['reply_markup']))

    async def test_snapshot_does_not_cross_requests_users_or_direct_reads(self):
        await asyncio.gather(self.press(10, 'choose:language:english:1', 1),
                             self.press(11, 'choose:language:russian:1', 2))
        self.assertEqual(self.store.get_settings(1)['language'], ['english'])
        self.assertEqual(self.store.get_settings(2)['language'], ['russian'])
        # A change from outside the previous handler must be seen on the next click.
        self.store.update_settings(1, city=['nis'], language=['serbian'])
        await self.press(12, 'menu')
        text = self.api.calls[-1][1]['text']
        self.assertIn('Ниш', text)
        self.assertIn('Сербский', text)
        self.assertNotIn('Английский', text)
        self.store.update_settings(1, city=['subotica'])
        self.assertEqual(self.bot.get_settings(1)['city'], ['subotica'])

    async def test_failed_patch_can_retry_without_fake_selection_or_lost_other_preferences(self):
        self.store.ensure_user(1, 1)
        self.store.update_settings(1, city=['nis'], hidden_jobs=[123], notifications='daily')
        self.store.fail_patch = True
        with self.assertRaises(CloudStoreError):
            await self.press(20, 'choose:language:english:1')
        self.assertEqual(self.store.get_settings(1)['language'], 'any')
        self.store.fail_patch = False
        await self.press(20, 'choose:language:english:1')
        saved = self.store.get_settings(1)
        self.assertEqual(saved['language'], ['english'])
        self.assertEqual(saved['city'], ['nis'])
        self.assertEqual(saved['hidden_jobs'], [123])
        self.assertEqual(saved['notifications'], 'daily')
        await self.press(20, 'choose:language:english:1')
        self.assertEqual(self.store.get_settings(1), saved)

    async def test_expired_acknowledgement_does_not_drop_action_or_repeat_toggle(self):
        self.api.fail_ack = True
        await self.press(30, 'toggle_salary')
        self.assertFalse(self.store.get_settings(1)['include_unknown_salary'])
        await self.press(30, 'toggle_salary')
        self.assertFalse(self.store.get_settings(1)['include_unknown_salary'])
