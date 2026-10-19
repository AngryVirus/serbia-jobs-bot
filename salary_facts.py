"""Explicit public salary facts, kept separate from a monthly minimum.

No exchange rates or assumed working hours are used. A stated ceiling is not
a guaranteed minimum; numbers for fees and benefits are not salary evidence.
"""
import math
import re
import unicodedata


_CURRENCIES = r'EUR|RSD|USD|GBP|CHF|RUB|CAD|AUD|HUF|BAM|RON|BGN|€'
_AMOUNT = r'\d(?:[\d., \u00a0\u202f]{0,25}\d)?'
_MONEY = re.compile(
    rf'(?<![\w\d+−-])(?:(?P<prefix>up\s+to|starting\s+at|maximum(?:\s+of)?|minimum(?:\s+of)?|max|min|from|до|от|do|od|najmanje|najvise)\s+)'
    rf'?(?:(?P<before>{_CURRENCIES})\s*)?(?P<first>{_AMOUNT})'
    rf'(?:\s*(?:[-–—]|to|до|do)\s*(?P<second>{_AMOUNT}))?'
    rf'\s*(?P<after>{_CURRENCIES})?(?!\w)', re.I)
_PERIOD = re.compile(
    r'^\s*(?:/|per\b|a\b|за\b|в\b)?\s*'
    r'(?P<period>months?|monthly|mesec(?:no|u)?|месяц\w*|мес\.?|месец\w*|месеч\w*|'
    r'hours?|hourly|satu?|час\w*|сат\w*|h\b|'
    r'years?|yearly|annually|godisnje|godin\w*|год\w*|'
    r'days?|daily|dnevno|dan|день|дня|дан)(?!\w)', re.I)
_SALARY = re.compile(r'\b(?:salar\w*|pay|compensation|wage\w*|plat\w*|zarad\w*|satnic\w*|'
                     r'зарплат\w*|заработн\w* плат\w*|оплат\w*|ставк\w*|плат\w*|зарад\w*|сатниц\w*)\b', re.I)
_COST = re.compile(
    r'\b(?:fees?|deposits?|commissions?|costs?|turnover|revenue|bonuses?|allowances?|benefits?|'
    r'accommodat\w*|housing|rent(?:al)?|insurance|tuition|training|courses?|'
    r'trosk\w*|trosak|stanarin\w*|smestaj\w*|kirij\w*|obuk\w*|osiguranj\w*|'
    r'depozit\w*|naknad\w*|clanarin\w*|provizi\w*|'
    r'стоимост\w*|расход\w*|взнос\w*|депозит\w*|залог\w*|комисси\w*|бонус\w*|оборот\w*|'
    r'проживани\w*|жиль\w*|аренд\w*|обучени\w*|курс\w*|страхов\w*|'
    r'трошк\w*|трошак|станарин\w*|смештај\w*|кириј\w*|обук\w*|осигурањ\w*|'
    r'накнад\w*|чланарин\w*|провизи\w*)\b', re.I)
_CEILING = {'up to', 'maximum', 'maximum of', 'max', 'до', 'do', 'najvise'}


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and 0 <= value <= 100_000_000 else None


def _amount(value):
    value = re.sub(r'\s', '', value)
    if ',' in value and '.' in value:
        decimal = ',' if value.rfind(',') > value.rfind('.') else '.'
        value = value.replace('.' if decimal == ',' else ',', '').replace(decimal, '.')
    elif ',' in value or '.' in value:
        separator = ',' if ',' in value else '.'
        parts = value.split(separator)
        if len(parts) > 1 and all(len(part) == 3 for part in parts[1:]):
            value = ''.join(parts)
        elif len(parts) == 2 and 1 <= len(parts[1]) <= 2:
            value = '.'.join(parts)
        else:
            return None
    try:
        return _number(float(value))
    except ValueError:
        return None


def _normalize(value, limit):
    text = unicodedata.normalize('NFKD', str(value or '')[:limit].casefold().replace('đ', 'dj'))
    return ''.join(char for char in text if not unicodedata.combining(char))


def _currency(value):
    value = str(value or '').upper()
    return value if re.fullmatch(r'[A-Z]{3}', value) else None


def _period(value):
    value = value.casefold()
    if value.startswith(('month', 'mesec', 'месяц', 'мес')):
        return 'month'
    if value == 'h' or value.startswith(('hour', 'sat', 'час', 'сат')):
        return 'hour'
    if value.startswith(('year', 'annual', 'god', 'год')):
        return 'year'
    return 'day'


def _candidates(text):
    previous = ''
    for clause in re.split(r'[\n;!?]|(?<!\d),(?!\d)|(?<=[a-zа-я])\.\s+', text):
        for match in _MONEY.finditer(clause[:1000]):
            currency = match['after'] or match['before']
            unit = _PERIOD.match(clause[match.end():])
            if not currency and not unit:
                continue
            first, second = _amount(match['first']), _amount(match['second']) if match['second'] else None
            if first is None:
                continue
            prefix = ' '.join((match['prefix'] or '').split())
            low, high = (None, first) if prefix in _CEILING else (first, second)
            if second is not None and second < first:
                low = high = None
            facts = {'known': True, 'min': low, 'max': high,
                     'currency': 'EUR' if currency == '€' else currency.upper() if currency else None,
                     'period': _period(unit['period']) if unit else None}
            end = match.end() + (unit.end() if unit else 0)
            before = previous[-120:] + '\n' + clause[max(0, match.start() - 120):match.start()]
            salary = list(_SALARY.finditer(before))
            costs = list(_COST.finditer(before))
            # The nearest label binds the amount: "salary ... rent 500" is
            # a rent amount, while "housing free; salary 1500" is salary.
            cost = bool(costs and (not salary or costs[-1].end() > salary[-1].end()))
            after = clause[end:]
            postfix = re.match(r'^\s*(?:for|за|za)\s+', after)
            if postfix:
                purpose = after[postfix.end():postfix.end() + 65]
                expense = _COST.search(purpose)
                if expense and len(purpose[:expense.start()].split()) <= 2:
                    cost = True
            label = clause[match.start():end].strip()
            bare = clause.strip().rstrip('.') == label.rstrip('.')
            yield facts, label, bool(salary), cost, bare
        if clause.strip():
            previous = clause


def _text_facts(text, *, display=False, allow_bare=False):
    for facts, label, salary, cost, bare_line in _candidates(text):
        if cost:
            continue
        # A monthly amount alone is also a possible rent, insurance premium or
        # fee. Full job descriptions require an explicit salary label. The
        # salary-only API can additionally accept an entire bare monetary line.
        bare = allow_bare and bare_line
        if display or salary or bare:
            return facts
    return None


def salary_text(text, *, allow_bare=False):
    """Parse labelled salary text, optionally a standalone monetary line."""
    normalized = _normalize(text, 20_000)
    for facts, label, salary, cost, bare_line in _candidates(normalized):
        bare = allow_bare and bare_line
        if not cost and (salary or bare):
            # Preserve the validated monetary excerpt, without unrelated costs.
            label = re.sub(r'\b(?:' + _CURRENCIES + r')\b', lambda m: m[0].upper(), label, flags=re.I)
            return facts, label
    return None, None


def _cached_cost_conflict(job, candidate, description):
    if job.get('salary_source') == 'structured' or not candidate['known']:
        return False
    parsed = _text_facts(description, allow_bare=True)
    if parsed and all(candidate[key] == parsed[key] for key in ('min', 'max', 'currency', 'period')):
        return False
    # Older collectors promoted an unlabelled expense into salary_min/display.
    # Retract only an identical monetary range/unit/currency in a cost context;
    # other expenses do not invalidate genuine source-provided salary metadata.
    for expense, _, _, cost, _ in _candidates(description):
        if not cost:
            continue
        if candidate['currency'] is None or candidate['currency'] != expense['currency']:
            continue
        if candidate['period'] is None or candidate['period'] != expense['period']:
            continue
        if (candidate['min'], candidate['max']) == (expense['min'], expense['max']):
            return True
    return False


def salary_facts(job):
    """Return validated facts without treating an upper bound as a minimum."""
    low = _number(job.get('salary_min'))
    high = _number(job.get('salary_max'))
    period = job.get('salary_period', 'month' if low is not None else None)
    period = period if period in {'month', 'hour', 'year', 'day'} else None
    currency = _currency(job.get('salary_currency'))
    result = {'known': low is not None or high is not None, 'min': low, 'max': high,
              'currency': currency, 'period': period}
    description = _normalize(job.get('description'), 20_000)
    display = _text_facts(_normalize(job.get('salary_display'), 300), display=True)
    if display:
        # Explicit display wording takes priority over collectors that treated
        # "up to" as a minimum. Missing units can use explicit source metadata.
        result = {**display, 'period': display['period'] or period,
                  'currency': display['currency'] or currency}
        if _cached_cost_conflict(job, result, description):
            return _text_facts(description, allow_bare=True) or {'known': False, 'min': None, 'max': None, 'currency': None, 'period': None}
        return result
    if result['known']:
        if _cached_cost_conflict(job, result, description):
            return _text_facts(description, allow_bare=True) or {'known': False, 'min': None, 'max': None, 'currency': None, 'period': None}
        parsed = _text_facts(description, allow_bare=True)
        # Historical feed parsing promoted "up to N" to a guaranteed N.
        # Preserve the explicit ceiling from the matching monetary statement.
        if (job.get('salary_source') != 'structured' and parsed and parsed['min'] is None
                and parsed['max'] == result['min'] and parsed['currency'] == result['currency']
                and parsed['period'] == result['period']):
            return parsed
        if low is not None and high is not None and high < low:
            result['min'] = result['max'] = None
        return result
    parsed = _text_facts(description, allow_bare=True)
    if parsed:
        return {**parsed, 'period': parsed['period'] or period}
    return result


def salary_matches(facts, settings):
    """Apply an explicit monthly threshold and the existing unknown toggle."""
    unknown = settings.get('include_unknown_salary', True) is not False
    if not facts['known']:
        return unknown
    minimum = settings.get('min_salary')
    if minimum is None:
        return True
    if facts['period'] != 'month':
        return False
    if facts['currency'] is None:
        return unknown
    if facts['currency'] != settings.get('currency', 'EUR'):
        return False
    if facts['max'] is not None and facts['max'] < minimum:
        return False
    return facts['min'] >= minimum if facts['min'] is not None else unknown
