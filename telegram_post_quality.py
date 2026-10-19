"""Admission checks for Telegram posts, separate from derived vacancy facts."""
import re

from filters import normalize


def post_exclusion(text):
    # NFKD turns this decorative information symbol into the letter "i".
    text = text.replace('ℹ', '')
    lines = [normalize(line) for line in text.splitlines() if line.strip()]
    opening = ' '.join(lines[:2])[:350]
    if re.search(r'^[^\w]*(?:интервью\b|interview\s+(?:with|about)\b)', opening):
        return 'editorial'
    if (lines and re.match(r'^[^\w]*(?:вакансии|vacancies|job\s+(?:digest|roundup))\b', lines[0])
            and len(re.findall(r'\b(?:ссылка|link)\b', normalize(text))) >= 2):
        return 'digest'
    return None


def without_editorial_posts(jobs, status):
    kept = []
    rejected = dict(status.get('rejected', {}))
    for job in jobs:
        reason = post_exclusion(job.description or '')
        if reason:
            rejected[reason] = rejected.get(reason, 0) + 1
        else:
            kept.append(job)
    removed = len(jobs) - len(kept)
    if not removed:
        return jobs, status
    result = {**status, 'count': len(kept), 'rejected': rejected,
              'parsed_count': max(0, status.get('parsed_count', len(jobs)) - removed)}
    if not kept and result['state'] == 'ok':
        result['state'] = 'empty'
    return kept, result
