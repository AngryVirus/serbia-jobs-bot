import unittest
from job_quality import quality_reason, explicit_requirements
from telegram_sources import hiring_post
from sources import SOURCES, collect_source
from test_telegram_sources import post
from test_sources import FakeFetcher


class QualityTests(unittest.TestCase):
    def test_classifies_explicit_nonjobs_in_three_languages(self):
        cases = {'seeker': ['Ищу работу поваром в Сербии', 'I am looking for a job in Serbia', 'Tražim posao u Srbiji'],
                 'services': ['Предлагаю услуги ремонта', 'I offer my services', 'Nudim usluge prevoda'],
                 'closed': ['Вакансия закрыта', 'Position has been filled', 'Konkurs je završen'],
                 'promotion': ['Реклама курсов для работы', 'Записывайтесь на вебинар', 'Join our course'],
                 'digest': ['Подборка вакансий в Сербии', 'Weekly job roundup']}
        for expected, texts in cases.items():
            for text in texts:
                with self.subTest(text=text): self.assertEqual(quality_reason(text), expected)

    def test_negations_conditionals_and_hiring_footer_are_preserved(self):
        for text in ['Вакансия не закрыта. Требуется повар', 'Если вакансия закрыта, напишите нам',
                     'Position is not filled', 'Опыт закрытия вакансий обязателен',
                     'Требуется повар в Белграде. Подписывайтесь на наш канал',
                     'We are hiring. Are you looking for a job?']:
            with self.subTest(text=text): self.assertIsNone(quality_reason(text))
        self.assertTrue(hiring_post('Требуется повар в Белграде. Подписывайтесь на наш канал'))

    def test_closed_post_marks_original_url_even_without_valid_job_template(self):
        source=SOURCES['telegram_serbia_jobs']
        first=source.listing_url
        jobs,status=collect_source(source,fetcher=FakeFetcher({first:post(99,'Вакансия закрыта'),first+'?before=99':'No earlier posts'}))
        self.assertEqual(jobs,[])
        self.assertEqual(status['withdrawn_urls'],['https://t.me/serbia_jobs/99'])

    def test_explicit_requirements_and_uncertainty(self):
        cases = [
            ('Опыт обязателен. Помогаем с оформлением ВНЖ.', True, True),
            ('Можно без опыта. Помощь с оформлением ВНЖ не предоставляется.', False, False),
            ('Без опыта не принимаем.', True, None),
            ('Не требуется опыт работы.', False, None),
            ('Nije potrebno radno iskustvo.', False, None),
            ('No experience required. Visa sponsorship provided.', False, True),
            ('Visa sponsorship is not available.', None, False),
            ('Potrebno radno iskustvo. Pomoc pri dobijanju radne dozvole.', True, True),
            ('Senior developer. Официальное трудоустройство.', None, None),
            ('Опыт желателен. Помощь с оформлением заказа.', None, None),
            ('Опыт обязателен. Опыт не требуется.', None, None),
            ('Если нужна помощь с оформлением ВНЖ, обсудим.', None, None),
            ('Our company has 20 years experience.', None, None),
        ]
        for text,experience,assistance in cases:
            with self.subTest(text=text): self.assertEqual(explicit_requirements(text),{'experience':experience,'paperwork_assistance':assistance})


if __name__=='__main__': unittest.main()
