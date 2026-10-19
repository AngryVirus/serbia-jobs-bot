"""Observed language/format declarations must survive collection and old-cache reads."""
from copy import deepcopy
import unittest

from job_metadata import job_language_facts, language_facts, remote_fact


class LanguageRegressionTests(unittest.TestCase):
    def test_observed_public_telegram_skill_lines(self):
        cases = {
            # serbiawork/2469, serbiawork/2487, youritjob/8514.
            'Английский C1 — уверенная письменная и устная коммуникация с клиентами;': ['en'],
            '- Английский от B2.': ['en'],
            '💦Уровень английского B2+.': ['en'],
            # serbiarabotavacancies/699.
            '📎 Разговорный сербский язык от B2 и грамотный русский;': ['ru', 'sr'],
        }
        for text, languages in cases.items():
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), (languages, []))

    def test_labelled_lists_and_explicit_skill_levels(self):
        for text in ('Languages: English, Serbian', 'Языки: английский, сербский',
                     'Jezici: engleski, srpski', 'Језици: енглески, српски'):
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), (['sr', 'en'], []))
        self.assertEqual(language_facts('English B2; Serbian C1'), (['sr', 'en'], []))
        self.assertEqual(language_facts('Рабочий язык — русский'), (['ru'], []))
        self.assertEqual(language_facts('Native English'), (['en'], []))

    def test_serbian_cyrillic_mandatory_optional_and_negative(self):
        self.assertEqual(language_facts('Српски језик обавезан. Енглески језик је обавезан.'),
                         (['sr', 'en'], ['sr', 'en']))
        self.assertEqual(language_facts('Познавање руског језика је предност.'), (['ru'], []))
        self.assertEqual(language_facts('Српски није обавезан, енглески је обавезан.'),
                         (['en'], ['en']))

    def test_negative_and_optional_evidence_stays_attached_to_its_language(self):
        cases = {
            'English B2 and Serbian not required.': (['en'], []),
            'Russian B2 optional and English C1 required.': (['ru', 'en'], ['en']),
            'Английский C1 обязателен, сербский B2 не нужен.': (['en'], ['en']),
            'Русский желателен; English B2 required; српски није потребан.': (['ru', 'en'], ['en']),
            'Languages: English and Serbian not required.': ([], []),
            'English B2 not required. Serbian C1 not necessary.': ([], []),
            'Без знания английского языка.': ([], []),
            'No knowledge of English necessary.': ([], []),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(language_facts(text), expected)

    def test_background_and_dataset_mentions_do_not_become_language_skills(self):
        for text in ('Russian company requires an accountant.',
                     'Russian company requires English B2.',
                     'Serbian citizenship required.',
                     'English-language datasets required.',
                     'Experience with English language datasets required.',
                     'We sell English B2 textbooks.',
                     'Мы ищем разработчика. Сербская компания.'):
            with self.subTest(text=text):
                expected = (['en'], ['en']) if text == 'Russian company requires English B2.' else ([], [])
                self.assertEqual(language_facts(text), expected)

    def test_old_cache_recovers_all_languages_without_mutating_stored_values(self):
        for stored in (None, [], ['en']):
            job = {'languages': stored, 'required_languages': [],
                   'description': 'Russian required. Serbian mandatory. English required.'}
            before = deepcopy(job)
            languages, required = job_language_facts(job)
            self.assertEqual(set(languages), {'ru', 'sr', 'en'})
            self.assertEqual(set(required), {'ru', 'sr', 'en'})
            self.assertEqual(job, before)
        # Structured source facts remain usable when its description is terse.
        self.assertEqual(job_language_facts({'languages': ['ru'], 'required_languages': ['ru']}),
                         (['ru'], ['ru']))


class RemoteRegressionTests(unittest.TestCase):
    def test_explicit_serbian_cyrillic_and_labelled_russian_remote(self):
        for text in ('Рад од куће', 'Формат: удаленно', 'Формат работы: удалённый',
                     'Формат — удалённо', 'Format: remote',
                     'Rad od kuće neophodan', 'Рад од куће неопходан'):
            with self.subTest(text=text):
                self.assertIs(remote_fact(text), True)

    def test_negation_and_hybrid_take_precedence_over_remote_mentions(self):
        for text in ('Није рад од куће', 'Рад од куће није могућ', 'Rad od kuće nije moguć', 'Формат: не удаленно',
                     'Rad od kuće ne postoji', 'Рад од куће не постоји',
                     'Work from home is not available', 'Хибрид, рад од куће два дана',
                     'Hybrid position with remote work twice a week', 'On-site only, no remote work'):
            with self.subTest(text=text):
                self.assertIs(remote_fact(text), False)

    def test_technical_or_missing_format_stays_unknown(self):
        for text in ('Implement remote procedure calls and remote debugging.',
                     'Знание инструментов удалённого доступа', 'English B2 required.', ''):
            with self.subTest(text=text):
                self.assertIsNone(remote_fact(text))


if __name__ == '__main__':
    unittest.main()
