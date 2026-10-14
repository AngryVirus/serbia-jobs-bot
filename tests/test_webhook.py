import asyncio
import io
import tempfile
from pathlib import Path
import unittest

from bot import Bot
from store import Store
from web_server import WebhookProcessor, make_handler


class FakeAPI:
    def __init__(self):
        self.messages = []

    async def call(self, method, **params):
        return {}

    async def send(self, chat, text, rows=None):
        self.messages.append((chat, text, rows))
        return {}


def message(update_id, text):
    return {"update_id": update_id, "message": {"chat": {"id": 1, "type": "private"},
                                               "from": {"id": 1}, "text": text}}


def callback(update_id, data):
    return {"update_id": update_id, "callback_query": {"id": str(update_id), "from": {"id": 1},
            "data": data, "message": {"chat": {"id": 1, "type": "private"}, "message_id": 3}}}


class WebhookTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.directory.name) / "test.db")
        self.api = FakeAPI()
        self.bot = Bot(self.api, self.store)
        self.processor = WebhookProcessor(self.bot)

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_duplicate_toggle_is_processed_once(self):
        update = callback(100, "toggle_salary")
        await asyncio.gather(self.processor.update(update), self.processor.update(update))
        self.assertFalse(self.store.get_settings(1)["include_unknown_salary"])
        restarted = WebhookProcessor(Bot(self.api, self.store))
        await restarted.update(update)
        self.assertFalse(self.store.get_settings(1)["include_unknown_salary"])

    async def test_input_survives_sleep_restart(self):
        await self.processor.update(callback(100, "input:keywords"))
        restarted = WebhookProcessor(Bot(self.api, self.store))
        await restarted.update(message(101, "python, kuvar"))
        self.assertEqual(self.store.get_settings(1)["keywords"], ["python", "kuvar"])
        self.assertIsNone(self.store.get_settings(1)["pending_input"])

    async def test_delete_does_not_recreate_user(self):
        await self.processor.update(message(100, "/start"))
        await self.processor.update(callback(101, "delete_confirm"))
        self.assertEqual(self.store.subscribers(), [])
        await self.processor.update(callback(101, "delete_confirm"))
        self.assertEqual(self.store.subscribers(), [])

    async def test_collect_is_not_run_concurrently(self):
        started = asyncio.Event()
        release = asyncio.Event()
        async def scan():
            started.set()
            await release.wait()
        async def notify():
            pass
        self.bot.scan = scan
        self.bot.notify = notify
        self.assertEqual(await self.processor.collect(), "started")
        await started.wait()
        self.assertEqual(await self.processor.collect(), "already_running")
        release.set()
        await self.processor.collection


class WebhookAccessTests(unittest.TestCase):
    def test_endpoints_reject_wrong_secrets_before_processing(self):
        handler_type = make_handler(None, None, "correct-webhook", "correct-collect")
        for path, header in (("/telegram", "X-Telegram-Bot-Api-Secret-Token"),
                             ("/collect", "X-Collect-Secret")):
            with self.subTest(path=path):
                handler = object.__new__(handler_type)
                handler.path = path
                handler.headers = {header: "incorrect", "Content-Length": "10"}
                handler.rfile = io.BytesIO(b'not-json!')
                responses = []
                handler.respond = lambda status, value: responses.append(status)
                handler.do_POST()
                self.assertEqual(responses, [403])
                self.assertEqual(handler.rfile.tell(), 0)


if __name__ == "__main__":
    unittest.main()
