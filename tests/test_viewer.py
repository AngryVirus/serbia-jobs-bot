import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

from bot import Bot
from presentation import job_buttons
from store import Store
from test_bot import FakeAPI, callback, vacancy
from test_personal_filters import VisibleText
from translation import Translator, TranslationError, browser_translation_url


class ViewerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'test.db')
        self.api = FakeAPI()
        self.bot = Bot(self.api, self.store)
        for uid in (1, 2):
            self.store.ensure_user(uid, uid)
        self.store.save_jobs([vacancy(title=f'Job {i}', description='English required\nTasks and benefits ' * 30,
                                     url=f'https://poslovi.rs/job/{i}') for i in range(4)])
        self.jobs = self.store.list_jobs()

    def tearDown(self):
        self.temp.cleanup()

    @property
    def panel(self):
        return next(p for method, p in reversed(self.api.calls) if method == 'editMessageText')

    def action(self, action):
        return next(b['callback_data'] for row in self.panel['reply_markup']['inline_keyboard'] for b in row
                    if f':{action}:' in b.get('callback_data', ''))

    async def press(self, action, uid=1):
        update = callback(uid, action)
        update['callback_query']['message']['message_id'] = 77
        await self.bot.handle(update)

    async def test_navigation_and_details_edit_the_same_message(self):
        await self.press('search:0')
        self.assertIn('Вакансия 1 из 4', self.panel['text'])
        self.assertIn(self.jobs[0]['title'], self.panel['text'])
        first_next = self.action('next')
        await self.press(first_next)
        self.assertIn('Вакансия 2 из 4', self.panel['text'])
        self.assertIn(self.jobs[1]['title'], self.panel['text'])
        await self.press(first_next)  # Stale double-tap must not advance twice.
        self.assertIn('Вакансия 2 из 4', self.panel['text'])
        await self.press(self.action('prev'))
        short = self.panel['text']
        await self.press(self.action('details'))
        self.assertGreater(len(self.panel['text']), len(short))
        await self.press(self.action('details'))
        self.assertEqual(self.panel['text'], short)
        self.assertEqual(self.api.sent, [])
        self.assertTrue(all(p['message_id'] == 77 for method, p in self.api.calls if method == 'editMessageText'))

    async def test_hide_shows_next_without_skipping_and_remains_private(self):
        await self.press('search:0')
        hide = self.action('hide')
        await self.press(hide)
        self.assertIn(self.jobs[1]['title'], self.panel['text'])
        self.assertIn('Вакансия 1 из 3', self.panel['text'])
        await self.press(hide)
        self.assertIn(self.jobs[1]['title'], self.panel['text'])
        self.assertEqual(self.store.get_settings(1)['hidden_jobs'], [self.jobs[0]['id']])
        await self.press('search:0', uid=2)
        self.assertIn(self.jobs[0]['title'], self.panel['text'])
        await self.press(f'restore:{self.jobs[0]["id"]}:0')
        await self.press('search:0')
        self.assertIn(self.jobs[0]['title'], self.panel['text'])

    async def test_last_hidden_card_becomes_empty_panel_with_restore_access(self):
        self.store.update_settings(1, hidden_jobs=[j['id'] for j in self.jobs[1:]])
        await self.press('search:0')
        await self.press(self.action('hide'))
        self.assertIn('Вакансия скрыта', self.panel['text'])
        self.assertIn('вне вашего списка скрытых', self.panel['text'])
        rows = self.panel['reply_markup']['inline_keyboard']
        self.assertTrue(any(b.get('callback_data') == 'hidden:0' for row in rows for b in row))
        self.assertEqual(self.api.sent, [])

    async def test_stale_filtered_card_does_not_translate_a_different_job(self):
        await self.press('search:0')
        translate = self.action('translate')
        self.store.update_settings(1, keywords=[self.jobs[2]['title']])
        with patch.object(self.bot.translator, 'translate', side_effect=AssertionError('Unrequested translation')):
            await self.press(translate)
        self.assertIn(self.jobs[2]['title'], self.panel['text'])
        self.assertIn('Подборка изменилась', self.panel['text'])
        self.assertNotIn(self.jobs[0]['title'], self.panel['text'])

    async def test_translation_original_and_details_preserve_facts_and_navigation(self):
        async def translate(text):
            return 'Перевод <текста> & русский\n' + text
        before = self.store.list_jobs()
        await self.press('search:0')
        with patch.object(self.bot.translator, 'translate', side_effect=translate):
            await self.press(self.action('translate'))
            self.assertIn('Перевод на русский', self.panel['text'])
            self.assertIn('&lt;текста&gt;', self.panel['text'])
            self.assertIn('1500 EUR', self.panel['text'])
            self.assertEqual(self.panel['reply_markup']['inline_keyboard'][0][0]['url'], self.jobs[0]['url'])
            await self.press(self.action('details'))
            self.assertIn('Перевод на русский', self.panel['text'])
            self.assertLess(len(VisibleText(self.panel['text']).text.encode('utf-16-le')) // 2, 4096)
            await self.press(self.action('translate'))
        self.assertNotIn('Перевод на русский', self.panel['text'])
        self.assertEqual(self.store.list_jobs(), before)
        await self.press(self.action('next'))
        self.assertIn(self.jobs[1]['title'], self.panel['text'])
        self.assertEqual(self.api.sent, [])

    async def test_translation_failure_keeps_original_retry_and_browser_buttons(self):
        await self.press('search:0')
        with patch.object(self.bot.translator, 'translate', side_effect=TranslationError()):
            await self.press(self.action('translate'))
        self.assertIn('Перевод сейчас недоступен', self.panel['text'])
        self.assertIn(self.jobs[0]['title'], self.panel['text'])
        rows = self.panel['reply_markup']['inline_keyboard']
        browser = next(b['url'] for row in rows for b in row if b['text'] == '🌐 Перевести в браузере')
        self.assertEqual(parse_qs(urlsplit(browser).query)['u'], [self.jobs[0]['url']])
        self.assertTrue(self.action('translate').endswith(':s'))
        await self.press(self.action('next'))
        self.assertIn(self.jobs[1]['title'], self.panel['text'])

    async def test_notification_cards_have_translation_and_open_viewer_in_place(self):
        job = self.jobs[0]
        rows = job_buttons(job)
        translate = next(b['callback_data'] for row in rows for b in row if 'Перевести' in b['text'])
        with patch.object(self.bot.translator, 'translate', return_value='Русский текст'):
            await self.press(translate)
        self.assertIn('Русский текст', self.panel['text'])
        await self.press('search:0')
        self.assertIn('Вакансия 1 из 4', self.panel['text'])
        self.assertEqual(self.api.sent, [])

    async def test_malformed_cursor_cannot_change_settings_or_emit_messages(self):
        before = self.store.get_settings(1)
        for data in ('view:0:0:hide:s', 'view:-1:0:hide:s', 'view:1:xx:hide:s',
                     'view:1:0:unknown:s', 'view:1:0:hide:unknown', 'view:1:1000001:hide:s'):
            await self.press(data)
        self.assertEqual(self.store.get_settings(1), before)
        self.assertEqual(self.api.sent, [])
        self.assertFalse(any(m == 'editMessageText' for m, _ in self.api.calls))


class TranslationClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_target_language_cache_and_changed_source(self):
        client = Translator()
        def respond(request, timeout):
            query = parse_qs(urlsplit(request.full_url).query)
            self.assertEqual(query['tl'], ['ru'])
            self.assertEqual(query['sl'], ['auto'])
            return io.BytesIO(json.dumps([[['Перевод ' + query['q'][0], query['q'][0]]]]).encode())
        with patch('translation.urlopen', side_effect=respond) as request:
            self.assertEqual(await client.translate('Support specialist'), 'Перевод Support specialist')
            await client.translate('Support specialist')
            self.assertEqual(request.call_count, 1)
            await client.translate('Senior support specialist')
            self.assertEqual(request.call_count, 2)

    async def test_long_text_is_split_without_loss_and_empty_text_avoids_network(self):
        text = 'Long description ' * 180
        chunks = []
        def echo(request, timeout):
            value = parse_qs(urlsplit(request.full_url).query)['q'][0]
            chunks.append(value)
            self.assertLessEqual(len(value), 900)
            return io.BytesIO(json.dumps([[[value, value]]]).encode())
        with patch('translation.urlopen', side_effect=echo) as request:
            client = Translator()
            translated = await client.translate(text)
            self.assertEqual(translated.split(), text.split())
            self.assertGreater(len(chunks), 1)
            count = request.call_count
            self.assertEqual(await client.translate(''), '')
            self.assertEqual(request.call_count, count)

    async def test_errors_are_safe_and_not_cached(self):
        client = Translator()
        with patch('translation.urlopen', side_effect=URLError('private request details')) as request:
            for _ in range(2):
                with self.assertRaisesRegex(TranslationError, '^Translation service unavailable$'):
                    await client.translate('Source vacancy')
            self.assertEqual(request.call_count, 2)
        for payload in ('null', '{}', '[]', '[[]]', '[[[123]]]'):
            with patch('translation.urlopen', return_value=io.BytesIO(payload.encode())):
                with self.assertRaises(TranslationError):
                    await Translator().translate('Source vacancy')

    async def test_contact_only_browser_fallback_encodes_text(self):
        url = browser_translation_url({'title': 'A & B', 'description': 'Work', 'url': 'javascript:bad'})
        self.assertEqual(urlsplit(url).hostname, 'translate.google.com')
        self.assertEqual(parse_qs(urlsplit(url).query)['text'], ['A & B\nWork'])
