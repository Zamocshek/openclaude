export type McpTaskRoute = {
  mode: 'auto' | 'all'
  servers: Set<string>
  reasons: string[]
}

const ALL_CAPABILITIES_RE =
  /(?:\b(?:all tools|all mcp|every tool|full tool access)\b|(?:все|весь|полный)\s+(?:тул|инструмент|мсп|mcp))/iu
const RESEARCH_RE =
  /(?:\b(?:research|search the web|web search|current|latest|news|sources?|look up|verify online)\b|(?:исслед|поиск в интернете|найди в сети|актуальн|последн(?:ие|яя)|новост|источник|проверь в интернете))/iu
const BROWSER_RE =
  /(?:\b(?:browser|camofox|website|web page|screenshot|click|log in|sign in|open the page)\b|(?:браузер|камоуфокс|сайт|веб-?страниц|скриншот|нажми|авториз|залогин|открой страницу))/iu
const MEMORY_RE =
  /(?:\b(?:remember|memory|recall|forget|prior decision|preference|hindsight)\b|(?:запомни|памят|вспомни|забудь|предыдущ(?:ее|ий)|предпочтени))/iu
const RAG_RE =
  /(?:\b(?:openrag|rag|knowledge base|ingest(?:ion)?|retrieval|document corpus)\b|(?:опенраг|база знаний|индексац|загрузи документ|по документам|корпус документ))/iu
const TELEGRAM_ACCOUNT_RE =
  /(?:\b(?:telegram mcp|telegram account|telegram session|send (?:a )?telegram|read telegram)\b|(?:телеграм(?:м)?\s+(?:mcp|мсп|аккаунт|сесси)|отправь.+телеграм|прочитай.+телеграм))/iu
const CONTROL_RE =
  /(?:\b(?:tool router|mcp server|skill store|subagent|sub-agent|provider|model routing|android device|adb device|gateway control)\b|(?:роутер (?:тул|инструмент|mcp|мсп)|mcp сервер|мсп сервер|скилл стор|саб-?агент|провайдер|маршрут модел|android|андроид|adb|управлен.+агент))/iu
const EXTERNAL_INTEGRATION_RE =
  /(?:\b(?:mcp integration|external integration|connect (?:google|notion|slack|github|calendar|drive)|use mcp)\b|(?:mcp|мсп)\s+интеграц|подключи.+(?:google|notion|slack|github|calendar|drive)|используй\s+(?:mcp|мсп))/iu

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
    eligibleServerNames?: Iterable<string>
  },
): McpTaskRoute {
  const request = extractCurrentUserRequest(prompt)
  if (ALL_CAPABILITIES_RE.test(request)) {
    return {
      mode: 'all',
      servers: new Set(),
      reasons: ['explicit all-tools request'],
    }
  }

  const servers = new Set<string>()
  const reasons: string[] = []
  const add = (reason: string, ...names: string[]) => {
    reasons.push(reason)
    for (const name of names) servers.add(name)
  }

  add('durable-memory', 'hindsight')
  if (options.codingIntent) add('coding', 'codegraph', 'context7')
  if (RESEARCH_RE.test(request)) add('research', 'searxng')
  if (BROWSER_RE.test(request)) add('browser', 'camofox')
  if (MEMORY_RE.test(request)) reasons.push('explicit-memory')
  if (RAG_RE.test(request)) add('rag', 'openrag')
  if (TELEGRAM_ACCOUNT_RE.test(request)) add('telegram-account', 'telegram-mcp')
  if (CONTROL_RE.test(request)) add('agent-control', 'gateway-control')
  if (EXTERNAL_INTEGRATION_RE.test(request)) {
    add('external-integration', 'mcp-router', 'gateway-control')
  }
  const requestLower = request.toLowerCase()
  for (const name of options.eligibleServerNames || []) {
    const normalized = name.trim().toLowerCase()
    if (normalized.length >= 3 && requestLower.includes(normalized)) {
      add(`explicit-server:${name}`, name)
    }
  }

  return { mode: 'auto', servers, reasons }
}

export function extractCurrentUserRequest(prompt: string): string {
  const markers = [
    ...prompt.matchAll(
      /(?:^|\n)(?:(?:User|Current) request|User message):\s*/giu,
    ),
  ]
  const marker = markers.at(-1)
  return marker?.index === undefined
    ? prompt.slice(-16_000)
    : prompt.slice(marker.index + marker[0].length)
}
