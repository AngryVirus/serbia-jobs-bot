"""Recheck saved public vacancy URLs without discovering sites or bypassing access.

A live Telegram post alone does not confirm that its employer is still hiring.
Publisher originals are supplied by the reviewed cloud identity mapping.
"""
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
import re
import time

from crawl_state import _public_url
from filters import active, normalize
from source_policy import source_enabled, validate_channel_page
from sources import SOURCES, Fetcher, FetchError, canonical_url, is_detail_url, parse_page, extract_jobs
from telegram_sources import ChannelPage


def closed_notice(lines):
    # Only a short standalone status, never footer questions, negations, related
    # vacancies, conditional instructions or a successful-closure job duty.
    for line in lines[:24]:
        value=re.sub(r'^[^\w]+', '', normalize(line)).strip(' .!·—-')
        if len(value)>160 or '?' in line or re.search(r'\b(?:если|когда|if|when|ako|не|not|nije)\b',value):
            continue
        if re.fullmatch(r'(?:(?:this|the) )?(?:job|vacancy|position|oglas|konkurs|вакансия|объявление|набор)(?: (?:is|has been|je|уже))? (?:closed|filled|expired|removed|deleted|zavrsen|zatvoren|istekao|закрыта?|снята?|удален[ао]?|завершен)',value):
            return True
    return False


def inspect(candidate,fetcher=None):
    uid=candidate['id'];source=SOURCES.get(candidate.get('source'));url=candidate.get('url')
    def result(state,reason,**fields):return {'id':uid,'key':candidate.get('key',''),'state':state,'reason':reason,**fields}
    if not source or not source_enabled(source.id) or source.requires_permission or not _public_url(source,url) or not is_detail_url(source,url):
        return result('unknown','unsupported')
    fetcher=fetcher or Fetcher(source)
    fetch_url=url
    if source.telegram_channel:
        fetch_url='https://t.me/s/'+source.telegram_channel+'/'+urlsplit(url).path.rstrip('/').split('/')[-1]
    try:
        html,final=fetcher.get(fetch_url)
        if source.telegram_channel:
            validate_channel_page(html)
            page=ChannelPage(source.telegram_channel);page.feed(html);page.close()
            number=int(urlsplit(url).path.rstrip('/').split('/')[-1])
            post=next((p for p in page.posts if p['id']==number),None)
            if post and closed_notice(post['text'].splitlines()):return result('closed','publisher_notice')
            return result('unknown','post_only' if post else 'unrecognized')
        # Redirects to listings, login pages and unrelated details prove nothing.
        if canonical_url(final).rstrip('/')!=canonical_url(url).rstrip('/'):
            return result('unknown','unrecognized')
        page=parse_page(html)
        jobs=[j for j in extract_jobs(source,html,final) if canonical_url(j.url).rstrip('/')==canonical_url(url).rstrip('/')]
        if closed_notice(page.lines):return result('closed','publisher_notice')
        for job in jobs:
            if closed_notice((job.title+'\n'+job.description).splitlines()):return result('closed','publisher_notice')
            if not active(job.__dict__):return result('closed','expired')
            from serverless.enrich_jobs import enrich_job
            return result('active','parsed',expires_ms=enrich_job(job)['_cloud']['expires_ms'])
        return result('unknown','unrecognized')
    except FetchError as error:
        # HTTP evidence is attached only to the final request, never inferred
        # from error strings or robots failures. 404 requires two spaced probes.
        if error.http_status in {404,410} and error.http_url and canonical_url(error.http_url).rstrip('/')==canonical_url(fetch_url).rstrip('/'):
            return result('closed' if error.http_status==410 else 'missing','gone' if error.http_status==410 else 'not_found')
        return result('unknown','unavailable')
    except (ValueError,TypeError,KeyError):
        return result('unknown','unrecognized')


def inspect_batch(candidates,*,deadline=None):
    if deadline is not None and time.monotonic()>=deadline:return []
    groups={}
    for candidate in candidates:groups.setdefault(candidate.get('source'),[]).append(candidate)
    def run(items):
        source=SOURCES.get(items[0].get('source'));fetcher=Fetcher(source) if source else None
        if fetcher and deadline is not None:fetcher.deadline=min(fetcher.deadline,deadline)
        results=[]
        for item in items:
            if deadline is not None and time.monotonic()>=deadline:break
            results.append(inspect(item,fetcher))
        return results
    with ThreadPoolExecutor(max_workers=4) as pool:
        return [result for group in pool.map(run,groups.values()) for result in group]
