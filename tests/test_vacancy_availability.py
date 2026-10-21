import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from email.message import Message

from sources import SOURCES, Fetcher, FetchError
from vacancy_availability import inspect,inspect_batch,closed_notice
from test_sources import structured,Opener
from test_telegram_sources import post

class Fake:
    def __init__(self,value,final=None):self.value=value;self.final=final;self.calls=[]
    def get(self,url):
        self.calls.append(url)
        if isinstance(self.value,Exception):raise self.value
        return self.value,self.final or url

class AvailabilityTests(unittest.TestCase):
    target={'id':1,'source':'radim','url':'https://radim.rs/jobs/support-123'}
    def test_exact_original_parsing_expiry_and_redirects(self):
        active=inspect(self.target,Fake(structured()))
        self.assertEqual((active['state'],active['reason']),('active','parsed'))
        self.assertIsNone(active['expires_ms'])
        self.assertEqual(inspect(self.target,Fake(structured(validThrough='2020-01-01')))['state'],'closed')
        self.assertEqual(inspect(self.target,Fake(structured(),final='https://radim.rs/jobs'))['state'],'unknown')
        self.assertEqual(inspect(self.target,Fake(structured(url='/jobs/another')))['state'],'unknown')

    def test_only_confirmed_http_failures_are_negative_evidence(self):
        for code,expected in [(404,'missing'),(410,'closed'),(403,'unknown'),(429,'unknown'),(500,'unknown')]:
            error=FetchError('error','private ignored text',http_status=code,http_url=self.target['url'])
            self.assertEqual(inspect(self.target,Fake(error))['state'],expected)
        for error in [FetchError('robots_disallowed','HTTP 410'),FetchError('blocked','HTTP 404'),FetchError('error','timeout'),FetchError('error','404',http_status=404,http_url='https://radim.rs/robots.txt')]:
            self.assertEqual(inspect(self.target,Fake(error))['state'],'unknown')
        for code in [404,410]:
            f=Fetcher(SOURCES['radim'],delay=0)
            f.opener=Opener({'https://radim.rs/robots.txt':'User-agent: *\nAllow: /',self.target['url']:HTTPError(self.target['url'],code,'not found',Message(),None)})
            self.assertEqual(inspect(self.target,f)['state'],'missing' if code==404 else 'closed')

    def test_closure_notices_questions_and_navigation(self):
        for text in ['Вакансия закрыта','Position has been filled','This job is closed','Oglas je istekao']:
            self.assertTrue(closed_notice([text]),text)
            self.assertEqual(inspect(self.target,Fake('<h1>'+text+'</h1>'))['state'],'closed')
        for text in ['Вакансия неактуальна? Это ваше объявление? Убрать его','Вакансия не закрыта','Если вакансия закрыта, свяжитесь с нами','This job is not closed','Page not found','Closed vacancies']:
            self.assertFalse(closed_notice([text]),text)
            self.assertEqual(inspect(self.target,Fake('<h1>'+text+'</h1>'))['state'],'unknown')
        self.assertEqual(inspect(self.target,Fake(structured()+'<footer>Вакансия закрыта</footer>'))['state'],'active')

    def test_telegram_presence_does_not_renew_stale_hiring_and_other_posts_cannot_close_it(self):
        target={'id':1,'source':'tg_rabotavserbii','url':'https://t.me/rabotavserbii/99'}
        for text,expected in [('Требуется повар в Белграде','unknown'),('❌ Вакансия закрыта','closed'),
                              ('Вакансия закрыта?','unknown'),('Вакансия не закрыта','unknown'),
                              ('Если вакансия закрыта, напишите нам','unknown')]:
            f=Fake(post(99,text,channel='rabotavserbii'))
            self.assertEqual(inspect(target,f)['state'],expected)
            self.assertEqual(f.calls,['https://t.me/s/rabotavserbii/99'])
        self.assertEqual(inspect(target,Fake(post(98,'Вакансия закрыта',channel='rabotavserbii')))['state'],'unknown')

    def test_source_policy_urls_and_deadline_are_enforced_before_requests(self):
        for source,url in [('helloworld','https://www.helloworld.rs/konkurs/test/company/1'),('radim','https://example.com/jobs/1'),('radim','https://radim.rs:22/jobs/1'),('radim','https://user:pass@radim.rs/jobs/1'),('radim','https://radim.rs/admin'),('missing','https://radim.rs/jobs/1')]:  # pragma: allowlist secret
            f=Fake('');result=inspect({'id':1,'source':source,'url':url},f)
            self.assertEqual(result['state'],'unknown');self.assertEqual(f.calls,[])
        with patch('vacancy_availability.Fetcher') as fetcher:
            self.assertEqual(inspect_batch([self.target],deadline=time.monotonic()-1),[])

if __name__=='__main__':unittest.main()
