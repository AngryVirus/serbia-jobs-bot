"""Extract only explicit job facts; never infer eligibility from page language."""
import re
from urllib.parse import urlsplit
from filters import normalize

LANGUAGE_NAMES = {'ru': ('russian', 'ruski', 'русск', 'руск'), 'sr': ('serbian', 'srpsk', 'сербск', 'српск'),
                  'en': ('english', 'englesk', 'английск', 'енглеск'),
                  'de': ('german', 'nemack', 'немецк', 'немачк')}
_LANGUAGE_WORD = re.compile(r'\b(?:' + '|'.join(re.escape(normalize(root)) for roots in LANGUAGE_NAMES.values() for root in roots) + r')\w*')
_LANGUAGE_POSITIVE = re.compile(r'requir|mandatory|must|fluency|fluent|knowledge|proficien|welcome|speak|native|conversational|work(?:ing)? (?:in|language)|znanje|poznavanje|obavez|знањ|познавањ|обавез|знани|владени|треб|обязател|говорящ|разговорн|грамотн|родно|приветств|рабоч\w* язык|работ.{0,20} на')
_LANGUAGE_NEGATIVE = re.compile(r'not (?:required|mandatory|necessary|needed)|no .{0,25} (?:required|necessary|needed)|не (?:нуж\w*|требу\w*|обязател\w*)|необязател|bez znanja|без знања|без знани\w*|nije (?:potreb|obavez)|није (?:потреб|обавез)')
_LANGUAGE_OPTIONAL = re.compile(r'optional|preferred|nice to have|желател|преимуществ|pozeljn|prednost|пожељн|предност')
_LANGUAGE_REQUIRED = re.compile(r'requir|mandatory|must|obavez|обавез|треб|обязател|(?:не ниже|не менее|at least|minimum)\s+(?:(?:уровн\w*|level)\s+)?[aаbвcс][12](?!\w)')
_LANGUAGE_LEVEL = re.compile(r'\b[aаbвcс][12](?:\+)?\b|\b(?:upper[- ]intermediate|intermediate|advanced|beginner)\b')
_LANGUAGE_HEADER = re.compile(r'^[^\w]*(?:languages?|языки?|jezici|jezik|језици|језик)\s*[:—–-]\s*')
_LANGUAGE_BACKGROUND = re.compile(r'^\s*(?:[- ]speaking\s+)?(?:[aаbвcс][12]\+?\s+)?(?:compan\w*|citizenship|passport|market|textbooks?|компани\w*|гражданств\w*|паспорт\w*|рын\w*|учебник\w*|kompanij\w*|drzavljan\w*|држављан\w*)\b')


def _language_cue(value):
    return (_LANGUAGE_POSITIVE.search(value) or _LANGUAGE_NEGATIVE.search(value)
            or _LANGUAGE_OPTIONAL.search(value) or _LANGUAGE_LEVEL.search(value))


def _language_clauses(text):
    """Keep shared language lists, but separate independent requirements."""
    for raw in re.split(r'[\n.!?;]|\b(?:but|however|whereas|но|однако|а|ali|dok)\b', text, flags=re.I):
        raw = normalize(raw)
        header = _LANGUAGE_HEADER.match(raw)
        if header:
            raw = raw[header.end():]
        pending = ''
        for item in raw.split(','):
            item = normalize(item)
            # "Russian, English required" is one list; "Russian company,
            # English required" must not invent Russian as a job language.
            remainder = _LANGUAGE_WORD.sub('', item)
            remainder = re.sub(r'\b(?:languages?|язык\w*|jezik\w*|језик\w*|and|or|и|или|i)\b|[\s:/&-]', '', remainder)
            if _LANGUAGE_WORD.search(item) and not remainder:
                if header:
                    yield 'languages: ' + item
                    continue
                pending += item + ' '
                continue
            item = pending + item
            pending = ''
            start = 0
            for conjunction in re.finditer(r'\b(?:and|и|i)\b', item):
                left, right = item[start:conjunction.start()], item[conjunction.end():]
                if _language_cue(left) and _language_cue(right):
                    yield left
                    start = conjunction.end()
            yield ('languages: ' if header else '') + item[start:]


def language_facts(text):
    accepted, required = [], []
    clauses = list(_language_clauses(text))
    for code, roots in LANGUAGE_NAMES.items():
        for clause in clauses:
            mentions = [match for root in roots for match in re.finditer(r'\b' + re.escape(normalize(root)) + r'\w*', clause)]
            if not any(not _LANGUAGE_BACKGROUND.match(clause[match.end():]) for match in mentions): continue
            if _LANGUAGE_NEGATIVE.search(clause): continue
            if (_LANGUAGE_POSITIVE.search(clause) or _LANGUAGE_OPTIONAL.search(clause) or _LANGUAGE_LEVEL.search(clause) or _LANGUAGE_HEADER.match(clause)) and not re.search(r'datasets?|corpora|training data|учебн.{0,15}данн|обучающ.{0,15}данн',clause):
                if code not in accepted: accepted.append(code)
                if _LANGUAGE_REQUIRED.search(clause) and not _LANGUAGE_OPTIONAL.search(clause) and code not in required: required.append(code)
    return accepted, required


def job_language_facts(job):
    """Keep explicit metadata and recover every language from older descriptions."""
    languages = job.get('languages')
    if languages is None:
        languages = (['ru'] if job.get('russian') is True else []) + (['sr'] if job.get('serbian_required') is True else [])
    languages = list(languages)
    required = list(job.get('required_languages') or [])
    extracted, mandatory = language_facts('\n'.join(str(job.get(key) or '') for key in ('title', 'description')))
    for code in extracted:
        if code not in languages:
            languages.append(code)
    for code in mandatory:
        if code not in required:
            required.append(code)
    return languages, required


def remote_fact(text):
    raw = text
    text = normalize(text)
    if re.search(r'not remote|non[- ]remote|no remote(?: work)?|remote work (?:is )?not|on[- ]site only|nije remote|без удал|удален\w*\s+работ\w*\s+нет|\bnije rad od kuce\b|\brad od kuce (?:nije|ne)\b|\bније рад од куће\b|\bрад од куће (?:није|не)\b|work from home (?:is )?not|(?:формат(?: работы)?\s*[:—–-]\s*)не удален',text): return False
    if re.search(r'\bhybrid\b|\bhibrid\w*|гибрид|хибрид',text): return False
    if re.search(r'\bremote (?:work|job|role|position|opportunity|working)|\b(?:fully|100%|work) remote\b|rad od kuce|рад од куће|work from home|удален\w* (?:работ|ваканс|формат)|работ\w* удаленно|(?:формат(?: работы)?|format|nacin rada|начин рада)\s*[:—–-]\s*(?:remote|удален\w*)',text): return True
    if text.strip() == 'remote' or re.search(r'(?im)^\s*(?:remote|удаленно|rad od kuće)\s*$', raw): return True
    if re.search(r'on[- ]site|in[- ]office|office based|работ\w* в офис|rad iz kancelarije',text): return False
    return None


def text_salary(text):
    from salary_facts import salary_text
    # Callers may supply a dedicated salary line or a full job description.
    # A monetary line alone is valid; unrelated amounts in prose require an
    # explicit salary label and must not describe accommodation or other costs.
    facts, _ = salary_text(text, allow_bare=True)
    if not facts or not facts['period']:
        return None, None, None
    return facts['min'] if facts['period'] == 'month' else None, facts['currency'], facts['period']


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
    from salary_facts import salary_facts, salary_text
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
        if amount is not None or maximum is not None:
            job.salary_source = 'structured'
    raw = {key: getattr(job, key, None) for key in ('salary_min', 'salary_currency', 'salary_period', 'salary_display', 'salary_source', 'description')}
    # A source minimum without its own unit keeps the historical monthly
    # contract; a text excerpt never receives an assumed pay period.
    if raw['salary_min'] is not None and raw['salary_period'] is None and not raw['salary_display']:
        raw['salary_period'] = 'month'
    facts = salary_facts(raw)
    if facts['known']:
        job.salary_min = facts['min'] if facts['period'] == 'month' else None
        job.salary_currency, job.salary_period = facts['currency'], facts['period']
        _, label = salary_text(job.description, allow_bare=True)
        display_facts = salary_facts({**raw, 'description': ''})
        if label and (not job.salary_display or job.salary_source != 'structured' and display_facts != facts):
            job.salary_display = label[:150]
    else:
        job.salary_min = job.salary_currency = job.salary_period = None
        # Keep non-numeric source wording such as "negotiable", but clear a
        # stale monetary excerpt that was actually a rent, fee or insurance.
        if job.salary_display and re.search(r'\d', job.salary_display):
            job.salary_display = None
    return job
