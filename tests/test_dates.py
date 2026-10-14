import unittest

from sources import safe_date


class SourceDateTests(unittest.TestCase):
    def test_bad_dates_remain_unknown_without_poisoning_cloud_batch(self):
        self.assertIsNone(safe_date("2026-02-31"))
        self.assertIsNone(safe_date("yesterday"))
        self.assertIsNone(safe_date({"date": "2026-10-14"}))
        self.assertEqual(safe_date("2026-10-14T09:00:00Z"), "2026-10-14T09:00:00Z")
