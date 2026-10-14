"""Extract only explicit job facts; never infer eligibility from page language."""
import re
from urllib.parse import urlsplit
from filters import normalize

LANGUAGE_NAMES = {'ru': ('russian', 'ruski', 'русск'), 'sr': ('serbian', 'srpsk', 'сербск'),
                  'en': ('english', 'englesk', 'английск'), 'de': ('german', 'nemack', 'немецк')}


def language_facts(text):
    accepted, required = [], []
    sentences = [normalize(part) for part in re.split(r'[\n.!?;]', text)]
    for code, roots in LANGUAGE_NAMES.items():
        for sentence in sentences:
            if not any(re.search(r'\b' + re.escape(normalize(root)) + r'\w*', sentence) for root in roots): continue
            if re.search(r'not required|no .{0,25} required|не (?:нужен|требуется|обязател)|bez znanja', sentence): continue
            if re.search(r'requir|mandatory|fluency|fluent|knowledge|proficien|welcome|speak|work(?:ing)? (?:in|language)|znanje|poznavanje|obavez|знани|владени|треб|говорящ|приветств|работ.{0,20} на', sentence) and not re.search(r'datasets?|corpora|training data|учебн.{0,15}данн|обучающ.{0,15}данн',sentence):
                if code not in accepted: accepted.append(code)
                if re.search(r'requir|mandatory|must|obavez|треб|обязател', sentence) and code not in required: required.append(code)
    return accepted, required


def job_language_facts(job):
    """Keep explicit metadata and recover English missed by older collectors."""
    languages = job.get('languages')
    if languages is None:
        languages = (['ru'] if job.get('russian') is True else []) + (['sr'] if job.get('serbian_required') is True else [])
    languages = list(languages)
    required = list(job.get('required_languages') or [])
    if 'en' not in languages:
        extracted, mandatory = language_facts('\n'.join(str(job.get(key) or '') for key in ('title', 'description')))
        if 'en' in extracted:
            languages.append('en')
            if 'en' in mandatory and 'en' not in required:
                required.append('en')
    return languages, required


def remote_fact(text):
    raw = text
    text = normalize(text)
    if re.search(r'not remote|non[- ]remote|no remote(?: work)?|remote work (?:is )?not|on[- ]site only|nije remote|без удал|удален\w*\s+работ\w*\s+нет|nije rad od kuce',text): return False
    if re.search(r'\bhybrid\b|\bhibrid\w*|гибрид',text): return False
    if re.search(r'\bremote (?:work|job|role|position|opportunity|working)|\b(?:fully|100%|work) remote\b|rad od kuce|work from home|удален\w* (?:работ|ваканс|формат)|работ\w* удаленно',text): return True
    if text.strip() == 'remote' or re.search(r'(?im)^\s*(?:remote|удаленно|rad od kuće)\s*$', raw): return True
    if re.search(r'on[- ]site|in[- ]office|office based|работ\w* в офис|rad iz kancelarije',text): return False
    return None


def text_salary(text):
    from sources import parse_money_amount
    # A stated maximum is never treated as a guaranteed minimum.
    pattern=r'(?:(up to|do|до)\s+)?([\d][\d \t.,]*)\s*(?:[-–]\s*[\d \t.,]+\s*)?(EUR|RSD|USD)\s*(?:/\s*(month|hour|year|месяц|час|год|mesec|mesecu|sat|satu|godina)|\b(mesecno|mesečno|monthly|hourly|annually)|(в месяц|в час|в год|мес\.))'
    match=re.search(pattern,text,re.I)
    if not match: return None,None,None
    period=(match[4] or match[5] or match[6] or '').casefold()
    period='month' if period in {'month','месяц','mesec','mesecu','mesecno','mesečno','monthly','в месяц','мес.'} else 'hour' if period in {'hour','час','sat','satu','hourly','в час'} else 'year'
    amount=None if match[1] or period!='month' else parse_money_amount(match[2].strip())
    return amount,match[3].upper(),period


def valid_job_url(url):
    if not isinstance(url,str) or len(url)>2048: return False
    try:
        parsed=urlsplit(url)
        return parsed.scheme in {'https','http'} and bool(parsed.hostname) and not parsed.username and not parsed.password and parsed.path not in {'','/'} and not any(c in url for c in '\r\n\x00')
    except ValueError: return False


def contacts_from_text(text):
    values=[]
    for pattern in (r'(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b',r'(?i)https://t\.me/[A-Za-z][A-Za-z0-9_]{4,31}',r'(?<!\w)\+\d[\d ()-]{7,20}\d'):
        for match in re.finditer(pattern,text):
            value=match.group(0)
            if value not in values: values.append(value)
    return values[:5]


def country_values(value):
    if isinstance(value,list):
        return [country for item in value for country in country_values(item)]
    if isinstance(value,str): return [value]
    if not isinstance(value,dict): return []
    if 'address' in value:
        # A free-form address (e.g. "Beograd") is not an addressCountry.
        address = value['address']
        if isinstance(address, list):
            address = [item for item in address if isinstance(item, dict)]
        return country_values(address) if isinstance(address, (dict, list)) else []
    if 'addressCountry' in value: return country_values(value['addressCountry'])
    if value.get('@type') in {'Country','AdministrativeArea'}: return country_values(value.get('name'))
    return []


def enrich(job, node=None):
    node=node or {}
    job.publication_date_only = bool(job.published_at and len(job.published_at)==10)
    job.expires_date_only = bool(job.expires_at and len(job.expires_at)==10)
    text=job.title+'\n'+job.description
    job.languages,job.required_languages=language_facts(text)
    job.russian=True if 'ru' in job.languages else None
    if 'sr' in job.required_languages: job.serbian_required=True
    job.contacts=contacts_from_text(job.description)
    countries=country_values(node.get('jobLocation'))
    if countries:
        job.country='RS' if any(normalize(c) in {'rs','srb','serbia','srbija','србија','сербия'} for c in countries) else countries[0]
    job.eligible_countries=country_values(node.get('applicantLocationRequirements'))
    if not job.country:
        # Explicit foreign job locations are rejected; city absence stays unknown.
        foreign=r'\b(?:russia|россия|russian federation|montenegro|crna gora|черногория|croatia|hrvatska|хорватия|moscow|москва|moskva|london|лондон|berlin|берлин|germany|немачка|германия|bosnia|bosna|босния|hungary|мадјарска|венгрия|bulgaria|бугарска|болгария)\b'
        found=re.search(foreign,normalize(job.location))
        if found: job.country=found.group(0)
    restriction=re.search(r'(?:remote|work from home).{0,45}(?:only (?:in|from)|must be (?:based|located) in|residents of)\s+([A-Za-z ]{2,40})',text,re.I)
    if restriction and not job.eligible_countries: job.eligible_countries=[restriction[1].strip().rstrip('.')]
    amount,currency,period=text_salary(job.description)
    if period:
        job.salary_min,job.salary_currency,job.salary_period=amount,currency,period
    else:
        job.salary_period='month' if job.salary_min is not None else None
    salary = node.get('baseSalary')
    if isinstance(salary,dict) and isinstance(salary.get('value'),dict):
        value=salary['value']; unit=str(value.get('unitText','')).casefold()
        amount=value.get('minValue',value.get('value'))
        maximum=value.get('maxValue')
        period={'month':'месяц','monthly':'месяц','hour':'час','year':'год','day':'день'}.get(unit,unit)
        if amount is not None:
            job.salary_display=str(amount)+(('–'+str(maximum)) if maximum is not None else '')+' '+str(salary.get('currency',''))+' / '+period
        elif maximum is not None:
            job.salary_display='до '+str(maximum)+' '+str(salary.get('currency',''))+' / '+period
    if not job.salary_display:
        label=re.search(r'(?i)(?:(?:up to|do|до|от|from)\s+)?\d[\d \t.,]*(?:[-–]\s*\d[\d \t.,]*)?\s*(?:EUR|RSD|USD)\s*(?:/\s*(?:month|hour|year|day)|mesecno|mesečno|monthly|hourly|annually|в месяц|в час|в год|мес\.)',job.description)
        if label: job.salary_display=label[0].strip()[:150]
    return job
