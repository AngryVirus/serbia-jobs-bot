"""Known pay, salary ceilings and comparable monthly minimums are distinct."""
import unittest
import json
from pathlib import Path
import subprocess

from filters import matches
from salary_facts import salary_facts, salary_matches
from sources import SOURCES, _structured_job
from store import default_settings


class SalaryFactsTests(unittest.TestCase):
    def test_explicit_display_units_ranges_and_ceiling_wording(self):
        cases = [
            ('20 EUR / час', 20, None, 'EUR', 'hour'),
            ('371 RSD / sat', 371, None, 'RSD', 'hour'),
            ('500 RSD/H', 500, None, 'RSD', 'hour'),
            ('до 500 EUR / месяц', None, 500, 'EUR', 'month'),
            ('up to 2,000 USD per month', None, 2000, 'USD', 'month'),
            ('do 120.000 RSD mesečno', None, 120000, 'RSD', 'month'),
            ('1 000–2 000 EUR / месяц', 1000, 2000, 'EUR', 'month'),
            ('EUR 1.500,50 / month', 1500.5, None, 'EUR', 'month'),
            ('€1000 / month', 1000, None, 'EUR', 'month'),
            ('12000 EUR / year', 12000, None, 'EUR', 'year'),
            ('50 EUR / day', 50, None, 'EUR', 'day'),
            ('500 / month', 500, None, None, 'month'),
        ]
        for text, low, high, currency, period in cases:
            with self.subTest(text=text):
                self.assertEqual(salary_facts({'salary_display': text}), {
                    'known': True, 'min': low, 'max': high, 'currency': currency, 'period': period})

    def test_source_metadata_and_display_precedence(self):
        self.assertEqual(salary_facts({'salary_min': 1000, 'salary_currency': 'EUR'}), {
            'known': True, 'min': 1000, 'max': None, 'currency': 'EUR', 'period': 'month'})
        self.assertEqual(salary_facts({'salary_min': 500, 'salary_currency': 'EUR',
                                     'salary_period': 'month', 'salary_display': 'до 500 EUR'}), {
            'known': True, 'min': None, 'max': 500, 'currency': 'EUR', 'period': 'month'})
        # The source may store only a comparable monthly minimum. An explicit
        # hourly display must not inherit that monthly unit.
        self.assertEqual(salary_facts({'salary_min': 20, 'salary_period': 'month',
                                     'salary_display': '20 EUR / hour'})['period'], 'hour')

    def test_description_requires_salary_evidence(self):
        self.assertTrue(salary_facts({'description': 'Salary: up to 500 EUR per month.'})['known'])
        self.assertTrue(salary_facts({'description': 'Оплата: от 1000 EUR.'})['known'])
        self.assertTrue(salary_facts({'description': '1500 EUR / month.'})['known'])
        for text in ['Training course costs 500 EUR.', 'Company turnover: 100000 EUR.',
                     'Training fee 500 EUR per month.', 'Плата за обучение 500 EUR в месяц.',
                     'Salary negotiable. Mandatory training fee 500 EUR.',
                     'Address: 1500', 'Salary negotiable', 'Salary EUR unknown']:
            with self.subTest(text=text):
                self.assertFalse(salary_facts({'description': text})['known'])

    def test_costs_are_never_promoted_to_salary_through_collection_or_cached_facts(self):
        from dataclasses import asdict
        from job_metadata import enrich, text_salary
        from serverless.enrich_jobs import enrich_job
        from sources import Job
        texts = [
            'Проживание: 500 EUR в месяц.', 'Аренда жилья: 500 EUR в месяц.',
            'Обучение: 500 EUR в месяц.', 'Депозит: 500 EUR в месяц.',
            'Страховка: 500 EUR в месяц.', 'Troškovi obuke: 500 EUR mesečno.',
            'Smeštaj: 500 EUR mesečno.', 'Kirija: 500 EUR mesečno.',
            'Osiguranje: 500 EUR mesečno.', 'Depozit: 500 EUR mesečno.',
            'Трошкови обуке: 500 EUR месечно.', 'Смештај: 500 EUR месечно.',
            'Осигурање: 500 EUR месечно.', 'Accommodation: 500 EUR per month.',
            'Rental insurance: 500 EUR per month.', 'Training costs: 500 EUR per month.',
            'Deposit: 500 EUR per month.', 'Salary negotiable, housing: 500 EUR per month.',
            'Аренда:\n500 EUR в месяц.', 'Troškovi obuke:\n500 EUR mesečno.',
            'Housing:\n500 EUR / month.', '500 EUR в месяц за проживание.',
            '500 EUR / month for housing.', '500 EUR mesečno za smeštaj.',
        ]
        strict = dict(default_settings(), include_unknown_salary=False)
        for description in texts:
            with self.subTest(description=description):
                self.assertFalse(salary_facts({'description': description})['known'])
                self.assertEqual(text_salary(description), (None, None, None))
                collected = enrich(Job('radim', 'https://radim.rs/jobs/cook', 'Cook', description=description))
                self.assertIsNone(collected.salary_min)
                self.assertIsNone(collected.salary_display)
                self.assertFalse(enrich_job(collected)['_cloud']['salary']['known'])
                cached = {**asdict(collected), 'salary_min': 500, 'salary_currency': 'EUR',
                          'salary_period': 'month', 'salary_display': '500 EUR / month'}
                self.assertFalse(enrich_job(cached)['_cloud']['salary']['known'])
                self.assertFalse(matches(cached, strict))

    def test_real_salary_survives_cost_context_and_replaces_old_expense_extraction(self):
        from job_metadata import enrich
        from sources import Job
        strict = dict(default_settings(), include_unknown_salary=False, min_salary=1000)
        descriptions = [
            'Salary: 1500 EUR / month. Rent: 500 EUR / month.',
            'Аренда: 500 EUR в месяц. Заработная плата за месяц: 1500 EUR.',
            'Troškovi obuke: 500 EUR mesečno. Plata: 1500 EUR mesečno.',
            'Почасовая оплата: 20 EUR / час. Проживание: 500 EUR в месяц.',
        ]
        for description in descriptions:
            with self.subTest(description=description):
                cached = {'source': 'radim', 'title': 'Cook', 'description': description,
                          'salary_min': 500, 'salary_currency': 'EUR', 'salary_period': 'month',
                          'salary_display': '500 EUR / month'}
                facts = salary_facts(cached)
                self.assertTrue(facts['known'])
                self.assertEqual(facts['min'], 20 if 'Почасовая' in description else 1500)
                self.assertEqual(matches(cached, strict), 'Почасовая' not in description and facts['period'] == 'month')
                enriched = enrich(Job('radim', 'https://radim.rs/jobs/cook', 'Cook', description=description,
                                      salary_min=500, salary_currency='EUR', salary_period='month',
                                      salary_display='500 EUR / month'))
                self.assertNotRegex(enriched.salary_display, r'\b500\b')

    def test_json_ld_provenance_preserves_source_salary_including_equal_costs(self):
        from dataclasses import asdict
        from serverless.enrich_jobs import enrich_job
        from store import Store
        from tempfile import TemporaryDirectory
        for amount, cost in [(1500, 500), (1000, 1000)]:
            node = {'title': 'Cook', 'url': 'https://radim.rs/jobs/cook',
                    'description': f'Housing: {cost} EUR per month.',
                    'baseSalary': {'currency': 'EUR', 'value': {'minValue': amount, 'unitText': 'MONTH'}}}
            job = _structured_job(SOURCES['radim'], node, node['url'])
            raw = asdict(job)
            self.assertEqual(raw['salary_source'], 'structured')
            self.assertEqual(raw['salary_min'], amount)
            self.assertEqual(enrich_job(raw)['_cloud']['salary']['min'], amount)
            self.assertTrue(matches(raw, dict(default_settings(), min_salary=1000, include_unknown_salary=False)))
            with TemporaryDirectory() as directory:
                path = Path(directory) / 'jobs.sqlite'
                Store(path).save_jobs([job])
                restored = Store(path).list_jobs()[0]
                self.assertEqual(restored['salary_source'], 'structured')
                self.assertEqual(salary_facts(restored)['min'], amount)
        # A different currency or unit is not an identical cached expense.
        for description in ['Rent: 500 USD / month.', 'Rent: 500 EUR / day.']:
            facts = salary_facts({'salary_min': 500, 'salary_currency': 'EUR', 'salary_period': 'month',
                                  'salary_display': '500 EUR / month', 'description': description})
            self.assertTrue(facts['known'])
            self.assertEqual(facts['min'], 500)

    def test_display_missing_currency_inherits_explicit_source_currency(self):
        raw = {'source': 'radim', 'salary_display': '1000 / month', 'salary_currency': 'EUR'}
        self.assertEqual(salary_facts(raw)['currency'], 'EUR')
        self.assertTrue(matches(raw, dict(default_settings(), min_salary=1000, include_unknown_salary=False)))
        self.assertEqual(salary_facts({**raw, 'salary_display': '1000 RSD / month'})['currency'], 'RSD')

    def test_invalid_numbers_and_backwards_range_do_not_invent_minimum(self):
        for value in [True, -1, float('nan'), float('inf'), '1000', 1_000_000_000]:
            with self.subTest(value=value):
                self.assertFalse(salary_facts({'salary_min': value})['known'])
        self.assertFalse(salary_facts({'salary_display': '-500 EUR / month'})['known'])
        facts = salary_facts({'salary_display': '2000–1000 EUR / month'})
        self.assertTrue(facts['known'])
        self.assertIsNone(facts['min'])
        self.assertIsNone(facts['max'])

    def test_unknown_switch_keeps_known_hourly_and_maximum_only(self):
        settings = dict(default_settings(), include_unknown_salary=False)
        for display in ['20 EUR / hour', 'до 500 EUR / месяц']:
            self.assertTrue(salary_matches(salary_facts({'salary_display': display}), settings))
        self.assertFalse(salary_matches(salary_facts({}), settings))
        self.assertTrue(salary_matches(salary_facts({}), default_settings()))

    def test_monthly_minimum_rejects_contradictory_ceiling_and_incomparable_pay(self):
        settings = dict(default_settings(), min_salary=1000, currency='EUR')
        cases = [('до 500 EUR / месяц', False), ('до 2000 EUR / месяц', True),
                 ('1000–2000 EUR / месяц', True), ('900–2000 EUR / месяц', False),
                 ('20 EUR / hour', False), ('12000 EUR / year', False),
                 ('120000 RSD / месяц', False), ('1000 EUR', False)]
        for display, expected in cases:
            with self.subTest(display=display):
                self.assertEqual(salary_matches(salary_facts({'salary_display': display}), settings), expected)
        self.assertFalse(salary_matches(salary_facts({'salary_display': 'до 2000 EUR / месяц'}),
                                        dict(settings, include_unknown_salary=False)))

    def test_real_json_ld_hourly_and_ceiling_records_match_intended_policy(self):
        for values, description, expected in [
                ({'value': 20, 'unitText': 'HOUR'}, 'Cook wanted.', False),
                ({'maxValue': 500, 'unitText': 'MONTH'}, 'Salary up to 500 EUR / month.', False),
                ({'minValue': 1500, 'maxValue': 2000, 'unitText': 'MONTH'}, 'Cook wanted.', True)]:
            node = {'title': 'Cook', 'url': 'https://radim.rs/jobs/cook', 'description': description,
                    'jobLocation': {'address': {'addressLocality': 'Beograd', 'addressCountry': 'RS'}},
                    'baseSalary': {'currency': 'EUR', 'value': values}}
            from dataclasses import asdict
            raw = asdict(_structured_job(SOURCES['radim'], node, node['url']))
            self.assertTrue(matches(raw, dict(default_settings(), include_unknown_salary=False)))
            self.assertEqual(matches(raw, dict(default_settings(), min_salary=1000)), expected)

    def test_refreshed_fact_cases_agree_between_python_and_live_runtime_matcher(self):
        from serverless.enrich_jobs import enrich_job
        base = {'id': 1, 'source': 'radim', 'url': 'https://radim.rs/jobs/cook',
                'title': 'Cook', 'location': 'Beograd', 'languages': [], 'remote': None}
        cases = []
        samples = [
            ({'salary_display': '20 EUR / hour'}, {'include_unknown_salary': False}, True),
            ({'salary_display': 'до 500 EUR / месяц'}, {'min_salary': 1000}, False),
            ({'salary_display': 'до 2000 EUR / месяц'}, {'min_salary': 1000}, True),
            ({'salary_display': 'до 2000 EUR / месяц'}, {'min_salary': 1000, 'include_unknown_salary': False}, False),
            ({'description': 'English: B2'}, {'language': 'english'}, True),
            ({'description': 'Знание русского языка обязательно'}, {'language': 'russian'}, True),
            ({'description': 'Српски језик обавезан'}, {'language': 'serbian'}, True),
            ({'description': 'Формат: удаленно'}, {'remote': 'only'}, True),
            ({'description': 'Hybrid role'}, {'remote': 'office'}, True),
            ({'description': 'Cook wanted'}, {'remote': 'only'}, False),
        ]
        for raw_patch, settings_patch, expected in samples:
            raw, settings = {**base, **raw_patch}, {**default_settings(), **settings_patch}
            self.assertEqual(matches(raw, settings), expected, (raw_patch, settings_patch))
            cases.append({'job': enrich_job(raw), 'settings': settings})
        script = "import {matches} from './serverless/tgcloud/lib/filters.js'; let b=''; for await (const c of process.stdin)b+=c; console.log(JSON.stringify(JSON.parse(b).map(c=>matches(c.job,c.settings))));"
        completed = subprocess.run(['node', '--input-type=module', '-e', script],
                                   cwd=Path(__file__).resolve().parents[1], input=json.dumps(cases),
                                   capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(completed.stdout), [sample[2] for sample in samples])


if __name__ == '__main__':
    unittest.main()
