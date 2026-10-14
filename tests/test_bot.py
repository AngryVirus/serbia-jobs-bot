"""Bot integration tests use real SQLite state and a local Telegram stand-in."""

from datetime import datetime, timezone
from html import escape
from pathlib import Path
import tempfile
import unittest

from bot import Bot, daily_due, job_text
from store import Store, default_settings
from telegram_api import TelegramError


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.sent = []
        self.failures = {}

    async def call(self, method, **params):
        self.calls.append((method, params))
        return {"message_id": len(self.calls)}

    async def send(self, chat_id, text, rows=None):
        error = self.failures.pop(chat_id, None)
        if error:
            raise error
        self.sent.append({"chat_id": chat_id, "text": text, "rows": rows})
        return {"message_id": len(self.sent)}

    def text_for(self, chat_id):
        return "\n".join(entry["text"] for entry in self.sent if entry["chat_id"] == chat_id)


def message(uid, text, chat_type="private"):
    return {"message": {"message_id": 1, "from": {"id": uid},
                        "chat": {"id": uid, "type": chat_type}, "text": text}}


def callback(uid, action, chat_type="private"):
    return {"callback_query": {"id": f"query-{uid}", "from": {"id": uid}, "data": action,
                               "message": {"message_id": 1,
                                           "chat": {"id": uid, "type": chat_type}}}}


def vacancy(**changes):
    result = {
        "source": "poslovi", "url": "https://www.poslovi.rs/job/1", "title": "Python developer",
        "company": "Example", "location": "Beograd", "description": "Remote opportunity",
        "salary_min": 1500, "salary_currency": "EUR", "remote": True, "russian": True,
        "serbian_required": False, "published_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": None,
    }
    result.update(changes)
    return result


class BotIntegrationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "test.sqlite3"
        self.store = Store(self.path)
        self.api = FakeAPI()
        self.bot = Bot(self.api, self.store)

    def tearDown(self):
        self.temp.cleanup()

    async def start(self, uid):
        await self.bot.handle(message(uid, "/start"))

    async def test_users_keep_independent_pending_filters_and_search_results(self):
        for uid in (1, 2):
            await self.start(uid)
            await self.bot.handle(callback(uid, "input:keywords"))
        await self.bot.handle(message(1, "Python, Python, developer"))
        self.assertEqual(self.bot.pending.get(2), "keywords")
        await self.bot.handle(message(2, "kuvar"))
        await self.bot.handle(callback(1, "set:city:belgrade"))
        self.assertEqual(self.store.get_settings(1)["keywords"], ["Python", "developer"])
        self.assertEqual(self.store.get_settings(2)["keywords"], ["kuvar"])
        self.assertEqual(self.store.get_settings(2)["city"], "any")
        self.store.save_jobs([vacancy(), vacancy(url="https://www.poslovi.rs/job/2", title="Kuvar")])
        self.api.sent.clear()
        await self.bot.handle(callback(1, "search:0"))
        await self.bot.handle(callback(2, "search:0"))
        self.assertIn("Python developer", self.api.text_for(1))
        self.assertNotIn("<b>Kuvar</b>", self.api.text_for(1))
        self.assertIn("<b>Kuvar</b>", self.api.text_for(2))
        self.assertNotIn("Python developer", self.api.text_for(2))

    async def test_retired_buttons_cannot_change_preserved_user_data(self):
        for uid in (1, 2): await self.start(uid)
        self.store.save_jobs([vacancy()])
        job_id = self.store.list_jobs()[0]['id']
        self.store.set_favorite(1, job_id, True)
        before = self.store.get_settings(1)
        for action in ('sources', 'source:poslovi', 'favorites:0', f'favorite:{job_id}:0'):
            await self.bot.handle(callback(1, action))
        self.assertEqual(before, self.store.get_settings(1))
        self.assertEqual([job['id'] for job in self.store.favorites(1)], [job_id])
        self.assertEqual(self.store.favorites(2), [])
        self.assertNotIn('Источники', self.api.text_for(1))
        self.assertNotIn('Избранное', self.api.text_for(1))

    async def test_notifications_obey_opt_in_and_deduplicate_across_restarts(self):
        for uid in (1, 2):
            await self.start(uid)
        self.store.update_settings(1, notifications="instant")
        self.store.save_jobs([vacancy()])
        job_id = self.store.list_jobs()[0]["id"]
        self.api.sent.clear()
        await self.bot.notify()
        self.assertEqual([item["chat_id"] for item in self.api.sent], [1])
        self.assertTrue(self.store.has_delivered(1, job_id))
        self.assertFalse(self.store.has_delivered(2, job_id))
        self.api.sent.clear()
        await Bot(self.api, Store(self.path)).notify()
        self.assertEqual(self.api.sent, [])

    async def test_failed_notifications_are_retried_and_not_recorded_as_delivered(self):
        await self.start(1)
        self.store.update_settings(1, notifications="instant")
        self.store.save_jobs([vacancy()])
        job_id = self.store.list_jobs()[0]["id"]
        self.api.sent.clear()
        self.api.failures[1] = TelegramError("temporary unavailable", 503)
        await self.bot.notify()
        self.assertFalse(self.store.has_delivered(1, job_id))
        self.assertIsNone(self.store.subscribers()[0]["last_notified_at"])
        await self.bot.notify()
        self.assertTrue(self.store.has_delivered(1, job_id))
        self.assertEqual(len(self.api.sent), 1)

    async def test_blocked_telegram_user_has_notifications_disabled(self):
        await self.start(1)
        self.store.update_settings(1, notifications="instant")
        self.store.save_jobs([vacancy()])
        job_id = self.store.list_jobs()[0]["id"]
        self.api.sent.clear()
        self.api.failures[1] = TelegramError("bot was blocked by the user", 403)
        await self.bot.notify()
        self.assertEqual(self.store.get_settings(1)["notifications"], "off")
        self.assertFalse(self.store.has_delivered(1, job_id))
        await self.bot.notify()
        self.assertEqual(self.api.sent, [])

    async def test_delete_user_removes_subscription_and_stops_notification(self):
        await self.start(1)
        self.store.update_settings(1, notifications="instant")
        self.store.save_jobs([vacancy()])
        await self.bot.handle(message(1, "/delete_me"))
        self.assertEqual(len(self.store.subscribers()), 1)
        await self.bot.handle(callback(1, "delete_confirm"))
        self.assertEqual(self.store.subscribers(), [])
        self.api.sent.clear()
        await self.bot.notify()
        self.assertEqual(self.api.sent, [])

    async def test_group_updates_do_not_create_users_or_change_private_settings(self):
        await self.bot.handle(message(1, "/start", "supergroup"))
        self.assertEqual(self.store.subscribers(), [])
        self.assertEqual(self.api.sent, [])
        await self.start(1)
        await self.bot.handle(callback(1, "set:city:belgrade", "group"))
        self.assertEqual(self.store.get_settings(1)["city"], "any")
        answers = [params for method, params in self.api.calls if method == "answerCallbackQuery"]
        self.assertIn("личный чат", answers[-1]["text"])

    async def test_salary_and_hour_validation_preserves_previous_settings_and_persists_valid_input(self):
        await self.start(1)
        await self.bot.handle(callback(1, "input:salary"))
        await self.bot.handle(message(1, "1500,50 eur"))
        self.assertEqual(Store(self.path).get_settings(1)["min_salary"], 1500.5)
        await self.bot.handle(callback(1, "input:salary"))
        for invalid in ("-5 EUR", "1000 USD", "NaN EUR", "100000001 EUR", "1000"):
            await self.bot.handle(message(1, invalid))
            self.assertEqual(self.store.get_settings(1)["min_salary"], 1500.5)
            self.assertEqual(self.bot.pending.get(1), "salary")
        await self.bot.handle(message(1, "-"))
        self.assertIsNone(self.store.get_settings(1)["min_salary"])
        await self.bot.handle(callback(1, "input:hour"))
        await self.bot.handle(message(1, "24"))
        self.assertEqual(self.store.get_settings(1)["daily_hour"], 9)
        self.assertEqual(self.bot.pending.get(1), "hour")
        await self.bot.handle(message(1, "0"))
        self.assertEqual(Store(self.path).get_settings(1)["daily_hour"], 0)
        self.assertNotIn(1, self.bot.pending)

    async def test_invalid_callback_and_oversized_keywords_cannot_persist_invalid_values(self):
        await self.start(1)
        await self.bot.handle(callback(1, "set:remote:invented"))
        await self.bot.handle(callback(1, "input:keywords"))
        await self.bot.handle(message(1, "x" * 61))
        self.assertEqual(self.store.get_settings(1)["remote"], "any")
        self.assertEqual(self.store.get_settings(1)["keywords"], [])
        self.assertEqual(self.bot.pending.get(1), "keywords")
        await self.bot.handle(message(1, "/cancel"))
        self.assertNotIn(1, self.bot.pending)


class PresentationAndScheduleTests(unittest.TestCase):
    def test_card_escapes_html_from_all_job_fields_and_link(self):
        job = vacancy(title='<script>alert("x")</script>', company="A & B", location="<city>",
                      description='Click <b>this</b> & "that"',
                      url='https://example.org/job?name="bad"&source=<site>')
        text = job_text(job)
        self.assertNotIn("<script>", text)
        self.assertIn("&lt;script&gt;", text)
        self.assertIn("A &amp; B", text)
        self.assertIn("&lt;city&gt;", text)
        self.assertIn("&lt;b&gt;this&lt;/b&gt;", text)
        self.assertIn(f'href="{escape(job["url"], quote=True)}"', text)

    def test_daily_hour_uses_winter_and_summer_belgrade_offset(self):
        user = {"settings": default_settings(), "last_notified_at": None}
        for before, due in (("2026-01-14T07:59:00+00:00", "2026-01-14T08:00:00+00:00"),
                            ("2026-07-14T06:59:00+00:00", "2026-07-14T07:00:00+00:00"),
                            ("2026-03-29T06:59:00+00:00", "2026-03-29T07:00:00+00:00")):
            with self.subTest(due=due):
                self.assertFalse(daily_due(user, datetime.fromisoformat(before)))
                self.assertTrue(daily_due(user, datetime.fromisoformat(due)))

    def test_daily_notification_uses_local_calendar_day_and_does_not_repeat_at_dst_fall(self):
        user = {"settings": default_settings(), "last_notified_at": "2026-01-13T23:30:00+00:00"}
        self.assertFalse(daily_due(user, datetime.fromisoformat("2026-01-14T08:00:00+00:00")))
        user["last_notified_at"] = "2026-01-13T22:00:00+00:00"
        self.assertTrue(daily_due(user, datetime.fromisoformat("2026-01-14T08:00:00+00:00")))
        user["settings"]["daily_hour"] = 2
        user["last_notified_at"] = None
        first_2am = datetime.fromisoformat("2026-10-25T00:30:00+00:00")
        second_2am = datetime.fromisoformat("2026-10-25T01:30:00+00:00")
        self.assertTrue(daily_due(user, first_2am))
        user["last_notified_at"] = first_2am.isoformat()
        self.assertFalse(daily_due(user, second_2am))


if __name__ == "__main__":
    unittest.main()
