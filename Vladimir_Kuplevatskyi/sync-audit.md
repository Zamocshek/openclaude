# Sync Audit — журнал расхождений и сверок

Append-only журнал. Здесь фиксируются противоречия между файлами, чтобы агент
не исправлял память молча и не выбирал удобную версию без основания.

---

## Формат записи

```md
## YYYY-MM-DD — Краткое название

- Статус: open / resolved
- Файлы:
- Расхождение:
- Источник, который должен владеть фактом:
- Предлагаемое действие:
- Выполнено:
```

---

## 2026-07-17 — current status drift

- Статус: open
- Файлы: `README.md`, `stats.md`, `dashboard.html`, `nova/nova-stats.md`,
  `nova/nova-achievements.md`
- Расхождение: текущие XP/уровень/streak Владимира и XP НОВЫ отображаются
  разными значениями в разных местах.
- Источник, который должен владеть фактом: `stats.md` для Владимира,
  `nova/nova-stats.md` для НОВЫ, `logbook.md` как фактический ledger.
- Предлагаемое действие: на отдельном sync pass прочитать `logbook.md`,
  `battle-log.md`, `stats.md`, `nova/nova-stats.md`, затем обновить только
  зеркальные summaries (`README.md`, `dashboard.html`, achievements progress).
- Выполнено: нет.

## 2026-07-17 — reward table drift

- Статус: open
- Файлы: `game-loop.md`, `quests.md`, `habit-tracker.md`, `stats.md`,
  `achievements.md`
- Расхождение: награды за streak/воздержание и daily actions описаны в
  нескольких местах, возможны разные числа.
- Источник, который должен владеть фактом: `reward-table.md` как индекс,
  `game-loop.md` как базовая механика, `logbook.md` как факт начисления.
- Предлагаемое действие: при следующей правке наград привести файлы к ссылкам
  на `reward-table.md`, не менять исторические записи.
- Выполнено: создан `reward-table.md`; зеркальные файлы пока не переписаны.

## 2026-07-17 — missing pattern register

- Статус: resolved
- Файлы: `nova/nova-protocol.md`
- Расхождение: NPL требует pattern register, но отдельного файла не было.
- Источник, который должен владеть фактом: `pattern-register.md`.
- Предлагаемое действие: создать общий register для Владимира и НОВЫ.
- Выполнено: создан `pattern-register.md`.