"""Conservative classification of public ads and explicit employer requirements."""
import re
from filters import normalize


def quality_reason(text):
    value = normalize(text)
    # Negated/conditional closure is not a closed vacancy.
    for raw in re.split(r'[\n.!?;]', text):
        clause = normalize(raw)
        if re.search(r'\b(?:если|когда|if|when|ako)\b', clause):
            continue
        if re.search(r'\b(?:вакансия|позиция|набор)\s+(?:уже\s+)?(?:закрыта?|завершен)|'
                     r'\b(?:position|vacancy) (?:is |has been )?(?:filled|closed)|'
                     r'\b(?:applications|recruitment) (?:are |is )?closed|'
                     r'\bkonkurs (?:je )?zavrsen|\bpozicija (?:je )?popunjena|'
                     r'\bконкурс (?:је )?завршен', clause):
            return 'closed'
    if re.search(r'\b(?:ищу|ищем)\s+(?:(?:новую|удаленную|постоянную|любую)\s+)?(?:работу|подработку)|'
                 r'\bв поиске работы|^[^\w]*#(?:резюме|cv)\b|#ищу_?работу\b|\bмое резюме|'
                 r'\bищу\s+(?:позицию|вакансию)|\bрассматриваю\s+(?:вакансии|предложения)|'
                 r'\bi(?: am|\x27m)? (?:looking for|seeking)\s+(?:a\s+)?(?:job|employment)\b|'
                 r'^[^\w]*(?:looking for|seeking)\s+(?:a\s+)?(?:job|employment)\b|\bopen to work\b|'
                 r'\btrazim posao\b|\bтражим посао\b', value):
        return 'seeker'
    if re.search(r'\b(?:предлагаю|оказываю)\s+услуги|\bищу клиентов|'
                 r'\bi offer (?:my )?services|\bnudim usluge\b', value):
        return 'services'
    if re.search(r'вакансии на сегодня|подборка вакансии|вакансии недели|даиджест|'
                 r'подборк[аиу].{0,30}компании|#top_vacancies|ловите.{0,30}вакансии|'
                 r'navigating the job market|job digest|weekly job|job round.?up', value):
        return 'digest'
    # Restrict promotional signals to the opening, preserving genuine job footers.
    first = value[:300]
    if re.match(r'[^\w]*(?:подписыва[йи]тесь|подборка каналов|каталог вакансии|'
                r'реклама курсов|курс по поиску работы|записываитесь на (?:курс|вебинар)|'
                r'приглашаем на (?:курс|вебинар)|join our course|upisite kurs)', first):
        return 'promotion'
    return None


def explicit_requirements(text):
    """Unknown and contradictory facts stay null; no inference from seniority."""
    experience, assistance = set(), set()
    for raw in re.split(r'[\n.!?;]', text):
        clause = normalize(raw)
        if re.search(r'\b(?:если|if|ako)\b|желател|preferred|предност|pozeljn', clause):
            continue
        no_exp = re.search(r'\bбез опыта\b|опыт(?: работы)? не (?:требуется|обязателен)|'
                           r'\bno experience (?:is )?(?:required|needed)|\bbez (?:radnog )?iskustva\b|'
                           r'iskustvo nije (?:potrebno|obavezno)', clause)
        yes_exp = re.search(r'(?:требуется|необходим|обязателен) опыт|опыт(?: работы)? (?:обязателен|от \d|не менее \d)|'
                            r'\bexperience (?:is )?(?:required|mandatory)|\b(?:at least|minimum|must have) \d+\+? years? (?:of )?experience|'
                            r'\b(?:potrebno|obavezno) (?:radno )?iskustvo', clause)
        denies_inexperienced = re.search(r'без опыта не (?:принимаем|рассматриваем|берем)|не (?:принимаем|рассматриваем|берем).{0,25}без опыта', clause)
        if denies_inexperienced:
            experience.add(True)
        elif no_exp:
            experience.add(False)
        if yes_exp and not no_exp:
            experience.add(True)
        if re.search(r'помощь с оформлением|помогаем (?:с оформлением|оформить)|'
                     r'(?:visa|work permit|residence permit) (?:sponsorship|assistance)|'
                     r'pomoc (?:pri|u) (?:dobijanju|izdavanju)', clause):
            # Assistance must concern immigration/work documents, not an order/form.
            if re.search(r'внж|разрешени\w* на работу|виз\w*|документ\w*|visa|permit|borav|dozvol', clause):
                assistance.add(not bool(re.search(r'\bне (?:оказываем|предоставляем|помогаем)|помощь.{0,70}не (?:предоставля|оказыва)|\bno (?:visa|work permit|residence permit)|\bwithout sponsorship|(?:sponsorship|assistance) (?:is )?not (?:provided|available|offered)', clause)))
    return {'experience': next(iter(experience)) if len(experience) == 1 else None,
            'paperwork_assistance': next(iter(assistance)) if len(assistance) == 1 else None}
