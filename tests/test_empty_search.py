from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from bot import Bot
from filters import FILTER_OPTIONS, matches, search_diagnostics
from presentation import choice_panel, empty_search_text
from store import Store, default_settings
from test_bot import FakeAPI, vacancy


class EmptySearchTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 14, 12, tzinfo=timezone.utc)
        self.jobs = [
            vacancy(id=1, location='Beograd', languages=['ru'], published_at=None),
            vacancy(id=2, location='Novi Sad', languages=['en'], published_at='2026-10-14'),
            vacancy(id=3, location='Beograd', languages=['ru'], published_at='2026-10-13'),
        ]
        self.settings = dict(default_settings(), city=['belgrade'], language=['russian'], freshness=['today'])

    def test_empty_search_identifies_date_constraint_without_changing_settings(self):
        before = deepcopy(self.settings)
        self.assertFalse(any(matches(job, self.settings, self.now) for job in self.jobs))
        diagnostics = search_diagnostics(self.jobs, self.settings, self.now)
        self.assertEqual(diagnostics, {'available': 3, 'relaxed': [{'field': 'freshness', 'count': 2}]})
        text = empty_search_text(self.jobs, self.settings, self.now)
        self.assertIn('Без ограничения «Свежесть» — 2', text)
        self.assertIn('Объявления без даты', text)
        self.assertIn('Белград', text)
        self.assertEqual(self.settings, before)

    def test_suggestions_never_include_hidden_expired_or_foreign_jobs(self):
        self.settings['hidden_jobs'] = [1]
        self.jobs += [vacancy(id=4, country='DE', published_at=None),
                      vacancy(id=5, expires_at='2026-10-12', published_at=None)]
        diagnostics = search_diagnostics(self.jobs, self.settings, self.now)
        self.assertEqual(diagnostics['available'], 2)
        self.assertEqual(diagnostics['relaxed'], [{'field': 'freshness', 'count': 1}])

    def test_multiple_conflicting_conditions_do_not_promise_single_filter_fix(self):
        self.settings.update(city=['subotica'], language=['serbian'], remote=['only'])
        diagnostics = search_diagnostics(self.jobs, self.settings, self.now)
        self.assertEqual(diagnostics['relaxed'], [])
        self.assertIn('расширить несколько условий', empty_search_text(self.jobs, self.settings, self.now))

    def test_unknown_languages_are_not_silently_treated_as_matching(self):
        jobs = [vacancy(id=1, languages=[], published_at='2026-10-14')]
        self.assertFalse(matches(jobs[0], self.settings, self.now))
        text = empty_search_text(jobs, self.settings, self.now)
        self.assertIn('Без ограничения «Языки» — 1', text)
        self.assertIn('явно указанных требованиях', text)

    def test_all_hidden_or_expired_have_no_misleading_filter_suggestions(self):
        self.settings['hidden_jobs'] = [1, 2, 3]
        text = empty_search_text(self.jobs, self.settings, self.now)
        self.assertIn('вне вашего списка скрытых', text)
        self.assertNotIn('Без ограничения «', text)
        self.assertIn('нет доступных действующих', empty_search_text(
            [vacancy(expires_at='2026-10-01')], default_settings(), self.now))

    def test_salary_and_keyword_suggestions_preserve_other_conditions(self):
        for change, field in (({'keywords': ['unknown-job-word']}, 'keywords'),
                              ({'exclusions': ['Python']}, 'exclusions'),
                              ({'min_salary': 5000, 'include_unknown_salary': False}, 'salary')):
            settings = dict(default_settings(), **change)
            diagnostics = search_diagnostics([vacancy(published_at='2026-10-14')], settings, self.now)
            self.assertEqual(diagnostics['relaxed'], [{'field': field, 'count': 1}])


class FilterNavigationTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_search_button_on_overview_and_none_on_choice_screens(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'test.db')
            store.ensure_user(1, 1)
            api = FakeAPI()
            bot = Bot(api, store)
            await bot.filters(1, 1)
            search = [b for row in api.sent[-1]['rows'] for b in row if b.get('callback_data') == 'search:0']
            self.assertEqual(len(search), 1)
            for field in FILTER_OPTIONS:
                _, rows = choice_panel(store.get_settings(1), field)
                buttons = [b for row in rows for b in row]
                self.assertFalse(any(b.get('callback_data', '').startswith('search:') for b in buttons))
                self.assertTrue(any(b.get('callback_data') == 'filters' for b in buttons))

    async def test_real_search_displays_diagnostics_and_keeps_persisted_filters(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'test.db')
            store.ensure_user(1, 1)
            store.save_jobs([vacancy(published_at=None, languages=['ru'])])
            store.update_settings(1, city=['belgrade'], language=['russian'], freshness=['today'])
            before = store.get_settings(1)
            api = FakeAPI()
            await Bot(api, store).results(1, 1)
            self.assertIn('Без ограничения «Свежесть» — 1', api.sent[-1]['text'])
            self.assertEqual(store.get_settings(1), before)
