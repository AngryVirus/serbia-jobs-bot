"""Google Maps search links for explicitly stated workplace addresses."""
import re
from urllib.parse import urlencode


def street_address(value):
    value = ' '.join(str(value or '').split()).strip(' ,.;')
    if not value or len(value) > 250 or re.search(r'https?://|@|\bremote\b|удал[её]н', value, re.I):
        return ''
    # A city alone, phone number, or salary is not a street address.
    if not re.search(r'[^\W\d_]{3,}', value, re.U) or not re.search(r'\b\d+[A-Za-zА-Яа-я]?\b|\bb\.?b\.?\b|\bбб\b', value, re.I):
        return ''
    if re.search(r'\b(?:EUR|RSD|USD)\b|\+\d{3}', value, re.I):
        return ''
    return value


def job_address(job):
    # Preserve the original address when rendering a translated card.
    if '_map_address' in job:
        return job['_map_address']
    location = str(job.get('location') or '')
    address = street_address(location)
    if not address:
        text = str(job.get('description') or '')
        pattern = (r'(?:адрес(?:\s+работы)?|address|adresa|адреса|локация|location)\s*[:：]\s*'
                   r'([^\n;]{3,250}?)'
                   r'(?=\n|;|$|\s+(?:Контакты|Телефон|Зарплата|Условия|Требования|Отклик|Contact|Salary)\s*:)')
        for match in re.finditer(pattern, text, re.I):
            address = street_address(match[1])
            if address:
                break
        if not address:
            for line in text.splitlines():
                if re.match(r'\s*(?:ул(?:ица)?\.?|улица|ulica|ul\.|bulevar|булевар)\s+', line, re.I):
                    address = street_address(line)
                    if address:
                        break
    if address and location and location.casefold() not in address.casefold() and not street_address(location):
        # Add only an explicitly supplied city, never an inferred workplace.
        if re.fullmatch(r'[\w\s,.-]{2,70}', location) and not re.search(r'remote|удал|гибрид', location, re.I):
            address += ', ' + location
    return address


def maps_url(job):
    address = job_address(job)
    return 'https://www.google.com/maps/search/?' + urlencode({'api': 1, 'query': address}) if address else None


def map_buttons(job):
    url = maps_url(job)
    return [[{'text': '🗺 Открыть в Google Maps', 'url': url}]] if url else []
