"""Retain Python extraction semantics; runtime receives facts, not guesses."""
from dataclasses import asdict, is_dataclass
from datetime import datetime, timedelta
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from filters import BELGRADE, parse_datetime, serbia_eligible
from job_metadata import job_language_facts, remote_fact
from salary_facts import salary_facts
from residence_permit import job_residence_permit_requirement
from addresses import job_address, maps_url
from location_links import job_map_url
from job_quality import quality_reason, explicit_requirements


def enrich_job(raw):
    job = asdict(raw) if is_dataclass(raw) else dict(raw)
    published = parse_datetime(job.get('published_at'))
    expires = parse_datetime(job.get('expires_at'))
    if expires and (len(str(job.get('expires_at'))) == 10 or job.get('expires_date_only')):
        expires = datetime.combine(expires.astimezone(BELGRADE).date() + timedelta(days=1), datetime.min.time(), BELGRADE)
    languages, required = job_language_facts(job)
    text = '\n'.join(str(job.get(key) or '') for key in ('title', 'description'))
    remote = job.get('remote')
    if type(remote) is not bool:
        remote = remote_fact(text)
    reason = 'closed' if job.get('_withdrawn_at') else quality_reason(text)
    job['_cloud'] = {
        'version': 1, 'languages': languages, 'required_languages': required,
        'remote': remote, 'salary': salary_facts(job),
        'permit': job_residence_permit_requirement(job), 'serbia': serbia_eligible(job),
        'published_ms': int(published.timestamp()*1000) if published else None,
        'published_day': (published.astimezone(BELGRADE).date()-datetime(1970, 1, 1).date()).days if published else None,
        'date_only': bool(job.get('publication_date_only') or len(str(job.get('published_at'))) == 10),
        'date_label': published.astimezone(BELGRADE).strftime('%d.%m.%Y') if published else None,
        'expires_ms': int(expires.timestamp()*1000) if expires else None,
        'address': job_address(job), 'map_url': maps_url(job), 'location_url': job_map_url(job),
        'quality': {'version': 1, 'reason': reason},
        **explicit_requirements(text),
    }
    return job
