"""Serbian locality recognition for source admission, independent of UI filters.

Names are explicit localities, not substrings. The five city filter choices are
kept in filters.py; this wider list only prevents valid local ads being lost.
"""
import re
import unicodedata


def _normalize(value):
    value = unicodedata.normalize('NFKD', str(value).casefold().replace('đ', 'dj'))
    return ' '.join(''.join(c for c in value if not unicodedata.combining(c)).split())


# Include common Serbian, Russian and English spellings and observed case forms.
LOCALITIES = {
    'Beograd': ('beograd', 'beogradu', 'beograda', 'belgrade', 'белград', 'белграде', 'белграда', 'белграду', 'београд', 'београду', 'београда', 'новый белград'),
    'Novi Sad': ('novi sad', 'novom sadu', 'novog sada', 'novi-sad', 'нови сад', 'нови-сад', 'нови сада', 'нови-саде', 'нови саду', 'нови-саду', 'нови сада', 'новом саду'),
    'Nis': ('nis', 'nisu', 'nisa', 'ниш', 'нише', 'нишу', 'ниша'),
    'Subotica': ('subotica', 'subotici', 'subotice', 'суботица', 'суботице', 'суботици', 'суботицу'),
    'Kragujevac': ('kragujevac', 'kragujevcu', 'крагујевац', 'крагујевцу', 'крагуевац', 'крагуеваце', 'крагуевцу'),
    'Ruma': ('ruma', 'rumi', 'rume', 'рума', 'руме', 'руми', 'руму'),
    'Zrenjanin': ('zrenjanin', 'zrenjaninu', 'зрењанин', 'зрењанину', 'зренянин', 'зренянине', 'зренянину'),
    'Pancevo': ('pancevo', 'pancevu', 'panceva', 'панчево', 'панчеве', 'панчеву'),
    'Cacak': ('cacak', 'cacku', 'cacka', 'чачак', 'чачке', 'чачку'),
    'Kraljevo': ('kraljevo', 'kraljevu', 'краљево', 'краљеву', 'кралево', 'кралеве'),
    'Krusevac': ('krusevac', 'krusevcu', 'крушевац', 'крушевце', 'крушевцу'),
    'Uzice': ('uzice', 'uzicu', 'uzicama', 'ужице', 'ужицу'),
    'Leskovac': ('leskovac', 'leskovcu', 'лесковац', 'лесковце', 'лесковцу'),
    'Smederevo': ('smederevo', 'smederevu', 'смедерево', 'смедереве', 'смедереву'),
    'Sombor': ('sombor', 'somboru', 'сомбор', 'сомборе', 'сомбору'),
    'Valjevo': ('valjevo', 'valjevu', 'ваљево', 'ваљеву', 'валево', 'валеве'),
    'Vranje': ('vranje', 'vranju', 'врање', 'врању', 'вране'),
    'Sabac': ('sabac', 'sapcu', 'шабац', 'шапце', 'шапцу'),
    'Novi Pazar': ('novi pazar', 'novom pazaru', 'нови пазар', 'новом пазару'),
    'Sremska Mitrovica': ('sremska mitrovica', 'sremskoj mitrovici', 'сремска митровица', 'сремској митровици', 'сремской митровице'),
    'Pozarevac': ('pozarevac', 'pozarevcu', 'пожаревац', 'пожаревцу'),
    'Pozega': ('pozega', 'pozegi', 'пожега', 'пожеги'),
    'Jagodina': ('jagodina', 'jagodini', 'јагодина', 'јагодини', 'ягодина', 'ягодине'),
    'Bor': ('bor', 'boru', 'бор', 'боре', 'бору'),
    'Pirot': ('pirot', 'pirotu', 'пирот', 'пироте', 'пироту'),
    'Zajecar': ('zajecar', 'zajecaru', 'зајечар', 'зајечару', 'заечар'),
    'Vrsac': ('vrsac', 'vrscu', 'вршац', 'вршце', 'вршцу'),
    'Kikinda': ('kikinda', 'kikindi', 'кикинда', 'кикинде', 'кикинди'),
    'Indjija': ('indjija', 'indjiji', 'инђија', 'инђији', 'инджия', 'инджии'),
    'Stara Pazova': ('stara pazova', 'staroj pazovi', 'стара пазова', 'старој пазови', 'старой пазове'),
    'Nova Pazova': ('nova pazova', 'novoj pazovi', 'нова пазова', 'новој пазови', 'новой пазове'),
    'Backa Palanka': ('backa palanka', 'backoj palanci', 'бачка паланка', 'бачкој паланци'),
    'Grocka': ('grocka', 'grockoj', 'гроцка', 'гроцке', 'гроцкој'),
    'Raca': ('raca', 'raci', 'рача', 'раче', 'рачи'),
    'Lazarevac': ('lazarevac', 'lazarevcu', 'лазаревац', 'лазаревцу'),
    'Obrenovac': ('obrenovac', 'obrenovcu', 'обреновац', 'обреновцу'),
    'Mladenovac': ('mladenovac', 'mladenovcu', 'младеновац', 'младеновцу'),
    'Arandjelovac': ('arandjelovac', 'arandjelovcu', 'аранђеловац', 'аранђеловцу', 'аранджеловац'),
    'Gornji Milanovac': ('gornji milanovac', 'gornjem milanovcu', 'горњи милановац', 'горњем милановцу'),
    'Loznica': ('loznica', 'loznici', 'лозница', 'лознице', 'лозници'),
}
COUNTRY = r'(?<!\w)(?:serbia|srbija|srbiji|srbije|серби[яиюи]|србија|србији|србије)(?!\w)'


def serbian_cities(text):
    """Return canonical localities explicitly present in text, in registry order.

    Nis and Bor need capitalisation or a location label: Russian «ниша рынка»
    and generic lower-case words must not turn a foreign/remote ad Serbian.
    Unaccented Raci needs location context to distinguish it from business RACI.
    """
    value = _normalize(text)
    found = []
    for city, names in LOCALITIES.items():
        if city == 'Nis' and not re.search(
                r'(?<!\w)(?:Niš|NIŠ|Nis|NIS|Ниш(?:е|у)?)(?!\w)|'
                r'(?i:(?:location|lokacija|локация|город|г\.|📍)\s*:?\s*(?:niš|nis|ниш)(?!\w))', str(text)):
            continue
        if city == 'Bor' and not re.search(
                r'(?<!\w)(?:Bor|BOR|Бор(?:е|у)?)(?!\w)|'
                r'(?i:(?:location|lokacija|локация|город|г\.|📍)\s*:?\s*(?:bor|бор)(?!\w))', str(text)):
            continue
        if city == 'Raca' and not re.search(
                r'(?i:(?<!\w)rači(?!\w))|'
                r'(?<!\w)(?i:u|iz|kod|prema)\s+(?:Raci|raci)(?!\w)|'
                r'(?i:(?<!\w)(?:location|lokacija|локация|город|г\.|📍)\s*[:—-]?\s*raci(?!\w))', str(text)):
            names = tuple(name for name in names if name != 'raci')
        if any(re.search(r'(?<!\w)' + re.escape(_normalize(name)) + r'(?!\w)', value) for name in names):
            found.append(city)
    return found


def has_serbian_location(text):
    """Positive geographic evidence; generic worldwide/remote alone is false."""
    return bool(re.search(COUNTRY, _normalize(text)) or serbian_cities(text))
