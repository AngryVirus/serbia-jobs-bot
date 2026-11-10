"""Explicit permit requirements, existing data and private filter journeys."""
from copy import deepcopy
import unittest

from filters import matches
from residence_permit import job_residence_permit_requirement, residence_permit_requirement
from store import default_settings
from helpers import vacancy


class ResidencePermitFactsTests(unittest.TestCase):
    def test_explicit_requirements_in_russian_english_and_serbian(self):
        examples = (
            '-наличие ВНЖ и разрешения на работу',
            'Требования: наличие действующего ВНЖ',
            'Нужен ВНЖ', 'ВНЖ обязателен', 'ВНЖ и разрешение на работу обязательны',
            'Наличие ВНЖ: да', 'Требуется вид на жительство',
            'Только с ВНЖ', 'You must hold a valid residence permit.',
            'Не принимаем без ВНЖ', 'Без ВНЖ не рассматриваем',
            'We do not accept candidates without a residence permit',
            'Residence permit is required', 'A residency permit and a work permit are required',
            'Obavezna dozvola za boravak', 'Privremeni boravak je neophodan',
            'Дозвола за боравак је обавезна',
        )
        for text in examples:
            with self.subTest(text=text):
                self.assertIs(residence_permit_requirement(text), True)

    def test_explicit_no_requirement_and_negation_scope(self):
        for text in (
            'ВНЖ не требуется', 'Наличие ВНЖ не обязательно', 'Не требуется наличие ВНЖ',
            'ВНЖ: нет', 'Можно без ВНЖ', 'Рассматриваем кандидатов без ВНЖ',
            'Работа без ВНЖ', 'С ВНЖ и без него', 'Без ВНЖ',
            'Не нужен вид на жительство. Требуется опыт работы.',
            'No residence permit required', 'Residence permit is not required',
            'We accept candidates without a residence permit.', 'With or without a residence permit',
            'Dozvola za boravak nije potrebna', 'Nije obavezan privremeni boravak',
            'Дозвола за боравак није потребна', 'Примамо кандидате без дозволе за боравак',
            'ВНЖ не требуется; разрешение на работу обязательно.',
        ):
            with self.subTest(text=text):
                self.assertIs(residence_permit_requirement(text), False)
        self.assertIs(residence_permit_requirement('Опыт не требуется. Наличие ВНЖ обязательно.'), True)

    def test_mentions_assistance_preferences_and_conflicts_remain_unknown(self):
        for text in (
            '', 'Нужен сотрудник, знание сербского обязательно',
            'Официальное трудоустройство, помощь с ВНЖ',
            'Официальное оформление и содействие в получении ВНЖ.',
            'Оформлять и продлевать ВНЖ и разрешения на работу для иностранных сотрудников.',
            'Проверять наличие ВНЖ у сотрудников', 'ВНЖ',
            'Наличие ВНЖ желательно', 'Residence permit preferred',
            'Оформление ВНЖ не требуется', 'No experience required with residence permit processing',
            'You need to have residence permit processing experience',
            'Обязателен паспорт и разрешение на работу', 'Work permit required',
            'Celodnevni boravak uz kontrolu mera bezbednosti',
            'ВНЖ не требуется. Наличие ВНЖ обязательно.',
            'Residence permit required; no residence permit required.',
            'Если нет гражданства, ВНЖ обязателен.', 'ВНЖ не нужен для отклика.',
        ):
            with self.subTest(text=text):
                self.assertIsNone(residence_permit_requirement(text))

    def test_existing_rows_combine_with_other_filters_without_mutation(self):
        job = vacancy(description='-наличие ВНЖ и разрешения на работу', languages=['en'])
        before = deepcopy(job)
        for value, expected in (('yes', True), ('no', False), ('any', True)):
            self.assertEqual(matches(job, dict(default_settings(), residence_permit=value)), expected)
            self.assertEqual(matches(job, dict(default_settings(), residence_permit=[value])), expected)
        selected = dict(default_settings(), residence_permit=['yes'], language=['russian', 'english'],
                        city=['belgrade', 'novi_sad'])
        self.assertTrue(matches(job, selected))
        self.assertFalse(matches(dict(job, location='Niš'), selected))
        self.assertFalse(matches(dict(job, id=1), dict(selected, hidden_jobs=[1])))
        self.assertFalse(matches(dict(job, expires_at='2020-01-01'), selected))
        self.assertEqual(job, before)
        for desc in ('Не требуется ВНЖ', 'Помощь с ВНЖ', ''):
            job['description'] = desc
            self.assertIsNot(job_residence_permit_requirement(job), True)
            self.assertTrue(matches(job, default_settings()))
        self.assertFalse(matches(job, dict(selected, residence_permit=['no'])))


