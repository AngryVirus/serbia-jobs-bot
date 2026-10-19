"""Revalidate derived generic Telegram geography without changing source rows."""
from copy import deepcopy
import unittest

from serverless.enrich_jobs import enrich_job


class TelegramFactRepairTests(unittest.TestCase):
    def cached(self, text, source='telegram_youritjob'):
        return {'id': 8525, 'source': source, 'title': 'Hiring engineer',
                'description': text, 'country': 'RS', 'location': 'Raca',
                'url': 'https://t.me/youritjob/8525'}

    def test_old_raci_country_is_retracted_without_changing_raw_fields(self):
        raw = self.cached('Establish project governance, RACI, reporting cadence.')
        before = deepcopy(raw)
        fresh = enrich_job(raw)
        self.assertFalse(fresh['_cloud']['serbia'])
        self.assertEqual(raw, before)
        self.assertEqual({key: fresh[key] for key in raw}, raw)

    def test_country_or_real_city_evidence_survives_raci_and_footers_do_not_count(self):
        for text in ['Serbia\nEstablish project governance, RACI, reporting cadence.',
                     'Location: Belgrade\nEstablish RACI.', 'Posao u Rači.']:
            with self.subTest(text=text):
                self.assertTrue(enrich_job(self.cached(text))['_cloud']['serbia'])
        text = 'Establish RACI.\nРабота в Сербии · наш Telegram канал'
        self.assertFalse(enrich_job(self.cached(text))['_cloud']['serbia'])

    def test_specialized_channels_keep_their_existing_remote_admission(self):
        raw = self.cached('Hiring engineer, remote worldwide.', source='tg_rabotavserbii')
        self.assertTrue(enrich_job(raw)['_cloud']['serbia'])


if __name__ == '__main__':
    unittest.main()
