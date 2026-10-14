from datetime import datetime, timezone
import unittest

from filters import matches
from store import default_settings


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.settings = default_settings()
        self.job = {"source": "radim", "title": "Python Developer", "company": "A",
                    "description": "Remote role. Russian speakers welcome.", "location": "Beograd",
                    "remote": True, "russian": True, "serbian_required": None,
                    "salary_min": None, "salary_currency": None}

    def test_keyword_or_exclusion_and(self):
        self.settings.update(keywords=["kuvar", "Python"], exclusions=["senior"])
        self.assertTrue(matches(self.job, self.settings))
        self.job["title"] = "Senior Python Developer"
        self.assertFalse(matches(self.job, self.settings))

    def test_city_spelling_and_word_boundaries(self):
        self.settings["city"] = "belgrade"
        self.assertTrue(matches(self.job, self.settings))
        self.settings["city"] = "nis"
        self.job["location"] = "Business office"
        self.assertFalse(matches(self.job, self.settings))
        self.job["location"] = "Niš"
        self.assertTrue(matches(self.job, self.settings))

    def test_language_unknown_is_not_no_requirement(self):
        self.settings["language"] = "no_serbian"
        self.assertFalse(matches(self.job, self.settings))
        self.job["serbian_required"] = False
        self.assertTrue(matches(self.job, self.settings))

    def test_salary_currencies_not_compared(self):
        self.settings.update(min_salary=1000, currency="EUR", include_unknown_salary=False)
        self.job.update(salary_min=120000, salary_currency="RSD")
        self.assertFalse(matches(self.job, self.settings))
        self.job.update(salary_min=1500, salary_currency="EUR")
        self.assertTrue(matches(self.job, self.settings))

    def test_unknown_salary_explicit_policy(self):
        self.settings.update(min_salary=1000)
        self.assertTrue(matches(self.job, self.settings))
        self.settings["include_unknown_salary"] = False
        self.assertFalse(matches(self.job, self.settings))

    def test_unknown_remote_excluded(self):
        self.settings["remote"] = "only"
        self.job["remote"] = None
        self.assertFalse(matches(self.job, self.settings))

    def test_source_and_expiry(self):
        self.settings["sources"] = []
        self.assertTrue(matches(self.job, self.settings))
        self.settings["sources"] = ["radim"]
        self.job["expires_at"] = "2026-10-13"
        now = datetime(2026, 10, 14, tzinfo=timezone.utc)
        self.assertFalse(matches(self.job, self.settings, now))

    def test_unknown_date_ages_from_original_ingestion(self):
        self.job["created_at"] = "2026-09-01T00:00:00+00:00"
        self.job["updated_at"] = "2026-10-14T00:00:00+00:00"
        now = datetime(2026, 10, 14, tzinfo=timezone.utc)
        self.assertTrue(matches(self.job, self.settings, now))
        self.settings['freshness'] = '30'
        self.assertFalse(matches(self.job, self.settings, now))


if __name__ == "__main__":
    unittest.main()
