"""Conservative, local extraction of an employer's residence-permit requirement.

True/False require explicit wording; silence, assistance and conflicting facts
stay unknown. Work permits, citizenship and ordinary stays are separate facts.
The bounded cache contains only public text, never users' settings or results.
"""
from functools import lru_cache
import re

from filters import normalize


_MENTION = re.compile(r'внж|жительств|residen(?:ce|cy)|borav|борав', re.I)
_PERMIT = re.compile(
    r'\b(?:внж|вид(?:а|ом|у|е)? на жительство|'
    r'(?:temporary |permanent )?residen(?:ce|cy) permit|'
    r'dozvol\w* za (?:privremeni |stalni )?boravak|'
    r'(?:privremeni|stalni) boravak|'
    r'дозвол\w* за (?:привремени |стални )?боравак|'
    r'(?:привремени|стални) боравак)\b')
_P = r'(?:деиствующ\w* |valid |a |an )*PERMIT'
_S = r'\s*(?:[:—–-]\s*)?'
_ALSO_WORK = (r'(?: и разрешени\w* на работу| and (?:a )?work permit|'
              r' i radn\w* dozvol\w*| и радн\w* дозвол\w*)?')
_REQUIRED = r'(?:обязател\w*|необходим\w*|нужен|требуется)'
_NO = r'(?:не (?:обязател\w*|необходим\w*|нужен|требуется)|необязател\w*)'


def _rules(*patterns):
    return [re.compile(pattern) for pattern in patterns]


_NEGATIVE = _rules(
    rf'\b{_P}{_ALSO_WORK}{_S}{_NO}\b',
    rf'\b{_NO} (?:наличие )?{_P}\b',
    rf'\b{_P}{_S}нет\b',
    rf'\b{_P}{_S}(?:is )?(?:not required|not necessary|not mandatory|optional)\b',
    rf'\bno {_P} (?:is )?(?:required|needed|necessary)\b',
    rf'\b{_P}{_S}(?:nije (?:potreb\w*|obavez\w*)|није (?:потреб\w*|обавез\w*))\b',
    rf'\b(?:nije (?:potreb\w*|obavez\w*)|није (?:потреб\w*|обавез\w*)) {_P}\b',
    rf'\b(?:можно|принимаем|рассматриваем|берем)(?: кандидатов| на работу| работать)? без (?:наличия )?{_P}\b',
    rf'\bработа без {_P}\b',
    rf'\b(?:со? PERMIT и без(?: него| PERMIT)?|with or without {_P})\b',
    rf'^(?:[-•]\s*)?(?:без|bez) {_P}$',
    rf'\b(?:accept|welcome) (?:candidates|applicants) without {_P}\b',
    rf'\b(?:moze|primamo|prihvatamo|може|примамо|прихватамо)(?: kandidate| rad| кандидате| рад)? (?:bez|без) {_P}\b',
)
_POSITIVE = _rules(
    rf'\bне (?:принимаем|рассматриваем|берем)(?: кандидатов| на работу)? без {_P}\b',
    rf'\bбез {_P} не (?:принимаем|рассматриваем|берем)\b',
    rf'\b(?:do not|don\x27t) accept (?:candidates|applicants) without {_P}\b',
    rf'\b{_REQUIRED} (?:наличие )?{_P}\b',
    rf'\b{_P}{_ALSO_WORK}{_S}{_REQUIRED}\b',
    rf'\b(?:только с|обязательное наличие) {_P}\b',
    rf'^(?:[-•]\s*)?(?:(?:требования|условия|кандидатам)\s*:\s*)?наличие {_P}\b',
    rf'\b{_P}{_S}да\b',
    rf'\b{_P}{_ALSO_WORK}{_S}(?:(?:is|are) )?(?:required|mandatory|necessary|essential)\b',
    rf'\b(?:require|must have|must hold|need to have) {_P}\b',
    rf'\b{_P}{_ALSO_WORK}{_S}(?:je )?(?:potreb\w*|obavez\w*|neophod\w*)\b',
    rf'\b(?:potreb\w*|obavez\w*|neophod\w*)(?: je)? {_P}\b',
    rf'\b{_P}{_ALSO_WORK}{_S}(?:је )?(?:потреб\w*|обавез\w*|неопход\w*)\b',
    rf'\b(?:потреб\w*|обавез\w*|неопход\w*)(?: је)? {_P}\b',
)
_SOFT = re.compile(
    r'желател\w*|преимуществ\w*|приветств\w*|preferred|advantage|nice to have|'
    r'pozeljn\w*|prednost|пожељн\w*|предност')


@lru_cache(maxsize=1024)
def residence_permit_requirement(text):
    if not _MENTION.search(text):
        return None
    facts = set()
    for raw in re.split(r'[\n.!?;]', text):
        clause = _PERMIT.sub('PERMIT', normalize(raw))
        clause = re.sub(r'\b(?:оформлени\w*|получени\w*|продлени\w*|processing|renewal|issuance) '
                        + _P, 'DOCUMENT_PROCESS', clause)
        clause = re.sub(_P + r' (?:processing|renewal|issuance)\b', 'DOCUMENT_PROCESS', clause)
        if 'PERMIT' not in clause:
            continue
        # An optional/preferred document is not a mandatory requirement. Do not
        # promise eligibility from a preference or uncertain/conditional wording.
        if _SOFT.search(clause) or re.search(
                r'\b(?:если|if|ako|ако|при условии|для отклика|для подачи|'
                r'на момент|на этапе|at application|to apply|только после)\b', clause):
            continue
        negatives = []
        for rule in _NEGATIVE:
            for match in rule.finditer(clause):
                prefix = clause[max(0, match.start() - 12):match.start()]
                if re.search(r'(?:\bне|\bnot|\bdon\x27t)\s+$', prefix):
                    continue
                negatives.append(match.span())
        if negatives:
            facts.add(False)
        for rule in _POSITIVE:
            for match in rule.finditer(clause):
                # "not required" contains "required"; do not count its positive
                # substring. A separate contradictory assertion stays unknown.
                if any(start < match.end() and end > match.start() for start, end in negatives):
                    continue
                prefix = clause[max(0, match.start() - 12):match.start()]
                if re.search(r'(?:\bне|\bnot|\bnije|\bније|\bno)\s+$', prefix):
                    continue
                facts.add(True)
    return next(iter(facts)) if len(facts) == 1 else None


def job_residence_permit_requirement(job):
    return residence_permit_requirement('\n'.join(str(job.get(key) or '') for key in ('title', 'description')))
