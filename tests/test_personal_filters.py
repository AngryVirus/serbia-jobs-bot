"""User journeys for multiple selections, compact cards and private hiding."""
from datetime import datetime, timezone
import unittest

from filters import matches, selected_values, select_value
from store import default_settings
from helpers import vacancy



class MultiSelectionTests(unittest.TestCase):
    def test_multiple_values_are_or_but_groups_are_and(self):
        settings = dict(default_settings(), city=['belgrade', 'novi_sad'],
                        language=['russian', 'serbian'], remote=['only', 'office'],
                        freshness=['today', 'yesterday'], keywords=['python', 'support'])
        now = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        for city in ('Beograd', 'Novi Sad'):
            for language in ('ru', 'sr'):
                for remote in (True, False):
                    for date in ('2026-10-14', '2026-10-13'):
                        job = vacancy(location=city, languages=[language], remote=remote, published_at=date)
                        self.assertTrue(matches(job, settings, now))
        for change in ({'location': 'Niš'}, {'languages': ['en']}, {'remote': None, 'description': 'Vacancy with unstated work format'},
                       {'published_at': '2026-10-12'}, {'published_at': None},
                       {'published_at': '2026-10-15'}, {'title': 'Cook', 'description': 'Kitchen'}):
            self.assertFalse(matches(vacancy(published_at='2026-10-14', **change) if 'published_at' not in change
                                     else vacancy(**change), settings, now), change)

    def test_any_is_exclusive_and_last_removal_restores_any(self):
        settings = default_settings()
        settings['city'] = select_value(settings, 'city', 'belgrade', True)
        settings['city'] = select_value(settings, 'city', 'novi_sad', True)
        self.assertEqual(settings['city'], ['belgrade', 'novi_sad'])
        self.assertEqual(select_value(settings, 'city', 'novi_sad', True), settings['city'])
        self.assertEqual(select_value(settings, 'city', 'any', True), ['any'])
        settings['city'] = select_value(settings, 'city', 'belgrade', False)
        self.assertEqual(select_value(settings, 'city', 'novi_sad', False), ['any'])
        for value in ([], ['any', 'belgrade']):
            self.assertEqual(selected_values({'city': value}, 'city'), ['any'])
        with self.assertRaises(ValueError):
            select_value(settings, 'city', 'invalid', True)

    def test_overlapping_freshness_windows_do_not_exclude_unknowns_with_any(self):
        settings = dict(default_settings(), freshness=['today', '7'])
        now = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        self.assertTrue(matches(vacancy(published_at='2026-10-10'), settings, now))
        self.assertFalse(matches(vacancy(published_at=None), settings, now))
        settings['freshness'] = ['any']
        self.assertTrue(matches(vacancy(published_at=None), settings, now))

    def test_hidden_is_applied_even_with_no_other_filters(self):
        settings = dict(default_settings(), hidden_jobs=[4, 6])
        self.assertFalse(matches(vacancy(id=4), settings))
        self.assertTrue(matches(vacancy(id=5), settings))
        self.assertTrue(matches(vacancy(id=4), default_settings()))



