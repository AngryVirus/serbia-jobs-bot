from dataclasses import asdict
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

from addresses import job_address, maps_url
from presentation import job_text, job_buttons
from sources import SOURCES, extract_jobs
from store import Store
from viewer import render_card, viewer_buttons
from test_bot import vacancy
from test_cloud_store import MemorySupabaseStore
from test_sources import structured


class AddressTests(unittest.IsolatedAsyncioTestCase):
    def test_explicit_address_is_linked_and_city_alone_is_not(self):
        job = vacancy(location='Beograd', description='Требуется повар\nАдрес: Knez Mihailova 12\nКонтакты: @owner')
        address = job_address(job)
        self.assertEqual(address, 'Knez Mihailova 12, Beograd')
        self.assertEqual(parse_qs(urlsplit(maps_url(job)).query), {'api': ['1'], 'query': [address]})
        self.assertIn('https://www.google.com/maps/search/', job_text(job))
        for description in ('Работа в Белграде', 'Зарплата: 1500 EUR', 'Адрес: Beograd',
                            'Адрес: https://evil.example/12', 'Телефон: +381 123456789'):
            self.assertIsNone(maps_url(vacancy(location='Beograd', description=description)))

    def test_structured_street_survives_both_stores_without_schema_change(self):
        html = structured(jobLocation={'address': {'streetAddress': 'Bulevar kralja Aleksandra 73',
                                                   'addressLocality': 'Beograd', 'addressCountry': 'RS'}})
        job = extract_jobs(SOURCES['radim'], html, 'https://radim.rs/jobs/engineer-123')[0]
        with tempfile.TemporaryDirectory() as directory:
            for store in (Store(Path(directory) / 'jobs.db'), MemorySupabaseStore()):
                store.save_jobs([job])
                restored = store.list_jobs()[0]
                self.assertEqual(restored['location'], 'Bulevar kralja Aleksandra 73, Beograd')
                self.assertEqual(maps_url(restored), maps_url(asdict(job)))
                self.assertTrue(any('Google Maps' in b['text'] for row in job_buttons(restored) for b in row))
                self.assertTrue(any('Google Maps' in b['text'] for row in viewer_buttons(restored, 0, 1, 's') for b in row))

    async def test_translation_and_html_escaping_preserve_original_address(self):
        class Translator:
            async def translate(self, value): return 'Переведённый текст без адреса'
        job = vacancy(location='Beograd', description='Address: Knez <Mihailova> & Co 12')
        original = maps_url(job)
        rendered, failed = await render_card(job, 'rf', Translator())
        self.assertFalse(failed)
        self.assertIn('&lt;Mihailova&gt;', rendered)
        self.assertNotIn('<Mihailova>', rendered)
        self.assertIn(original.replace('&', '&amp;'), rendered)
