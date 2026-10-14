"""Conservative matching; publication calendar dates use Europe/Belgrade."""
from datetime import datetime, timedelta, timezone
import re
import unicodedata
from zoneinfo import ZoneInfo

BELGRADE = ZoneInfo('Europe/Belgrade')
CITY_NAMES = {
    'belgrade': ('beograd', 'belgrade', 'белград', 'београд'),
    'novi_sad': ('novi sad', 'novi-sad', 'нови сад', 'нови-сад'),
    'nis': ('nis', 'ниш'), 'subotica': ('subotica', 'суботица'),
    'kragujevac': ('kragujevac', 'крагуевац', 'крагујевац'),
}
CITY_LABELS = {'any': 'Вся Сербия', 'belgrade': 'Белград', 'novi_sad': 'Нови-Сад',
               'nis': 'Ниш', 'subotica': 'Суботица', 'kragujevac': 'Крагуевац'}
FRESHNESS_LABELS = {'today': '📅 Сегодня', 'yesterday': '⏮ Вчера', '7': '🗓 За 7 дней',
                    '30': '📆 За 30 дней', 'any': '🌍 Не важно'}
LANGUAGE_LABELS = {'russian': '🇷🇺 Русский', 'serbian': '🇷🇸 Сербский',
                   'english': '🇬🇧 Английский', 'any': '🌍 Не важно'}
REMOTE_LABELS = {'any': 'Любой формат', 'only': 'Удалённо', 'office': 'На месте / гибрид'}
FILTER_OPTIONS = {'city': CITY_LABELS, 'remote': REMOTE_LABELS,
                  'language': LANGUAGE_LABELS, 'freshness': FRESHNESS_LABELS}


def selected_values(settings, field):
    """Read both legacy scalar selections and new multiple selections."""
    value = settings.get(field, 'any')
    values = [value] if isinstance(value, str) else value if isinstance(value, list) else []
    values = list(dict.fromkeys(item for item in values if isinstance(item, str) and item))
    return ['any'] if not values or 'any' in values else values


def select_value(settings, field, value, enabled):
    """Explicit add/remove makes retries and stale button double-taps harmless."""
    if field not in FILTER_OPTIONS or value not in FILTER_OPTIONS[field]:
        raise ValueError('Unknown filter option')
    if value == 'any':
        return ['any']
    current = [v for v in selected_values(settings, field)
               if v != 'any' and v in FILTER_OPTIONS[field]]
    selected = set(current)
    if enabled:
        selected.add(value)
    else:
        selected.discard(value)
    return [v for v in FILTER_OPTIONS[field] if v in selected] or ['any']


def hidden_job_ids(settings):
    values = settings.get('hidden_jobs') or []
    return {value for value in values if type(value) is int and value > 0}


def normalize(text):
    text = unicodedata.normalize('NFKD', str(text).casefold().replace('đ', 'dj'))
    return ' '.join(''.join(c for c in text if not unicodedata.combining(c)).split())


def contains(text, term):
    return bool(re.search(r'(?<!\w)' + re.escape(normalize(term)) + r'(?!\w)', normalize(text)))


def parse_datetime(value):
    if not value:
        return None
    try:
        result = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return result.replace(tzinfo=BELGRADE) if result.tzinfo is None else result
    except (ValueError, TypeError):
        return None


def active(job, now=None):
    now = now or datetime.now(timezone.utc)
    value = job.get('expires_at')
    expiry = parse_datetime(value)
    if expiry and (len(str(value)) == 10 or job.get('expires_date_only')):
        expiry = datetime.combine(expiry.astimezone(BELGRADE).date() + timedelta(days=1), datetime.min.time(), BELGRADE)
    return not expiry or expiry > now


def freshness_matches(job, period, now):
    published = parse_datetime(job.get('published_at'))
    if not published:
        return period == 'any'
    today = now.astimezone(BELGRADE).date()
    day = published.astimezone(BELGRADE).date()
    if day > today or (not job.get('publication_date_only') and len(str(job.get('published_at'))) > 10 and published > now):
        return False
    age = (today - day).days
    if period == 'any': return True
    return {'today': age == 0, 'yesterday': age == 1, '7': 0 <= age < 7,
            '30': 0 <= age < 30}.get(period, False)


def serbia_eligible(job):
    country = normalize(job.get('country') or '')
    if country and country not in {'rs', 'srb', 'serbia', 'srbija', 'србија', 'сербия'}:
        return False
    countries = job.get('eligible_countries') or []
    return not countries or any(normalize(c) in {'rs', 'srb', 'serbia', 'srbija', 'србија', 'сербия',
                                                 'worldwide', 'anywhere', 'global', 'europe', 'европа'}
                                for c in countries)


def matches(job, settings, now=None):
    now = now or datetime.now(timezone.utc)
    if job.get('id') in hidden_job_ids(settings): return False
    if not active(job, now) or not serbia_eligible(job): return False
    if not any(freshness_matches(job, period, now) for period in selected_values(settings, 'freshness')): return False
    text = normalize(' '.join(str(job.get(k) or '') for k in ('title', 'description')))
    if settings.get('keywords') and not any(contains(text, x) for x in settings['keywords']): return False
    if any(contains(text, x) for x in settings.get('exclusions', [])): return False
    cities = selected_values(settings, 'city')
    if 'any' not in cities and not any(contains(job.get('location') or '', x)
                                      for city in cities for x in CITY_NAMES.get(city, (city,))): return False
    remote = selected_values(settings, 'remote')
    if 'any' not in remote and not (('only' in remote and job.get('remote') is True)
                                   or ('office' in remote and job.get('remote') is False)): return False
    selected_languages = selected_values(settings, 'language')
    languages = job.get('languages')
    english = 'en' in (languages or [])
    if 'english' in selected_languages and not english:
        # Read older cached descriptions too; metadata extraction uses normalize above.
        from job_metadata import job_language_facts
        english = 'en' in job_language_facts(job)[0]
    language_matches = {
        'any': True,
        'russian': 'ru' in (languages or []) or (languages is None and job.get('russian') is True),
        'serbian': 'sr' in (languages or []) or (languages is None and job.get('serbian_required') is True),
        'english': english,
        'no_serbian': job.get('serbian_required') is False,
    }
    if not any(language_matches.get(value, False) for value in selected_languages): return False
    salary = job.get('salary_min')
    if salary is None and not settings.get('include_unknown_salary', True): return False
    minimum = settings.get('min_salary')
    if minimum is not None:
        currency = job.get('salary_currency')
        if salary is None or currency is None: return bool(settings.get('include_unknown_salary', True))
        if job.get('salary_period', 'month') != 'month' or currency != settings.get('currency', 'EUR') or salary < minimum: return False
    return True


def search_diagnostics(jobs, settings, now=None):
    """Explain an empty search without changing the user's chosen conditions.

    Jobs supplied by the caller must already have usable links or contacts.
    Hidden, expired and ineligible jobs stay excluded from suggestions.
    """
    now = now or datetime.now(timezone.utc)
    resets = {
        'freshness': {'freshness': 'any'},
        'language': {'language': 'any'},
        'remote': {'remote': 'any'},
        'city': {'city': 'any'},
        'keywords': {'keywords': []},
        'exclusions': {'exclusions': []},
        'salary': {'min_salary': None, 'include_unknown_salary': True},
    }
    unfiltered = dict(settings)
    for changes in resets.values():
        unfiltered.update(changes)
    available = [job for job in jobs if matches(job, unfiltered, now)]
    relaxed = []
    for field, changes in resets.items():
        if field in FILTER_OPTIONS:
            enabled = selected_values(settings, field) != ['any']
        elif field == 'salary':
            enabled = settings.get('min_salary') is not None or not settings.get('include_unknown_salary', True)
        else:
            enabled = bool(settings.get(field))
        if not enabled:
            continue
        count = sum(matches(job, dict(settings, **changes), now) for job in available)
        if count:
            relaxed.append({'field': field, 'count': count})
    return {'available': len(available), 'relaxed': sorted(relaxed, key=lambda item: item['count'])}
