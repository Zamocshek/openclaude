export type McpTaskRoute = {
  mode: 'auto' | 'all'
  servers: Set<string>
  reasons: string[]
  source?: 'semantic' | 'heuristic'
  capabilities?: string[]
  taskKind?: string
  codingIntent?: boolean
  codingMutationIntent?: boolean
  confidence?: number
}

export type CapabilityCatalogEntry = {
  id: string
  servers: readonly string[]
  routes: readonly string[]
  summary: string
}

export const CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    id: 'coding',
    servers: ['codegraph', 'context7'],
    routes: ['coding'],
    summary:
      'Skill(code) -> inspect/edit/test; codegraph_explore -> symbols and impact; Context7 -> resolve-library-id then query-docs for version-specific APIs.',
  },
  {
    id: 'documentation',
    servers: ['context7'],
    routes: ['library-docs'],
    summary:
      'Documentation -> resolve-library-id, then query-docs; prefer the version and framework named by the user and verify security-sensitive claims against primary sources.',
  },
  {
    id: 'research',
    servers: ['searxng'],
    routes: ['research'],
    summary:
      'SearXNG -> searxng_web_search for discovery, then inspect primary sources with the available web reader.',
  },
  {
    id: 'browser',
    servers: ['camofox'],
    routes: ['browser', 'browser-model'],
    summary:
      'Camofox -> create/list tab, snapshot, act by stable refs, then screenshot when visual proof is requested; use Skill(qwen-collab) for browser AI models.',
  },
  {
    id: 'multimodal',
    servers: ['qwen-mm-core', 'qwen-mm-local'],
    routes: ['multimodal'],
    summary:
      'Qwen-MM local -> use vision_chat/OCR/grounding for textual evidence; use core for metadata, video frames, crops, visualizations, and annotated artifacts. Never send raw image blocks to a text-only coordinator.',
  },
  {
    id: 'memory',
    servers: ['hindsight'],
    routes: ['explicit-memory'],
    summary:
      'Memory -> recall before answering from prior context, retain only explicit durable facts, and use forget only for explicit deletion; Telegram also requires its [MEMORY] bridge directive.',
  },
  {
    id: 'rag',
    servers: ['lightrag'],
    routes: ['rag'],
    summary:
      'LightRAG -> lightrag_search for grounded answers; use lightrag_ingest_text/file only when ingestion is requested, track indexing to completion, cite successful results, and never invent retrieval.',
  },
  {
    id: 'telegram',
    servers: ['telegram-mcp'],
    routes: [
      'telegram-account',
      'promotion',
      'explicit-server:telegram-mcp',
    ],
    summary:
      'Telegram MCP -> list_accounts first; use telegram-mcp-operations for reads/replies; for Maton Bot API use config -> connections -> dedicated maton_telegram_* -> confirm and require message_id; use VPromotions/TwiBoost preview-then-confirm for paid actions.',
  },
  {
    id: 'github',
    servers: ['github'],
    routes: ['github'],
    summary:
      'GitHub MCP -> inspect repositories, files, commits, issues, pull requests, Actions, and authenticated account context through the official GitHub server; prefer it over ad-hoc REST calls.',
  },
  {
    id: 'control',
    servers: ['capability-router', 'mcp-router', 'gateway-control'],
    routes: [
      'agent-control',
      'mcp-management',
      'external-integration',
      'explicit-server:mcp-router',
      'explicit-server:gateway-control',
      'explicit-server:capability-router',
    ],
    summary:
      'Control -> use capability-router for portable lazy selection, Skill Store, and files; use gateway-control/mcp-router for runtime-specific settings.',
  },
  {
    id: 'android',
    servers: ['gateway-control'],
    routes: ['device'],
    summary:
      'Android -> Skill(android-device), resolve a saved alias, check the device, snapshot before actions, and use the pinned android-<alias> MCP namespace.',
  },
  {
    id: 'pentest',
    servers: ['pentest', 'codegraph'],
    routes: ['authorized-pentest', 'explicit-server:pentest'],
    summary:
      'Authorized security work -> Skill(pentest), verify exact scope before active actions, keep evidence/state, and generate the report; do not bypass authorization.',
  },
]

const SERVER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'capability-router': ['capability router', 'capability fabric', 'portable router', 'роутер возможностей'],
  'mcp-router': ['mcp router', 'tool router', 'tools router', 'тул роутер', 'роутер инструментов'],
  'gateway-control': ['gateway control', 'agent control', 'управление агентом', 'панель агента'],
  lightrag: ['lightrag', 'light rag', 'openrag', 'rag', 'knowledge base', 'база знаний'],
  hindsight: ['hindsight', 'durable memory', 'долговременная память'],
  camofox: ['camofox', 'camoufox', 'browser automation', 'браузерная автоматизация'],
  codegraph: ['codegraph', 'code graph', 'граф кода'],
  searxng: ['searxng', 'search engine', 'поиск в интернете'],
  context7: ['context7', 'library docs', 'документация библиотек'],
  'qwen-mm-core': ['qwen mm core', 'qwen multimodal', 'local vision', 'media tools'],
  'qwen-mm-local': ['qwen mm', 'qwen vl', 'qwen3 vl', 'local qwen vision', 'local ocr'],
  pentest: ['pentest', 'pentestcode', 'security assessment', 'пентест', 'аудит безопасности'],
  'telegram-mcp': [
    'telegram mcp',
    'telegram bridge',
    'telegram account',
    'телеграм мсп',
    'телеграм мост',
    'телеграм аккаунт',
    'twiboost',
    'vpromotions',
    'vp promotions',
    'maton',
  ],
  github: [
    'github',
    'github mcp',
    'гитхаб',
    'гитхаб мсп',
    'pull request',
  ],
}

const ALL_CAPABILITIES_RE =
  /(?:\b(?:all tools|all mcp|every tool|full tool access)\b|(?:все|весь|полный)\s+(?:тул|инструмент|мсп|mcp))/iu
const RESEARCH_RE =
  /(?:\b(?:research|search the web|web search|current|latest|news|sources?|look up|verify online)\b|(?:исслед|поиск в интернете|найди в сети|актуальн|последн(?:ие|яя)|новост|источник|проверь в интернете))/iu
const BROWSER_RE =
  /(?:\b(?:browser|camofox|website|web page|screenshot|click|log in|sign in|open the page)\b|(?:браузер|камуфокс|камоуфокс|сайт|веб-?страниц|скриншот|нажми|авториз|залогин|открой страницу))/iu
const MULTIMODAL_RE =
  /(?:\b(?:image|photo|picture|vision|visual|ocr|grounding|screenshot|video|frame)\b|\.(?:png|jpe?g|webp|gif|bmp|mp4|mov|mkv|webm)\b|(?:изображен|картинк|фото|скриншот|видео|кадр|распознай\s+текст|прочитай\s+текст|объект\s+на))/iu
const MEMORY_RE =
  /(?:\b(?:remember|memory|recall|forget|prior decision|our decisions|earlier context|preference|hindsight)\b|(?:запомни|памят|вспомни|забудь|предыдущ(?:ее|ий)|предпочтени|наш(?:и|их)\s+решени|что\s+мы\s+решили|раньше))/iu
const RAG_RE =
  /(?:\b(?:lightrag|light rag|openrag|rag|knowledge base|ingest(?:ion)?|retrieval|document corpus)\b|(?:лайтраг|лайт раг|опенраг|база знаний|индексац|загрузи документ|по документам|корпус документ))/iu
const TELEGRAM_ACCOUNT_RE =
  /(?:\b(?:telegram mcp|telegram account|telegram session|send (?:a )?telegram|read telegram)\b|(?:телеграм(?:м)?\s+(?:mcp|мсп|аккаунт|сесси)|отправь.+телеграм|прочитай.+телеграм))/iu
const CONTROL_RE =
  /(?:\b(?:tool router|mcp server|skill store|subagent|sub-agent|provider|model routing|android device|adb device|gateway control)\b|(?:роутер (?:тул|инструмент|mcp|мсп)|mcp сервер|мсп сервер|скилл стор|саб-?агент|провайдер|маршрут модел|android|андроид|adb|управлен.+агент))/iu
const EXTERNAL_INTEGRATION_RE =
  /(?:\b(?:mcp integration|external integration|connect (?:google|notion|slack|github|calendar|drive)|use mcp)\b|(?:mcp|мсп)\s+интеграц|подключи.+(?:google|notion|slack|github|calendar|drive)|используй\s+(?:mcp|мсп))/iu
const DOCS_RE =
  /(?:\b(?:library docs?|api docs?|sdk docs?|framework docs?|official documentation|version-specific)\b|(?:документац|библиотек|официальн.+док|версия.+апи))/iu
const PROMOTION_RE =
  /(?:\b(?:twiboost|vpromotions?|vp promotions?|social promotion|followers?|likes?|subscribers?)\b|(?:накрут|подписчик|лайк|продвиж|промоушен))/iu
const MCP_MANAGEMENT_RE =
  /(?:\b(?:add|import|enable|disable|remove|configure)\s+(?:an?\s+)?mcp\b|mcp\s+(?:json|server|config)|skill\s+store|tool\s+router|(?:добав|импорт|включ|выключ|настро).*(?:mcp|мсп|скилл|тул|роутер))/iu
const DEVICE_RE =
  /(?:\b(?:android|adb|device|phone|tablet|emulator|mobile qa)\b|(?:андроид|адб|устройств|телефон|планшет|эмулятор))/iu
const PENTEST_RE =
  /(?:\b(?:pentest|penetration test|security assessment|vulnerability scan|ctf)\b|(?:пентест|проникновен|уязвимост|секьюрит|аудит.+безопасн))/iu
const GITHUB_RE =
  /(?:\b(?:github|pull request|github actions|repository issue)\b|(?:гитхаб|пулл? реквест|github actions))/iu
const BROWSER_MODEL_RE =
  /(?:\b(?:qwen|chat\.qwen|browser model|browser ai|chatgpt web|gemini web|claude web)\b|(?:квен|квен|браузерн.+модел|браузерн.+ии))/iu
const QUOTED_MATERIAL_BOUNDARIES = [
  /(?:^|\n)\s*Current request:\s*/iu,
  /(?:^|\n)\s*\[\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}\]\s+[^:\n]{1,160}:\s*/u,
  /(?:^|\n)\s*[^\n]{1,180},\s*\[\d{1,2}\s+[^\]\n]{2,80}\s+\d{4}\s+(?:в|at)\s+\d{1,2}:\d{2}\]\s*(?:\n|$)/iu,
  /(?:^|\n)\s*(?:forwarded message|пересланное сообщение|chat transcript|dialogue transcript|диалог|переписка)\s*:\s*(?:\n|$)/iu,
] as const

export function isAutoMcpRoutingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENCLAUDE_AGENT_AUTO_MCP_ROUTING
  if (raw === undefined || raw.trim() === '') return true
  return !/^(?:0|false|no|off)$/iu.test(raw.trim())
}

export function selectMcpServersForPrompt(
  prompt: string,
  options: {
    codingIntent: boolean
    codingMutationIntent?: boolean
    eligibleServerNames?: Iterable<string>
  },
): McpTaskRoute {
  const request = extractTaskDirective(prompt)
  if (ALL_CAPABILITIES_RE.test(request)) {
    return {
      mode: 'all',
      servers: new Set(),
      reasons: ['explicit all-tools request'],
      source: 'heuristic',
      codingIntent: options.codingIntent,
      codingMutationIntent: options.codingMutationIntent,
    }
  }

  const servers = new Set<string>()
  const reasons: string[] = []
  const add = (reason: string, ...names: string[]) => {
    reasons.push(reason)
    for (const name of names) servers.add(name)
  }

  if (options.codingIntent) add('coding', 'codegraph', 'context7')
  if (RESEARCH_RE.test(request)) add('research', 'searxng')
  if (BROWSER_RE.test(request)) add('browser', 'camofox')
  if (MULTIMODAL_RE.test(request)) add('multimodal', 'qwen-mm-core', 'qwen-mm-local')
  if (BROWSER_MODEL_RE.test(request)) add('browser-model', 'camofox')
  if (MEMORY_RE.test(request)) add('explicit-memory', 'hindsight')
  if (RAG_RE.test(request)) add('rag', 'lightrag')
  if (TELEGRAM_ACCOUNT_RE.test(request)) add('telegram-account', 'telegram-mcp')
  if (CONTROL_RE.test(request)) add('agent-control', 'gateway-control')
  if (DOCS_RE.test(request)) add('library-docs', 'context7')
  if (PROMOTION_RE.test(request)) add('promotion', 'telegram-mcp')
  if (MCP_MANAGEMENT_RE.test(request)) add('mcp-management', 'capability-router', 'mcp-router', 'gateway-control')
  if (DEVICE_RE.test(request)) add('device', 'gateway-control')
  if (PENTEST_RE.test(request)) add('authorized-pentest', 'pentest', 'codegraph')
  if (GITHUB_RE.test(request)) add('github', 'github')
  if (EXTERNAL_INTEGRATION_RE.test(request)) {
    add('external-integration', 'capability-router', 'mcp-router', 'gateway-control')
  }

  const requestLower = request.toLowerCase()
  for (const name of options.eligibleServerNames || []) {
    const normalized = name.trim().toLowerCase()
    const aliases = SERVER_ALIASES[normalized] || []
    if (
      (normalized.length >= 3 && requestLower.includes(normalized))
      || aliases.some(alias => requestLower.includes(alias.toLowerCase()))
      || (normalized.startsWith('android-') && DEVICE_RE.test(request))
    ) {
      add(`explicit-server:${name}`, name)
    }
  }

  return {
    mode: 'auto',
    servers,
    reasons,
    source: 'heuristic',
    codingIntent: options.codingIntent,
    codingMutationIntent: options.codingMutationIntent,
  }
}

/**
 * Build a small, request-scoped capability index. Full Skill/MCP contracts are
 * still loaded by their normal tools; this prevents the model from spending a
 * turn rediscovering which already-connected surface owns the task.
 */
export function buildCapabilityMapPrompt(
  prompt: string,
  options: {
    codingIntent: boolean
    enabledServerNames: Iterable<string>
    route?: McpTaskRoute
  },
): string {
  const enabled = new Set(
    [...options.enabledServerNames].map(name => name.trim().toLowerCase()),
  )
  const route = options.route || selectMcpServersForPrompt(prompt, {
    codingIntent: options.codingIntent,
    eligibleServerNames: enabled,
  })
  const selected = CAPABILITY_CATALOG.filter(entry => {
    const hasEnabledServer = entry.servers.some(server => enabled.has(server))
    if (!hasEnabledServer) return false
    if (route.mode === 'all') return true
    if (route.capabilities?.includes(entry.id)) return true
    return route.reasons.some(reason => entry.routes.includes(reason))
  })

  if (selected.length === 0) return ''

  return [
    'Compact Nova capability map (live MCP availability is authoritative):',
    ...selected.map(entry => `- ${entry.id}: ${entry.summary}`),
    'Use the matching Skill before a specialized workflow, call only advertised tool names, and after a tool error change the input or route once before falling back. Do not reread implementation docs unless the selected Skill explicitly requires them.',
  ].join('\n')
}

export function extractCurrentUserRequest(prompt: string): string {
  const framed = extractFramedCurrentUserRequest(prompt)
  if (framed !== undefined) return framed

  const currentMarkers = [
    ...prompt.matchAll(/(?:^|\n)Current request:\s*/giu),
  ]
  const currentMarker = currentMarkers.at(-1)
  const current = currentMarker?.index === undefined
    ? prompt
    : prompt.slice(currentMarker.index + currentMarker[0].length)
  const requestMarker =
    current.match(/(?:^|\n)User message:\s*/iu)
    || current.match(/(?:^|\n)User request:\s*/iu)
  return requestMarker?.index === undefined
    ? current.slice(-16_000)
    : current.slice(requestMarker.index + requestMarker[0].length)
}

/**
 * Frame a gateway-owned request so routing never mistakes a marker pasted by
 * the user (or retained in history) for the authoritative request boundary.
 */
export function frameCurrentUserRequest(request: string): string {
  return `Current request [chars=${request.length}]:\n${request}`
}

function extractFramedCurrentUserRequest(prompt: string): string | undefined {
  const marker = /(?:^|\n)Current request \[chars=(\d+)\]:\n/gu
  for (const match of prompt.matchAll(marker)) {
    if (match.index === undefined) continue
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 0) continue
    const start = match.index + match[0].length
    if (prompt.length - start === length) return prompt.slice(start)
  }
  return undefined
}

/**
 * Return only the instruction envelope of the current request. Pasted chat
 * exports and logs are evidence for the task, not executable instructions.
 */
export function extractTaskDirective(prompt: string): string {
  const request = extractCurrentUserRequest(prompt)
  let boundary = request.length

  for (const pattern of QUOTED_MATERIAL_BOUNDARIES) {
    const match = pattern.exec(request)
    if (match?.index !== undefined) boundary = Math.min(boundary, match.index)
  }

  return request.slice(0, boundary).trim()
}
