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
LANGUAGE_LABELS = {'russian': '🇷🇺 Русский', 'serbian': '🇷🇸 Сербский', 'any': '🌍 Не важно'}


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
    if not active(job, now) or not serbia_eligible(job): return False
    if not freshness_matches(job, settings.get('freshness', 'any'), now): return False
    text = normalize(' '.join(str(job.get(k) or '') for k in ('title', 'description')))
    if settings.get('keywords') and not any(contains(text, x) for x in settings['keywords']): return False
    if any(contains(text, x) for x in settings.get('exclusions', [])): return False
    city = settings.get('city', 'any')
    if city != 'any' and not any(contains(job.get('location') or '', x) for x in CITY_NAMES.get(city, (city,))): return False
    remote = settings.get('remote', 'any')
    if remote == 'only' and job.get('remote') is not True: return False
    if remote == 'office' and job.get('remote') is not False: return False
    language = settings.get('language', 'any')
    languages = job.get('languages')
    if language == 'russian' and not ('ru' in (languages or []) or (languages is None and job.get('russian') is True)): return False
    if language == 'serbian' and not ('sr' in (languages or []) or (languages is None and job.get('serbian_required') is True)): return False
    if language == 'no_serbian' and job.get('serbian_required') is not False: return False
    salary = job.get('salary_min')
    if salary is None and not settings.get('include_unknown_salary', True): return False
    minimum = settings.get('min_salary')
    if minimum is not None:
        currency = job.get('salary_currency')
        if salary is None or currency is None: return bool(settings.get('include_unknown_salary', True))
        if job.get('salary_period', 'month') != 'month' or currency != settings.get('currency', 'EUR') or salary < minimum: return False
    return True
