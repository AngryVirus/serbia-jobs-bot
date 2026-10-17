import unittest
from source_policy import serbian_channel_title, validate_channel_page, source_enabled
from sources import FetchError, SOURCES, collect_source
from test_sources import FakeFetcher


class SourcePolicyTests(unittest.TestCase):
    def test_geographic_channel_titles(self):
        for title in ['Сербия', 'Работа Сербия', 'Работа Белград', 'Работа в Сербии',
                      'Poslovi Beograd', 'Jobs in Serbia', 'Нови-Сад работа', 'Posao Niš']:
            self.assertTrue(serbian_channel_title(title), title)
        for title in ['Worldwide Careers', 'Python Jobs', 'Удалёнка', 'Business jobs', '']:
            self.assertFalse(serbian_channel_title(title), title)

    def test_channel_rename_cannot_bypass_title_check_with_serbian_post(self):
        html = '<meta property="og:title" content="Worldwide Careers">Hiring in Serbia'
        with self.assertRaises(FetchError):
            validate_channel_page(html)
        for key in ['telegram_youritjob', 'tg_radim_serbia']:
            source = SOURCES[key]
            jobs, status = collect_source(source, fetcher=FakeFetcher({source.listing_url: html}))
            self.assertEqual(jobs, [])
            self.assertEqual(status['state'], 'excluded')

    def test_excluded_sources_and_reviewed_sources(self):
        for key in ['halooglasi', 'infostud', 'telegram_python_jobs', 'telegram_serbia_jobs']:
            self.assertFalse(source_enabled(key))
        for key in ['poslovi', 'radim', 'tg_radim_serbia', 'telegram_youritjob']:
            self.assertTrue(source_enabled(key))
