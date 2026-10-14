import json
import unittest
from sources import SOURCES,collect_source,parse_feed_jobs,Job
from job_metadata import enrich
from test_sources import FakeFetcher


class PublicAPITests(unittest.TestCase):
    def test_serbiahub_two_bounded_pages_and_unknown_publication(self):
        routes={}
        for offset in (0,50):
            items=[{'id':offset+i,'title':'Support','description':'Russian language required.',
                    'city':'Beograd','firstSeen':'2026-10-14T00:00:00Z','isRemote':True,
                    'salaryMin':1500,'salaryCurrency':'EUR','salaryPeriod':'month'} for i in range(50)]
            routes[f'https://serbiahub.com/api/jobs?limit=50&offset={offset}']=json.dumps({'items':items,'total':999})
        fetcher=FakeFetcher(routes)
        jobs,status=collect_source(SOURCES['serbiahub'],fetcher=fetcher)
        self.assertEqual(len(fetcher.calls),2)
        self.assertEqual(len(jobs),100)
        self.assertEqual(status['state'],'ok')
        self.assertTrue(all(job.published_at is None for job in jobs))
        self.assertTrue(all('/detail/jobs/' in job.url for job in jobs))
        self.assertTrue(all(job.remote is True for job in jobs))

    def test_serbiahub_foreign_and_expired_jobs_are_removed(self):
        body={'total':2,'items':[{'id':1,'title':'Support','city':'Berlin, Germany'},
                                 {'id':2,'title':'Support','expirationDate':'2001-01-01'}]}
        fetcher=FakeFetcher({'https://serbiahub.com/api/jobs?limit=50&offset=0':json.dumps(body)})
        jobs,status=collect_source(SOURCES['serbiahub'],fetcher=fetcher)
        self.assertEqual(jobs,[])
        self.assertEqual(status['state'],'empty')

    def test_maximum_salary_does_not_become_guaranteed_minimum(self):
        source=SOURCES['klikdoposla']
        body=json.dumps({'jobs':[{'title':'Support','url':'https://www.klikdoposla.com/oglasi/123-test',
                                  'description_text':'до 2000 EUR в месяц','working_model':['Remote']}],
                          'has_more':False})
        jobs,_=parse_feed_jobs(source,body)
        self.assertIsNone(jobs[0].salary_min)
        self.assertIn('до 2000',jobs[0].salary_display)
        self.assertEqual(jobs[0].salary_period,'month')

    def test_explicit_listing_pagination_shares_detail_budget(self):
        source=SOURCES['radim']
        first='<a href="/jobs/a">A</a><a href="/jobs?page=2">Next</a>'
        second='<a href="/jobs/b">B</a><a href="/jobs?page=3">Next</a>'
        detail='<h1>Developer</h1><p>Requirements</p><p>English required.</p>'
        routes={source.listing_url:first,source.listing_url+'?page=2':second,
                'https://radim.rs/jobs/a':detail,'https://radim.rs/jobs/b':detail}
        fetcher=FakeFetcher(routes)
        jobs,status=collect_source(source,detail_limit=2,fetcher=fetcher)
        self.assertEqual(len(jobs),2)
        self.assertEqual(status['listing_pages'],2)
        self.assertNotIn('https://radim.rs/jobs?page=3',fetcher.calls)
