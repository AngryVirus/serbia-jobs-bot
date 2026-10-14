"""Bounded parsing of the official public Infostud vacancy RSS feed."""
from datetime import timezone
from email.utils import parsedate_to_datetime
import re
from xml.etree import ElementTree

from filters import CITY_NAMES, active, normalize, serbia_eligible
from job_metadata import enrich, remote_fact, text_salary
from sources import FetchError, Job, _status, canonical_url, clean_text, is_detail_url, parse_page


def collect_rss(source, fetcher):
    jobs = {}
    try:
        body, _ = fetcher.get(source.listing_url)
        if re.search(r'<!DOCTYPE|<!ENTITY', body, re.I):
            raise ValueError('Unsupported XML declarations')
        root = ElementTree.fromstring(body)
        if root.tag != 'rss' or root.find('channel') is None:
            raise ValueError('Expected RSS channel')
        for item in root.findall('./channel/item')[:100]:
            url = canonical_url(item.findtext('link') or '')
            title = clean_text(item.findtext('title'))
            if not title or not is_detail_url(source, url):
                continue
            description = '\n'.join(parse_page(item.findtext('description') or '').lines)[:16000]
            published = None
            try:
                date = parsedate_to_datetime(item.findtext('pubDate') or '')
                if date.tzinfo is not None:
                    published = date.astimezone(timezone.utc).isoformat()
            except (ValueError, TypeError, OverflowError):
                pass
            location = ''
            for names in CITY_NAMES.values():
                city = next((name for name in names if re.search(r'(?<!\w)' + re.escape(normalize(name)) + r'(?!\w)', normalize(description))), None)
                if city:
                    location = city
                    break
            job = Job(source.id, url, title, location=location, description=description,
                      published_at=published, remote=remote_fact(description))
            job.salary_min, job.salary_currency, job.salary_period = text_salary(description)
            job = enrich(job)
            if active(job.__dict__) and serbia_eligible(job.__dict__):
                jobs[url] = job
    except FetchError as error:
        return [], _status(source, error.state, detail=error.detail)
    except (ElementTree.ParseError, ValueError):
        return [], _status(source, 'error', detail='Источник вернул некорректную RSS-ленту.')
    return list(jobs.values()), _status(source, 'ok' if jobs else 'empty', len(jobs),
        'Официальная RSS-лента последних вакансий Infostud; до 100 записей, без обхода истории.')
