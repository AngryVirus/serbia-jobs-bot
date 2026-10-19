import unittest

from filter_vocabulary import CITY_ALIASES, KEYWORD_FORMS, keyword_contains
from filters import contains


class FilterVocabularyTests(unittest.TestCase):
    def city_matches(self, city, text):
        return any(contains(text, alias) for alias in CITY_ALIASES[city])

    def test_city_choices_and_existing_aliases_are_preserved(self):
        old_aliases = {
            'belgrade': ('beograd', 'belgrade', 'белград', 'београд'),
            'novi_sad': ('novi sad', 'novi-sad', 'нови сад', 'нови-сад'),
            'nis': ('nis', 'ниш'), 'subotica': ('subotica', 'суботица'),
            'kragujevac': ('kragujevac', 'крагуевац', 'крагујевац'),
        }
        self.assertEqual(set(CITY_ALIASES), set(old_aliases))
        for city, aliases in old_aliases.items():
            self.assertTrue(set(aliases).issubset(CITY_ALIASES[city]))

    def test_city_case_forms_in_real_location_phrases(self):
        examples = {
            'belgrade': ('Работа в Белграде', 'U Beogradu', 'из Београда'),
            'novi_sad': ('в Новом Саду', 'в Нови-Саде', 'u Novom Sadu', 'Нови Сад'),
            'nis': ('в Нишу', 'u Nišu', 'из Niša', 'Работа в Нише'),
            'subotica': ('в Суботице', 'U Subotici', 'из Суботицы'),
            'kragujevac': ('в Крагуевце', 'u Kragujevcu', 'из Крагујевца'),
        }
        for city, phrases in examples.items():
            for phrase in phrases:
                with self.subTest(city=city, phrase=phrase):
                    self.assertTrue(self.city_matches(city, phrase))

    def test_city_matching_never_uses_substrings_or_ambiguous_niche(self):
        for phrase in ('Business office', 'ниша рынка', 'работа в нишах',
                       'анализ рыночной ниши', 'Nissan сервис'):
            with self.subTest(phrase=phrase):
                self.assertFalse(self.city_matches('nis', phrase))
        self.assertFalse(self.city_matches('belgrade', 'Белградская область'))
        self.assertFalse(self.city_matches('novi_sad', 'Novom Sadumu'))

    def test_known_role_inflections_match_without_translation(self):
        examples = (
            ('повар', 'Ищем повара'), ('повар', 'Работа поваром'),
            ('официант', 'Нужны официанты'), ('курьер', 'Работа курьером'),
            ('водитель', 'Требуется водитель, опыт водителя обязателен'),
            ('продавец', 'Вакансия продавца'), ('кассир', 'Нужны кассиры'),
            ('уборщик', 'Вакансии уборщиков'), ('администратор', 'Ищем администратора'),
            ('менеджер', 'Работа менеджером'), ('бармен', 'Приглашаем барменов'),
            ('пекарь', 'Требуются пекари'), ('грузчик', 'Ищем грузчиков'),
            ('сварщик', 'Вакансии сварщика'), ('электрик', 'Работа электриком'),
            ('строитель', 'Требуются строители'),
        )
        for term, text in examples:
            with self.subTest(term=term, text=text):
                self.assertTrue(keyword_contains(text, term))
        self.assertTrue(keyword_contains('ИЩЕМ ПОВАРОВ!', 'ПОВАР'))
        self.assertFalse(keyword_contains('Cook / kuvar', 'повар'))

    def test_vocabulary_is_finite_and_preserves_word_boundaries(self):
        self.assertEqual(len(KEYWORD_FORMS), 15)
        for term, forms in KEYWORD_FORMS.items():
            self.assertIn(term, forms)
            self.assertEqual(len(forms), len(set(forms)))
        for text in ('повариха', 'поворот', 'переповар', 'поваромания', 'повар123'):
            with self.subTest(text=text):
                self.assertFalse(keyword_contains(text, 'повар'))
        self.assertFalse(keyword_contains('путеводитель по городу', 'водитель'))
        self.assertFalse(keyword_contains('системный администратор', 'админ'))

    def test_phrases_and_unknown_terms_are_exact_only(self):
        self.assertTrue(keyword_contains('Ищем шеф-повара', 'шеф-повара'))
        self.assertFalse(keyword_contains('Ищем старшего повара', 'старший повар'))
        self.assertFalse(keyword_contains('Ищем программистов', 'программист'))
        self.assertTrue(keyword_contains('Python developer и C++', 'python'))
        self.assertTrue(keyword_contains('Python developer и C++', 'C++'))
        self.assertFalse(keyword_contains('CPython и C+', 'python'))
        self.assertFalse(keyword_contains('CPython и C+', 'C++'))
        self.assertFalse(keyword_contains('нужны повара', 'повару'))

    def test_exclusions_can_keep_using_original_exact_contains(self):
        self.assertTrue(keyword_contains('Ищем повара', 'повар'))
        self.assertFalse(contains('Ищем повара', 'повар'))


if __name__ == '__main__':
    unittest.main()
