import { access, readFile } from 'fs/promises'
import { join } from 'path'

export type LifeSystemCheckIssue = {
  path: string
  message: string
}

export type LifeSystemCheckResult = {
  ok: boolean
  checkedFiles: number
  issues: LifeSystemCheckIssue[]
}

const REQUIRED_FILES: Array<{
  path: string
  mustContain: string[]
}> = [
  {
    path: 'README.md',
    mustContain: ['## Карта навигации', '## Правила работы в симуляции'],
  },
  {
    path: 'SYSTEM_INDEX.md',
    mustContain: ['## Матрица источников истины', '## Потоки обновления'],
  },
  {
    path: 'AGENT_OPERATIONS.md',
    mustContain: ['## Контракт записи', '## Definition of Done'],
  },
  {
    path: 'CONTROL_PANEL.md',
    mustContain: ['## Быстрый запуск дня', '## Проверка агента'],
  },
  {
    path: 'pattern-register.md',
    mustContain: ['## Формат записи', '## Правило эскалации'],
  },
  {
    path: 'reward-table.md',
    mustContain: ['## Базовая шкала действий', '## Правило начисления'],
  },
  {
    path: 'sync-audit.md',
    mustContain: ['## Формат записи', 'current status drift'],
  },
  {
    path: 'risk-gates.md',
    mustContain: ['## Health Gate', '## Legal / Platform Gate'],
  },
  {
    path: 'checklists/daily-runbook.md',
    mustContain: ['## Утро', '## Вечер'],
  },
  {
    path: 'checklists/weekly-review.md',
    mustContain: ['## Вход', '## Выход'],
  },
  {
    path: 'checklists/monthly-review.md',
    mustContain: ['## Вход', '## Выход'],
  },
  {
    path: 'game-loop.md',
    mustContain: ['## 1. Цикл дня', '## 3. Опыт и уровень'],
  },
  {
    path: 'stats.md',
    mustContain: ['## Ресурсы', '## Воздержание'],
  },
  {
    path: 'quests.md',
    mustContain: ['## Типы квестов', '## 🔄 DAILY'],
  },
  {
    path: 'planner.md',
    mustContain: ['## 🎯 Цели на день', '## 📅 План на неделю'],
  },
  {
    path: 'goals.md',
    mustContain: ['## Пирамида целей', '## Текущие цели'],
  },
  {
    path: 'logbook.md',
    mustContain: ['## 1. Ежедневный лог', '## 5. Лог ключевых событий'],
  },
  {
    path: 'diary.md',
    mustContain: ['## Шаблон дня', '## Журнал'],
  },
  {
    path: 'battle-log.md',
    mustContain: ['## Формат записи', '## История поражений'],
  },
  {
    path: 'records.md',
    mustContain: ['## Побитые рекорды', '## Смелость и вызовы'],
  },
  {
    path: 'training-log.md',
    mustContain: ['## Раздел 1: Журнал тренировок', '## Раздел 7: Контрольные точки'],
  },
  {
    path: 'worldview.md',
    mustContain: ['## Operating Context', '## Agent Behavior'],
  },
  {
    path: 'nova/nova-protocol.md',
    mustContain: ['## Цикл NPL', '## Integration с общей RPG-системой'],
  },
]

export async function checkLifeSystem(
  projectRoot = process.cwd(),
): Promise<LifeSystemCheckResult> {
  const root = join(projectRoot, 'Vladimir_Kuplevatskyi')
  const issues: LifeSystemCheckIssue[] = []

  for (const spec of REQUIRED_FILES) {
    const absolutePath = join(root, spec.path)
    try {
      await access(absolutePath)
    } catch {
      issues.push({ path: spec.path, message: 'missing required file' })
      continue
    }

    const content = await readFile(absolutePath, 'utf8')
    if (content.trim().length === 0) {
      issues.push({ path: spec.path, message: 'file is empty' })
      continue
    }

    for (const marker of spec.mustContain) {
      if (!content.includes(marker)) {
        issues.push({
          path: spec.path,
          message: `missing marker: ${marker}`,
        })
      }
    }
  }

  return {
    ok: issues.length === 0,
    checkedFiles: REQUIRED_FILES.length,
    issues,
  }
}

if (import.meta.main) {
  const result = await checkLifeSystem()
  if (!result.ok) {
    console.error(`Life system check failed (${result.issues.length} issues):`)
    for (const issue of result.issues) {
      console.error(`- ${issue.path}: ${issue.message}`)
    }
    process.exit(1)
  }
  console.log(`Life system check passed (${result.checkedFiles} files).`)
}
