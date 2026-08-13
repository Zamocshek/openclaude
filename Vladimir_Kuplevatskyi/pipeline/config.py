"""
Content pipeline configuration.
"""

# Donor channels (English → Russian translation)
DONORS = [
    {
        "username": "joelamptonn",
        "name": "Joe Lampton",
        "description": "Webcam business, low-inhibition philosophy, game, hustle",
        "style_notes": "Aggressive, direct, sales-oriented. Heavy on imperative mood. Street-level masculine advice.",
    },
    {
        "username": "tatespeech",
        "name": "Tate Speech",
        "description": "Andrew Tate official — prison updates, philosophy, anti-system, masculinity",
        "style_notes": "Defiant, philosophical, aphoristic. War/fighting metaphors. Short punchy lines. Prison narrative.",
    },
    {
        "username": "dailyjwaller",
        "name": "Daily J Waller",
        "description": "Masculine frame, discipline, success mindset, showing up over talent",
        "style_notes": "Short aphoristic lines. Consistency/discipline themes. Direct second-person address. No filler.",
    },
    {
        "username": "talismantatetelegram",
        "name": "Talisman Tate",
        "description": "Tristan Tate — personal reflections, brotherhood, media criticism, Rumble streams",
        "style_notes": "Conversational, personal stories, anti-MSM, loyalist tone. Less frequent but longer posts.",
    },
]

# Editorial target catalog. The managed Telegram MCP campaign manifest is the
# authority for every concrete wave; this default includes publishable targets
# only and never overrides request-specific exclusions.
TARGET_CHANNELS = [
    # Основная сетка
    "Übermensch FRONT",
    "Мартин | Саморазвитие",
    "Храм силы",
    "Out'Darkness",
    "Гоша Миллер | Looksmaxxing",
    "Wild Street",
    "TRON | САМООБОРОНА",
    "Mass gym",
    # Сетка Сливов
    "Канал Слив Эндрю Тейт",
    "Канал Слив Курсов Кирилла Сарычева",
    "Канал Слив Слипи Sleepy",
    "Канал Слив Один Процент Книга",
    "Канал Слив R7 Программы Тренировок",
    "Канал Слив BIOMACHINE",
]

DISABLED_TARGET_CHANNELS = {
    "Канал Слив Могвартс 2.0 Гоша Миллер": (
        "Publishing is disabled by the managed channel profile."
    ),
}

# Translation style guide
STYLE_GUIDE = """
Ты — переводчик и редактор контента для СНГ-аудитории (Россия, Украина, Казахстан, Беларусь).

ПРАВИЛА ПЕРЕВОДА:
1. НЕ используй книжный/академический русский. Пиши как пацан с района, который читал книжки.
2. Убирай ИИ-слоп: никаких "в современном мире", "стоит отметить", "в заключение", "давайте рассмотрим".
3. Используй разговорный СНГ-сленг: "чел", "тип", "короче", "жестко", "по кайфу", "залетает".
4. Сохраняй агрессивный/прямой тон оригинала. Мат — ок, если к месту.
5. Английские имена/бренды оставляй как есть (Tate, Lamborghini).
6. Длинные предложения на английском — разбивай на короткие. Русский не любит сложных конструкций.
7. Адаптируй культурные отсылки: если шутка понятна только американцам — замени на аналог из СНГ.
8. Сохраняй смысл, но не будь рабом дословного перевода. Передай ДУХ, а не букву.
9. Глубина зависит от задачи и профиля канала. Для обычной сеточной волны
   развивай одну мысль минимум до standard-формата (ориентир 700-2100 знаков).
   Короткий формат используй только когда пользователь прямо просит коротко
   или сжатие объективно усиливает идею.
10. В конце поста — НИКОГДА не ставь "подписывайся", "ставь лайк", хештеги. Просто обрывай на мысли.

ПРИМЕР СТИЛЯ:
Оригинал: "If you're comfortable talking to strangers, joking, interacting with women, saying crazy shit — you're already above most."
Хорошо: "Если ты спокойно подходишь к незнакомцам, шутишь, говоришь всякую дичь и не паришься — ты уже выше 90%."
Плохо: "Если вы комфортно чувствуете себя при общении с незнакомыми людьми и взаимодействии с противоположным полом..."

ОБЯЗАТЕЛЬНЫЙ ПРЕДПРОЧТЕНИЕ: см. PREFLIGHT.md в этой же папке — канон из 5 правил.
ПОЛНЫЙ РЕФЕРЕНС ПО ОФОРМЛЕНИЮ: см. FORMATTING.md в этой же папке.
Там: HTML-теги, premium-emoji, структура постов, примеры, чек-лист перед публикацией.
"""

# Content filter — skip posts matching these patterns (too promotional, no value)
SKIP_PATTERNS = [
    "www.joelampton.net",  # direct promos
    "DM @",  # call to DM
    "EMERGENCY MEETING",  # stream announcements
    "LIVE IN",  # stream announcements
    "Streaming Solo",  # stream announcements
    "Live in 5",  # stream announcements
]

# Minimal character length for a post to be worth translating
MIN_POST_LENGTH = 80
