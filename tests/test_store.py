import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from store import SOURCE_IDS, Store


@dataclass
class SampleJob:
    source: str = "poslovi"
    url: str = "https://poslovi.rs/job/123"
    title: str = "Python developer"
    company: str = "Example"
    location: str = "Beograd"
    description: str = "Remote work, Russian language welcome"
    salary_min: int = 1500
    salary_currency: str = "EUR"
    remote: bool | None = True
    russian: bool | None = True
    serbian_required: bool | None = None
    published_at: str | None = None
    expires_at: str | None = None


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "nested" / "jobs.sqlite3"
        self.store = Store(self.path)
        self.store.ensure_user(1, 101)
        self.store.ensure_user(2, 202)

    def tearDown(self):
        self.temp.cleanup()

    def job_id(self):
        self.store.save_jobs([SampleJob()])
        return self.store.list_jobs()[0]["id"]

    def test_defaults_and_preferences_are_isolated_and_durable(self):
        first = self.store.get_settings(1)
        self.assertEqual(first["sources"], list(SOURCE_IDS))
        self.assertEqual(first["notifications"], "off")
        first["keywords"].append("mutating returned settings does not persist")
        self.assertEqual(self.store.get_settings(1)["keywords"], [])
        self.store.update_settings(1, keywords=["Python"], city="Beograd", notifications="daily")
        self.store.ensure_user(1, 111)
        fresh = Store(self.path)
        self.assertEqual(fresh.get_settings(1)["keywords"], ["Python"])
        self.assertEqual(fresh.get_settings(2)["keywords"], [])
        self.assertEqual(fresh.subscribers()[0]["chat_id"], 111)

    def test_updates_reject_unknown_keys_without_changing_existing_settings(self):
        with self.assertRaises(ValueError):
            self.store.update_settings(1, city="Novi Sad", nonexistent=True)
        self.assertEqual(self.store.get_settings(1)["city"], "any")

    def test_upsert_preserves_id_favorites_and_delivery(self):
        self.assertEqual(self.store.save_jobs([SampleJob()]), 1)
        initial = self.store.list_jobs()[0]
        job_id = initial["id"]
        self.store.set_favorite(1, job_id, True)
        self.store.mark_delivered(1, job_id)
        self.assertEqual(self.store.save_jobs([SampleJob(title="Senior Python developer", remote=False)]), 0)
        updated = self.store.get_job(job_id)
        self.assertEqual(updated["title"], "Senior Python developer")
        self.assertFalse(updated["remote"])
        self.assertIsNone(updated["serbian_required"])
        self.assertEqual(updated["created_at"], initial["created_at"])
        self.assertEqual(self.store.favorites(1)[0]["id"], job_id)
        self.assertTrue(self.store.has_delivered(1, job_id))

    def test_same_url_in_different_sources_is_a_separate_job(self):
        self.assertEqual(self.store.save_jobs([SampleJob(), SampleJob(source="careerjet")]), 2)
        self.assertEqual(len(self.store.list_jobs()), 2)

    def test_invalid_batch_rolls_back_every_job(self):
        with self.assertRaises(ValueError):
            self.store.save_jobs([SampleJob(), {"source": "poslovi", "url": "", "title": "Bad"}])
        self.assertEqual(self.store.list_jobs(), [])

    def test_favorites_and_delivery_are_per_user_and_survive_restart(self):
        job_id = self.job_id()
        self.store.set_favorite(1, job_id, True)
        self.store.set_favorite(1, job_id, True)
        self.store.mark_delivered(1, job_id)
        self.store.mark_delivered(1, job_id)
        self.assertEqual(len(Store(self.path).favorites(1)), 1)
        self.assertEqual(self.store.favorites(2), [])
        self.assertFalse(self.store.has_delivered(2, job_id))
        self.assertEqual(Store(self.path).delivered_job_ids(1), {job_id})
        self.assertEqual(self.store.delivered_job_ids(2), set())
        self.store.set_favorite(1, job_id, False)
        self.assertEqual(self.store.favorites(1), [])

    def test_notification_timestamp_and_source_status_survive_restart(self):
        timestamp = "2026-10-14T07:00:00+00:00"
        self.store.mark_notified(1, timestamp)
        self.store.set_source_status({"poslovi": {"ok": True, "count": 2}, "jooble": {"ok": False}})
        self.store.set_source_status({"poslovi": {"ok": True, "count": 3}})
        fresh = Store(self.path)
        self.assertEqual(fresh.subscribers()[0]["last_notified_at"], timestamp)
        self.assertEqual(fresh.source_status()["poslovi"]["count"], 3)
        self.assertFalse(fresh.source_status()["jooble"]["ok"])

    def test_delete_user_removes_personal_data_but_keeps_shared_vacancies(self):
        job_id = self.job_id()
        for user_id in (1, 2):
            self.store.set_favorite(user_id, job_id, True)
            self.store.mark_delivered(user_id, job_id)
        self.store.delete_user(1)
        self.assertEqual([row["user_id"] for row in self.store.subscribers()], [2])
        self.assertEqual(self.store.favorites(1), [])
        self.assertFalse(self.store.has_delivered(1, job_id))
        self.assertEqual(len(self.store.list_jobs()), 1)
        self.assertEqual(len(self.store.favorites(2)), 1)
        self.assertTrue(self.store.has_delivered(2, job_id))


if __name__ == "__main__":
    unittest.main()
