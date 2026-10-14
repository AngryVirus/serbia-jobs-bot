"""Polling must not acknowledge updates whose processing has failed."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from bot import Bot
from telegram_api import TelegramError


class PollingTests(unittest.IsolatedAsyncioTestCase):
    async def run_polling(self, batches, process):
        api = type('API', (), {})()
        api.call = AsyncMock(side_effect=[*batches, TelegramError('Stop test', 401)])
        bot = Bot(api, None)
        bot.configure = AsyncMock()
        bot.scheduler = AsyncMock()
        with patch('web_server.WebhookProcessor.update', new=process), \
                patch('bot.asyncio.sleep', new_callable=AsyncMock) as sleep, \
                self.assertLogs('serbia_jobs', level='ERROR'):
            with self.assertRaises(TelegramError) as caught:
                await bot.run()
        self.assertEqual(caught.exception.code, 401)
        return [call.kwargs['offset'] for call in api.call.await_args_list], sleep

    async def test_failed_update_and_remaining_batch_are_retried_in_order(self):
        for failed_id in (10, 11):
            with self.subTest(failed_id=failed_id):
                updates = [{'update_id': number} for number in (10, 11, 12)]
                attempts, completed = [], []

                async def process(update):
                    number = update['update_id']
                    attempts.append(number)
                    if number == failed_id and attempts.count(number) == 1:
                        raise RuntimeError('Temporary storage failure')
                    completed.append(number)

                offsets, sleep = await self.run_polling(
                    [updates, [u for u in updates if u['update_id'] >= failed_id]],
                    AsyncMock(side_effect=process))
                self.assertEqual(offsets, [0, 0 if failed_id == 10 else 11, 13])
                self.assertEqual(attempts, list(range(10, failed_id + 1)) + list(range(failed_id, 13)))
                self.assertEqual(completed, [10, 11, 12])
                sleep.assert_awaited_once_with(5)

    async def test_persistent_failure_never_advances_or_processes_later_updates(self):
        updates = [{'update_id': 10}, {'update_id': 11}]
        process = AsyncMock(side_effect=RuntimeError('Storage unavailable'))
        offsets, sleep = await self.run_polling([updates, updates, updates], process)
        self.assertEqual(offsets, [0, 0, 0, 0])
        self.assertEqual([call.args[0]['update_id'] for call in process.await_args_list], [10, 10, 10])
        self.assertEqual(sleep.await_count, 3)
        self.assertTrue(all(call.args == (5,) for call in sleep.await_args_list))

    async def test_cancellation_stops_polling_and_scheduler(self):
        scheduler_started = asyncio.Event()
        scheduler_stopped = asyncio.Event()

        async def scheduler():
            scheduler_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                scheduler_stopped.set()

        async def process(update):
            await scheduler_started.wait()
            raise asyncio.CancelledError

        api = type('API', (), {})()
        api.call = AsyncMock(return_value=[{'update_id': 10}])
        bot = Bot(api, None)
        bot.configure = AsyncMock()
        bot.scheduler = scheduler
        with patch('web_server.WebhookProcessor.update', new=AsyncMock(side_effect=process)):
            with self.assertRaises(asyncio.CancelledError):
                await bot.run()
        api.call.assert_awaited_once()
        self.assertTrue(scheduler_stopped.is_set())
