"""User journeys for multiple selections, compact cards and private hiding."""
import asyncio
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import tempfile
import unittest

from bot import Bot
from filters import FILTER_OPTIONS, hidden_job_ids, matches, selected_values, select_value
from presentation import choice_panel, filter_summary, job_buttons, job_text, menu_text
from store import Store, default_settings
from test_bot import FakeAPI, callback, message, vacancy
from test_cloud_store import MemorySupabaseStore
from web_server import WebhookProcessor


class VisibleText(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.feed(text)

    def handle_data(self, data):
        self.parts.append(data)

    @property
    def text(self):
        return ''.join(self.parts)


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
        for change in ({'location': 'Niš'}, {'languages': ['en']}, {'remote': None},
                       {'published_at': '2026-10-12'}, {'published_at': None},
                       {'published_at': '2026-10-15'}, {'title': 'Cook', 'description': 'Kitchen'}):
            self.assertFalse(matches(vacancy(published_at='2026-10-14', **change) if 'published_at' not in change
                                     else vacancy(**change), settings, now), change)

    def test_legacy_scalar_selections_keep_the_same_meaning(self):
        for field, options in FILTER_OPTIONS.items():
            for option in options:
                scalar = dict(default_settings(), **{field: option})
                multiple = dict(default_settings(), **{field: [option]})
                self.assertEqual(matches(vacancy(), scalar), matches(vacancy(), multiple))
        legacy = dict(default_settings(), language='no_serbian')
        self.assertTrue(matches(vacancy(serbian_required=False), legacy))
        self.assertFalse(matches(vacancy(serbian_required=None), legacy))
        self.assertIn('прежний фильтр', choice_panel(legacy, 'language')[0])

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


class NewPresentationTests(unittest.TestCase):
    def test_cards_are_short_expandable_and_keep_facts_and_safe_links(self):
        job = vacancy(id=7, description='Описание <опасное> & подробности. ' * 200,
                      salary_display='1000–2000 EUR / месяц', languages=['ru', 'en'],
                      contacts=['hr@example.org'])
        short, full = job_text(job), job_text(job, True)
        self.assertLess(len(VisibleText(short).text), 650)
        self.assertGreater(len(VisibleText(full).text), len(VisibleText(short).text) * 2)
        for text in (short, full):
            for fact in ('Python developer', '1000–2000 EUR', 'Русский', 'hr@example.org'):
                self.assertIn(fact, text)
            self.assertIn('&lt;опасное&gt;', text)
            self.assertNotIn('<опасное>', text)
        self.assertEqual(job_buttons(job)[1][0]['callback_data'], 'job:7:full')
        self.assertEqual(job_buttons(job, True)[1][0]['callback_data'], 'job:7:short')
        self.assertEqual(job_buttons(job)[1][1]['callback_data'], 'hide:7')
        self.assertEqual(job_buttons(job)[0][0]['url'], job['url'])

    def test_emoji_and_html_heavy_cards_fit_telegram_visible_text_limit(self):
        text = '💼<&>' * 2000
        job = vacancy(title=text, company=text, location=text, description=text,
                      salary_display=text, contacts=[text], languages=[text])
        for expanded in (False, True):
            visible = VisibleText(job_text(job, expanded)).text
            self.assertLess(len(visible.encode('utf-16-le')) // 2, 4096)
        settings = dict(default_settings(), keywords=['💼' * 60] * 15, exclusions=['<&' * 30] * 15)
        self.assertLess(len(VisibleText(filter_summary(settings)).text.encode('utf-16-le')) // 2, 4096)

    def test_menu_shows_current_choices_and_actual_notification_state(self):
        settings = dict(default_settings(), city=['belgrade', 'novi_sad'], language=['russian', 'serbian'],
                        notifications='daily', daily_hour=17, hidden_jobs=[1, 2], keywords=['<script>'])
        text = menu_text(settings)
        for value in ('Белград', 'Нови-Сад', 'Русский', 'Сербский', 'включены — новые вакансии', 'Скрытые вакансии: 2', '&lt;script&gt;'):
            self.assertIn(value, text)
        self.assertNotIn('17:00', text)
        self.assertNotIn('Тестовый режим', text)
        self.assertEqual(text, menu_text(settings, start=True))
        self.assertNotIn('тестовом режиме', menu_text(settings, start=True))
        self.assertNotIn('Возможны ошибки', menu_text(settings, start=True))
        self.assertIn('«Найти вакансии»', text)
        self.assertIn('«Фильтрах»', text)


class PersonalJourneys(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'bot.db'
        self.store = Store(self.path)
        self.api = FakeAPI()
        self.bot = Bot(self.api, self.store)
        for uid in (1, 2):
            self.store.ensure_user(uid, uid)
        self.store.save_jobs([vacancy(url=f'https://www.poslovi.rs/job/{i}', title=f'Vacancy {i}') for i in range(12)])
        self.jobs = self.store.list_jobs()

    def tearDown(self):
        self.temp.cleanup()

    async def test_start_and_menu_without_disclaimer(self):
        for command in ('/start', '/menu'):
            await self.bot.handle(message(1, command))
            text = self.api.sent[-1]['text']
            self.assertIn('SERBIA JOBS', text)
            for removed in ('Перед началом', 'тестовом режиме', 'Возможны ошибки',
                            'не является работодателем', 'не гарантируем',
                            'Проверяйте условия самостоятельно'):
                self.assertNotIn(removed, text)

    async def test_multiple_selection_stays_open_and_shows_checkmarks(self):
        for action in ('choose:city:belgrade:1', 'choose:city:novi_sad:1', 'choose:city:novi_sad:1'):
            await self.bot.handle(callback(1, action))
        self.assertEqual(Store(self.path).get_settings(1)['city'], ['belgrade', 'novi_sad'])
        self.assertEqual(self.store.get_settings(2)['city'], 'any')
        panel = self.api.calls[-1][1]
        buttons = [b for row in panel['reply_markup']['inline_keyboard'] for b in row]
        checked = [b['text'] for b in buttons if b['text'].startswith('✅')]
        self.assertEqual(checked, ['✅ Белград', '✅ Нови-Сад'])
        await self.bot.handle(callback(1, 'choose:city:belgrade:0'))
        self.assertEqual(self.store.get_settings(1)['city'], ['novi_sad'])
        await self.bot.handle(callback(1, 'choose:city:novi_sad:0'))
        self.assertEqual(self.store.get_settings(1)['city'], ['any'])

    async def test_hide_is_private_persists_through_upsert_restart_and_search(self):
        job = self.jobs[0]
        await self.bot.handle(callback(1, f'hide:{job["id"]}'))
        self.assertIn('Вакансия скрыта', self.api.calls[-1][1]['text'])
        self.store.save_jobs([dict(job, description='Updated original posting')])
        restarted = Bot(self.api, Store(self.path))
        self.api.sent.clear()
        await restarted.results(1, 1)
        await restarted.results(2, 2)
        self.assertNotIn(job['title'], self.api.text_for(1))
        self.assertIn(job['title'], self.api.text_for(2))
        self.assertEqual(hidden_job_ids(self.store.get_settings(1)), {job['id']})
        self.assertEqual(hidden_job_ids(self.store.get_settings(2)), set())

    async def test_hidden_never_notifies_and_restore_preserves_delivery_history(self):
        target = self.jobs[0]
        self.store.update_settings(1, notifications='instant', keywords=[target['title']])
        await self.bot.handle(callback(1, f'hide:{target["id"]}'))
        self.api.sent.clear()
        await Bot(self.api, Store(self.path)).notify()
        self.assertEqual(self.api.sent, [])
        await self.bot.handle(callback(1, f'restore:{target["id"]}'))
        await self.bot.notify()
        self.assertEqual(len(self.api.sent), 1)

    async def test_notification_waits_for_another_process_editing_user_filters(self):
        target = self.jobs[0]
        self.store.update_settings(1, notifications='instant', keywords=[target['title']])
        self.assertTrue(self.store.acquire_lease('user:1', 'other-webhook', 60))
        await self.bot.notify()
        self.assertEqual(self.api.sent, [])
        self.store.update_settings(1, hidden_jobs=[target['id']])
        self.store.release_lease('user:1', 'other-webhook')
        await self.bot.notify()
        self.assertEqual(self.api.sent, [])

    async def test_restoring_does_not_resend_previously_delivered_jobs(self):
        target = self.jobs[0]
        self.store.update_settings(1, notifications='instant', keywords=[target['title']])
        await self.bot.notify()
        self.assertTrue(self.store.has_delivered(1, target['id']))
        await self.bot.handle(callback(1, f'hide:{target["id"]}'))
        await self.bot.handle(callback(1, f'restore:{target["id"]}'))
        await self.bot.notify()
        self.assertEqual(len(self.api.sent), 1)

    async def test_hidden_list_pagination_restore_and_last_page_clamping(self):
        ids = [j['id'] for j in self.jobs]
        self.store.update_settings(1, hidden_jobs=ids)
        self.store.update_settings(2, hidden_jobs=[ids[-1]])
        await self.bot.hidden(1, 1, page=2, mid=1)
        panel = self.api.calls[-1][1]
        self.assertIn('Страница 3 из 3', panel['text'])
        restores = [b['callback_data'] for row in panel['reply_markup']['inline_keyboard'] for b in row
                    if b.get('callback_data', '').startswith('restore:')]
        self.assertEqual(len(restores), 2)
        for action in restores:
            await self.bot.handle(callback(1, action))
        self.assertIn('Страница 2 из 2', self.api.calls[-1][1]['text'])
        self.assertEqual(len(hidden_job_ids(self.store.get_settings(1))), 10)
        self.assertEqual(hidden_job_ids(self.store.get_settings(2)), {ids[-1]})

    async def test_missing_job_can_still_be_removed_from_hidden_list(self):
        self.store.update_settings(1, hidden_jobs=[99999])
        await self.bot.hidden(1, 1, mid=1)
        self.assertIn('больше нет в базе', self.api.calls[-1][1]['text'])
        await self.bot.handle(callback(1, 'restore:99999:0'))
        self.assertEqual(hidden_job_ids(self.store.get_settings(1)), set())
        self.assertIn('Здесь пока пусто', self.api.calls[-1][1]['text'])

    async def test_hiding_a_card_does_not_skip_unseen_jobs_on_next_page(self):
        await self.bot.results(1, 1)
        next_action = f'search:1:{self.jobs[4]["id"]}'  # Previously delivered five-card pagination.
        for job in (self.jobs[0], self.jobs[4]):
            await self.bot.handle(callback(1, f'hide:{job["id"]}'))
        self.api.sent.clear()
        await self.bot.handle(callback(1, next_action))
        text = self.api.calls[-1][1]['text']
        self.assertIn(f'<b>{self.jobs[5]["title"]}</b>', text)
        self.assertNotIn(f'<b>{self.jobs[0]["title"]}</b>', text)
        self.assertEqual(self.api.sent, [])

    async def test_details_expand_and_stale_buttons_respect_hiding(self):
        job = self.jobs[0]
        self.store.save_jobs([dict(job, description='Long text ' * 200)])
        await self.bot.handle(callback(1, f'job:{job["id"]}:full'))
        full = self.api.calls[-1][1]['text']
        await self.bot.handle(callback(1, f'job:{job["id"]}:short'))
        self.assertGreater(len(full), len(self.api.calls[-1][1]['text']) * 2)
        await self.bot.handle(callback(1, f'hide:{job["id"]}'))
        await self.bot.handle(callback(1, f'job:{job["id"]}:full'))
        self.assertIn('Вакансия скрыта', self.api.calls[-1][1]['text'])
        self.assertNotIn('Long text', self.api.calls[-1][1]['text'])

    async def test_invalid_buttons_do_not_modify_hidden_ids_or_filters(self):
        before = self.store.get_settings(1)
        for action in ('hide:abc', 'hide:-1', 'hide:9999999', 'hide:1:2', 'restore:1:bad',
                       'choose:city:wrong:1', 'choose:salary:1000:1', 'choose:city:nis:2',
                       'job:1:bad', 'hide:999999999999999999999999999999999999'):
            await self.bot.handle(callback(1, action))
        self.assertEqual(self.store.get_settings(1), before)

    async def test_filter_reset_preserves_hidden_list_and_notification_preferences(self):
        self.store.update_settings(1, city=['belgrade', 'nis'], hidden_jobs=[1], notifications='daily')
        await self.bot.handle(callback(1, 'reset'))
        settings = self.store.get_settings(1)
        self.assertEqual(selected_values(settings, 'city'), ['any'])
        self.assertEqual(settings['hidden_jobs'], [1])
        self.assertEqual(settings['notifications'], 'daily')
        await self.bot.handle(callback(1, 'delete_confirm'))
        self.assertIsNone(self.store.get_subscriber(1))
        await self.bot.handle(message(1, '/start'))
        self.assertEqual(self.store.get_settings(1)['hidden_jobs'], [])

    async def test_retried_hidden_button_is_idempotent_across_processors(self):
        job_id = self.jobs[0]['id']
        first, second = WebhookProcessor(self.bot), WebhookProcessor(Bot(self.api, Store(self.path)))
        update = {'update_id': 501, **callback(1, f'hide:{job_id}')}
        await asyncio.gather(first.update(update), second.update(update))
        self.assertEqual(self.store.get_settings(1)['hidden_jobs'], [job_id])
        await second.update({'update_id': 502, **callback(1, f'hide:{job_id}')})
        self.assertEqual(self.store.get_settings(1)['hidden_jobs'], [job_id])

    async def test_supabase_existing_settings_rpc_supports_new_flow_without_migration(self):
        cloud = MemorySupabaseStore()
        api = FakeAPI()
        bot = Bot(api, cloud)
        cloud.ensure_user(1, 1)
        cloud.ensure_user(2, 2)
        cloud.update_settings(1, notifications='daily', keywords=['Python'])
        cloud.save_jobs([vacancy()])
        job = cloud.list_jobs()[0]
        cloud.mark_delivered(1, job['id'])
        await bot.handle(callback(1, 'choose:city:belgrade:1'))
        await bot.handle(callback(1, 'choose:city:novi_sad:1'))
        await bot.handle(callback(1, f'hide:{job["id"]}'))
        settings = cloud.get_settings(1)
        self.assertEqual(settings['city'], ['belgrade', 'novi_sad'])
        self.assertEqual(settings['hidden_jobs'], [job['id']])
        self.assertEqual(settings['keywords'], ['Python'])
        self.assertEqual(settings['notifications'], 'daily')
        self.assertEqual(cloud.get_settings(2)['hidden_jobs'], [])
        await bot.handle(callback(1, f'restore:{job["id"]}:0'))
        self.assertEqual(cloud.get_settings(1)['hidden_jobs'], [])
        self.assertTrue(cloud.has_delivered(1, job['id']))
        mutations = [c for c in cloud.calls if c['method'] not in ('GET', 'HEAD')]
        self.assertFalse(any(c['table'] not in ('sj_users', 'sj_jobs', 'sj_deliveries', 'rpc/sj_patch_settings') for c in mutations))
