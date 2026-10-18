"""English filters must work for existing rows as well as newly collected jobs."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from bot import Bot
from filters import matches
from job_metadata import enrich, job_language_facts, language_facts
from presentation import job_text
from sources import Job
from store import Store, default_settings
from test_bot import FakeAPI, callback, vacancy
from test_cloud_store import MemorySupabaseStore


class EnglishFactsTests(unittest.TestCase):
    def test_explicit_requirements_in_russian_serbian_and_english(self):
        for description in ('Требуется знание английского языка',
                            'Обязательно владение английским языком',
                            'Obavezno znanje engleskog jezika', 'English fluency required'):
            with self.subTest(description=description):
                job = enrich(Job('poslovi', 'https://poslovi.rs/job/1', 'Support', description=description))
                self.assertIn('en', job.languages)
                self.assertIn('en', job.required_languages)
                self.assertTrue(matches(job.__dict__, dict(default_settings(), language=['english'])))

    def test_separate_lines_keep_language_negation_local(self):
        self.assertEqual(language_facts('Знание английского обязательно\nСербский не требуется'),
                         (['en'], ['en']))

    def test_independent_requirements_in_one_sentence_keep_their_own_language(self):
        for text in ('English required, Serbian not required.',
                     'English required and Serbian not required.',
                     'Знание английского обязательно, сербский не требуется.',
                     'Английский обязателен, а сербский не требуется.',
                     'Obavezno znanje engleskog, srpski nije obavezan.'):
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), (['en'], ['en']))
        for text in ('Russian optional, English required.',
                     'Russian preferred and English required.'):
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), (['ru', 'en'], ['en']))

    def test_shared_language_lists_keep_shared_requirement_without_company_inference(self):
        for text in ('Russian and English required.', 'Russian, English required.'):
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), (['ru', 'en'], ['ru', 'en']))
        self.assertEqual(language_facts('Russian company, English required.'), (['en'], ['en']))
        self.assertEqual(language_facts('English required and no experience required.'), (['en'], ['en']))

    def test_english_is_not_inferred_from_page_language_or_negated_requirements(self):
        for description in ('We are hiring a developer. Experience required.',
                            'English is not required', 'Знание английского не требуется',
                            'Experience with English language datasets required.'):
            for stored in (None, []):
                with self.subTest(description=description, stored=stored):
                    job = vacancy(description=description, languages=stored)
                    self.assertFalse(matches(job, dict(default_settings(), language=['english'])))

    def test_old_cached_rows_match_and_display_english_without_mutation(self):
        for stored in (None, [], ['sr']):
            job = vacancy(description='Требуется знание английского языка', languages=stored)
            before = deepcopy(job)
            self.assertTrue(matches(job, dict(default_settings(), language=['english'])))
            self.assertIn('Английский (обяз.)', job_text(job))
            self.assertEqual(job, before)
        job = vacancy(languages=['en'], required_languages=['en'])
        self.assertEqual(job_language_facts(job), (['en'], ['en']))

    def test_english_combines_with_other_languages_using_or_and_with_city_using_and(self):
        settings = dict(default_settings(), language=['russian', 'english'], city=['belgrade'])
        for language in ('ru', 'en'):
            self.assertTrue(matches(vacancy(languages=[language]), settings))
            self.assertFalse(matches(vacancy(languages=[language], location='Niš'), settings))
        self.assertFalse(matches(vacancy(languages=['sr']), settings))
        self.assertFalse(matches(vacancy(languages=[]), settings))


class EnglishJourneyTests(unittest.IsolatedAsyncioTestCase):
    async def test_selection_search_notifications_and_persistence_in_both_stores(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'jobs.db'
            for store in (Store(path), MemorySupabaseStore()):
                with self.subTest(store=type(store).__name__):
                    api = FakeAPI()
                    bot = Bot(api, store)
                    for uid in (1, 2):
                        store.ensure_user(uid, uid)
                    store.save_jobs([
                        vacancy(title='English support', description='Знание английского обязательно', languages=[]),
                        vacancy(title='Russian support', languages=['ru'], url='https://poslovi.rs/job/2'),
                        vacancy(title='Serbian support', languages=['sr'], url='https://poslovi.rs/job/3')])
                    await bot.handle(callback(1, 'choose:language:english:1'))
                    self.assertEqual(store.get_settings(1)['language'], ['english'])
                    panel = api.calls[-1][1]
                    self.assertIn('✅ 🇬🇧 Английский', str(panel['reply_markup']))
                    await bot.handle(callback(1, 'choose:language:russian:1'))
                    await bot.handle(callback(1, 'choose:language:english:1'))
                    self.assertEqual(store.get_settings(1)['language'], ['russian', 'english'])
                    self.assertEqual(store.get_settings(2)['language'], 'any')
                    if isinstance(store, Store):
                        store = Store(path)
                    bot = Bot(api, store)
                    api.sent.clear()
                    await bot.handle(callback(1, 'search:0'))
                    first = api.calls[-1][1]
                    next_button = next(b for row in first['reply_markup']['inline_keyboard'] for b in row
                                       if ':next:' in b.get('callback_data', ''))
                    await bot.handle(callback(1, next_button['callback_data']))
                    texts = first['text'] + api.calls[-1][1]['text']
                    self.assertIn('English support', texts)
                    self.assertIn('Russian support', texts)
                    self.assertNotIn('Serbian support', texts)
                    self.assertEqual(api.sent, [])
                    await bot.handle(callback(1, 'choose:language:russian:0'))
                    store.update_settings(1, notifications='instant')
                    api.sent.clear()
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    self.assertIn('English support', api.text_for(1))
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    await bot.handle(callback(1, 'choose:language:english:0'))
                    self.assertEqual(store.get_settings(1)['language'], ['any'])
