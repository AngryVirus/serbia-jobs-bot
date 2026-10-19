"""Explicit permit requirements, existing data and private filter journeys."""
from copy import deepcopy
from pathlib import Path
import sqlite3
import tempfile
import unittest

from bot import Bot
from filters import matches, search_diagnostics
from presentation import choice_panel, empty_search_text, filter_summary
from residence_permit import job_residence_permit_requirement, residence_permit_requirement
from store import Store, default_settings
from test_bot import FakeAPI, callback, vacancy
from test_cloud_store import MemorySupabaseStore


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

    def test_empty_search_explains_unknowns_and_can_relax_permit_filter(self):
        jobs = [vacancy(description='Помощь с ВНЖ')]
        selected = dict(default_settings(), residence_permit=['no'])
        before = deepcopy(selected)
        self.assertEqual(search_diagnostics(jobs, selected),
                         {'available': 1, 'relaxed': [{'field': 'residence_permit', 'count': 1}]})
        text = empty_search_text(jobs, selected)
        self.assertIn('Требование ВНЖ', text)
        self.assertIn('Не важно', text)
        self.assertEqual(selected, before)


class ResidencePermitJourneyTests(unittest.IsolatedAsyncioTestCase):
    async def test_selection_search_notification_restart_reset_and_user_isolation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'jobs.db'
            for store in (Store(path), MemorySupabaseStore()):
                with self.subTest(store=type(store).__name__):
                    api = FakeAPI()
                    bot = Bot(api, store)
                    for uid in (1, 2):
                        store.ensure_user(uid, uid)
                    # Simulate settings saved before the new field existed.
                    if isinstance(store, Store):
                        with sqlite3.connect(path) as db:
                            db.execute("UPDATE users SET settings = json_remove(settings, '$.residence_permit')")
                    else:
                        for row in store.tables['sj_users']:
                            row['settings'].pop('residence_permit')
                    self.assertEqual(store.get_settings(1)['residence_permit'], 'any')
                    store.save_jobs([
                        vacancy(title='Permit required', description='Наличие ВНЖ'),
                        vacancy(title='Permit optional', description='ВНЖ не требуется', url='https://poslovi.rs/job/2'),
                        vacancy(title='Permit unknown', description='Помощь с ВНЖ', url='https://poslovi.rs/job/3'),
                    ])
                    await bot.handle(callback(1, 'filters'))
                    panel = api.calls[-1][1]
                    buttons = [b for row in panel['reply_markup']['inline_keyboard'] for b in row]
                    self.assertTrue(any(b.get('callback_data') == 'residence_permit' for b in buttons))
                    self.assertEqual(sum(b.get('callback_data') == 'search:0' for b in buttons), 1)
                    for value in ('yes', 'yes', 'no', 'no'):
                        await bot.handle(callback(1, f'choose:residence_permit:{value}:1'))
                        self.assertEqual(store.get_settings(1)['residence_permit'], [value])
                    self.assertEqual(store.get_settings(2)['residence_permit'], 'any')
                    text, rows = choice_panel(store.get_settings(1), 'residence_permit')
                    self.assertIn('один вариант', text)
                    self.assertEqual([b['text'] for row in rows for b in row if b['text'].startswith('✅')], ['✅ Не требуется'])
                    self.assertIn('Требование ВНЖ: Не требуется', filter_summary(store.get_settings(1)))
                    if isinstance(store, Store):
                        store = Store(path)
                    bot = Bot(api, store)
                    await bot.handle(callback(1, 'search:0'))
                    result = api.calls[-1][1]['text']
                    self.assertIn('Вакансия 1 из 1', result)
                    self.assertIn('Permit optional', result)
                    self.assertEqual(api.sent, [])
                    store.update_settings(1, notifications='instant')
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    self.assertIn('Permit optional', api.text_for(1))
                    await bot.notify()
                    self.assertEqual(len(api.sent), 1)
                    await bot.handle(callback(1, 'choose:residence_permit:any:1'))
                    await bot.handle(callback(1, 'search:0'))
                    self.assertIn('из 3', api.calls[-1][1]['text'])
                    await bot.handle(callback(1, 'choose:residence_permit:yes:1'))
                    await bot.handle(callback(1, 'search:0'))
                    self.assertIn('Permit required', api.calls[-1][1]['text'])
                    hidden_id = store.list_jobs()[0]['id']
                    store.update_settings(1, hidden_jobs=[hidden_id])
                    await bot.handle(callback(1, 'reset'))
                    self.assertEqual(store.get_settings(1)['residence_permit'], 'any')
                    self.assertEqual(store.get_settings(1)['hidden_jobs'], [hidden_id])
