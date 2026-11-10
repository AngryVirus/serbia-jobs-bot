"""English filters must work for existing rows as well as newly collected jobs."""
import unittest

from filters import matches
from job_metadata import enrich, language_facts
from sources import Job
from store import default_settings
from helpers import vacancy


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

    def test_english_combines_with_other_languages_using_or_and_with_city_using_and(self):
        settings = dict(default_settings(), language=['russian', 'english'], city=['belgrade'])
        for language in ('ru', 'en'):
            self.assertTrue(matches(vacancy(languages=[language]), settings))
            self.assertFalse(matches(vacancy(languages=[language], location='Niš'), settings))
        self.assertFalse(matches(vacancy(languages=['sr']), settings))
        self.assertFalse(matches(vacancy(languages=[]), settings))


