import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import type { AgentGatewayConfig, AgentGatewaySubagentRoute } from './config.js'
import {
  getAgentGatewayStateDir,
  getDefaultAgentGatewayConfig,
  updateAgentGatewayConfig,
} from './config.js'
import { createCronJob, deleteCronJob, getCronJob, getCronJobsPath, listCronJobs, pauseCronJob, resumeCronJob, runCronJobNow, updateCronJob, type CronJob, type CronJobMode } from './cron.js'
import {
  runOpenClaudeAgent,
  type AgentRunArtifact,
  type AgentRunResult,
} from './agentRunner.js'
import {
  buildCodingCompletionFailure,
  buildCodingVerificationPrompt,
  getCodingCompletionGap,
  mergeAgentRunResults,
} from './taskQuality.js'
import { redactAgentText } from './redaction.js'
import { detectTranscriptionTool, transcribeAudio } from './transcription.js'
import {
  applyCuratedMemoryDirectives,
  buildCuratedMemorySystemInstructions,
  buildMemoryContextSection,
  loadScratchpadBlocks,
  loadIdentity,
  loadPatterns,
  appendChatLog,
  loadChatLogTranscript,
  loadDialogueBlocks,
} from './memory.js'
import { loadRecentReflections, buildReflectionContextSection } from './reflection.js'
import { getAgentGatewayRuntime, restartAgentGateway, stopAgentGateway } from './index.js'
import { toggleEvolution, getEvolutionStatus, runEvolutionCycle, loadEvolutionState } from './evolution.js'
import type { EvolutionResult, EvolutionType } from './evolution.js'
import { buildSelfEditPrompt, selfRead, selfWrite, selfEdit, selfList, gitStatus, gitDiff, gitCommit, gitLog, gitReset } from './selfEdit.js'
import { runInfiniteTask } from './infiniteTask.js'
import {
  getReasoningEffortForModel,
  isCodexAlias,
  type ReasoningEffort,
} from '../api/providerConfig.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { parseHumanLimit } from '../../utils/limitParsing.js'
import { getAgentGatewayWebLinks } from './webLinks.js'
import {
  getBuiltInProviderModels,
  getDefaultProviderModel,
  getModelBaseId,
  loadProviderModelCatalog,
  withModelReasoning,
  type ProviderModelCatalog,
  type ProviderModelOption,
} from './providerModels.js'
import {
  getConversationContextMaxChars,
  getConversationContextTurnLimit,
  getMemoryContextMaxChars,
  selectTextBlocksWithinCharBudget,
} from './conversationContext.js'
import {
  describeManagedMcpServer,
  importManagedMcpServers,
  listManagedMcpServers,
  parseMcpConfigImport,
  removeManagedMcpServer,
  setManagedMcpServerEnabled,
  type ManagedMcpServer,
} from './mcpRegistry.js'
import {
  createManagedSkill,
  deleteManagedSkill,
  getSkillStoreItemDetails,
  listSkillStore,
  normalizeSkillCreateInput,
  parseSkillStoreImport,
  type SkillCreateInput,
  type SkillStoreImportResult,
  type SkillStoreItem,
  type SkillStoreItemDetails,
} from './skillStore.js'
import { describeGatewaySubagents } from './subagentRuntime.js'
import {
  checkAndroidDevice,
  connectAndroidDevice,
  discoverAndroidDevices,
  listAndroidDeviceProfiles,
  pairAndroidDevice,
  registerAndroidDeviceProfile,
  removeAndroidDeviceProfile,
  setActiveAndroidDeviceProfile,
  setAndroidDeviceProfileEnabled,
  type AndroidDeviceCheck,
  type AndroidDeviceProfile,
  type AndroidDeviceRegistry,
  type AndroidDiscoveredDevice,
} from './androidDevices.js'
import {
  describeRouterBuiltinTools,
  ROUTER_BUILTIN_TOOLS,
  updateRouterBuiltinToolState,
} from './toolRouterTools.js'

export type TelegramFileRef = {
  file_id: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  file_size?: number
  duration?: number
  width?: number
  height?: number
}

export type TelegramPhotoSize = {
  file_id: string
  file_unique_id?: string
  file_size?: number
  width: number
  height: number
}

export type TelegramMessage = {
  message_id: number
  text?: string
  caption?: string
  date?: number
  chat?: { id: number | string; type?: string; title?: string }
  from?: { id: number | string; username?: string; first_name?: string }
  reply_to_message?: TelegramMessage
  photo?: TelegramPhotoSize[]
  document?: TelegramFileRef
  video?: TelegramFileRef
  audio?: TelegramFileRef
  voice?: TelegramFileRef
  video_note?: TelegramFileRef
  animation?: TelegramFileRef
  sticker?: TelegramFileRef
}

type TelegramUpdate = {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

type TelegramCallbackQuery = {
  id: string
  from?: { id: number | string; username?: string; first_name?: string }
  message?: TelegramMessage
  chat_instance?: string
  data?: string
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

type TelegramInlineKeyboardButton = {
  text: string
  callback_data: string
}

type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][]

type ActiveTelegramTask = {
  controller: AbortController
  messageId: number
  progress?: TelegramTaskProgress
}

export type TelegramBridgeStatus = {
  stopped: boolean
  polling: boolean
  pollStartedAt?: string
  lastPollStartedAt?: string
  lastPollOkAt?: string
  lastUpdateAt?: string
  lastPollErrorAt?: string
  lastPollError?: string
  consecutivePollErrors: number
  offset: number
  activeTasks: number
  queuedChats: number
  queuedTasks: number
}

export type TelegramResearchMode =
  | 'bio'
  | 'social'
  | 'code'
  | 'pentest'
  | 'qwen'

export type TelegramGetFileResult = {
  file_id: string
  file_unique_id?: string
  file_size?: number
  file_path?: string
}

export type TelegramAttachment = {
  type: string
  fileId: string
  fileName?: string
  mimeType?: string
  size?: number
  width?: number
  height?: number
  duration?: number
  localPath?: string
  transcript?: string
  transcriptPath?: string
  encodingRepair?: string
  downloadError?: string
  transcriptionError?: string
}

export type TelegramReplyContext = {
  messageId: number
  chatId?: string
  from?: TelegramMessage['from']
  text?: string
  attachmentSummary?: string
  date?: number
}

export type TelegramSendDirective = {
  path: string
  caption?: string
  kind?: 'image' | 'document' | 'auto'
}

export type TelegramCronCreateDirective = {
  action: 'create' | 'update'
  name: string
  schedule?: string
  prompt?: string
  timezone?: string
  mode?: CronJobMode
}

export type IncomingAttachmentCandidate = {
  type: string
  file: TelegramFileRef
  width?: number
  height?: number
  duration?: number
}

export type TelegramStoredFile = {
  chatId: string
  messageId: number
  type: string
  fileId: string
  fileName?: string
  mimeType?: string
  size?: number
  localPath: string
  createdAt: string
}

type TelegramCommandHelpItem = {
  syntax: string
  description: string
  botDescription?: string
}

type TelegramCommandHelpSection = {
  title: string
  commands: TelegramCommandHelpItem[]
}

type TelegramBotCommand = {
  command: string
  description: string
}

type TelegramConversationSessions = Record<string, string>
type TelegramResearchModes = Record<string, TelegramResearchMode>

export type TelegramPentestAuthorization = {
  engagement_id: string
  name: string
  authorized: true
  authorization_statement: string
  targets: string[]
  exclusions: string[]
  allowed_actions: string[]
  mode: 'guided'
}

function telegramConversationSessionsPath(): string {
  return join(getAgentGatewayStateDir(), 'telegram-conversation-sessions.json')
}

function telegramResearchModesPath(): string {
  return join(getAgentGatewayStateDir(), 'telegram-research-modes.json')
}

export function parseTelegramPentestAuthorization(
  body: string,
): TelegramPentestAuthorization {
  const normalized = String(body || '').trim()
    .replace(/^(?:auth|authorize)\s+/iu, '')
  const parts = normalized.split('|').map(part => part.trim())
  if (parts.length < 3) {
    throw new Error(
      'Usage: /pentest auth <engagement-id> | <target[,target]> | <authorization statement> [| exclusions] [| actions]',
    )
  }
  const [engagementId, targetsText, authorizationStatement, exclusionsText, actionsText] = parts
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(engagementId || '')) {
    throw new Error('engagement-id must use lowercase letters, digits, and dashes')
  }
  const splitList = (value = '') => [...new Set(
    value.split(',').map(item => item.trim()).filter(Boolean),
  )]
  const targets = splitList(targetsText)
  if (targets.length === 0) throw new Error('at least one target is required')
  if (!authorizationStatement || authorizationStatement.length < 8) {
    throw new Error('authorization statement must be at least 8 characters')
  }
  const allowedActions = splitList(actionsText)
  return {
    engagement_id: engagementId!,
    name: `Telegram pentest: ${engagementId}`,
    authorized: true,
    authorization_statement: authorizationStatement,
    targets,
    exclusions: splitList(exclusionsText),
    allowed_actions: allowedActions.length > 0
      ? allowedActions
      : [
          'passive_recon',
          'active_scan',
          'vulnerability_validation',
          'reporting',
        ],
    mode: 'guided',
  }
}

async function runTrustedPentestAuthorization(
  input: TelegramPentestAuthorization,
  cwd: string,
): Promise<Record<string, unknown>> {
  const scriptPath = join(cwd, 'scripts', 'pentest-mcp.cjs')
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, 'authorize-json'], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (
      callback: (value: any) => void,
      value: any,
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(rejectRun, new Error('trusted pentest authorization timed out'))
    }, 15_000)
    timer.unref()
    child.stdout.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(0, 1024 * 1024)
    })
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(0, 1024 * 1024)
    })
    child.on('error', error => finish(rejectRun, error))
    child.on('close', code => {
      if (code !== 0) {
        finish(
          rejectRun,
          new Error(stderr.trim() || `authorization process exited with ${code}`),
        )
        return
      }
      try {
        finish(resolveRun, JSON.parse(stdout) as Record<string, unknown>)
      } catch {
        finish(rejectRun, new Error('authorization process returned invalid JSON'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

type RecentChatLogEntry = Record<string, unknown>

export type TelegramProviderShortcut = {
  command: string
  provider: string
  model: string
  description: string
}

const TELEGRAM_PROVIDER_SHORTCUTS: TelegramProviderShortcut[] = [
  {
    command: '/sol',
    provider: 'codex',
    model: 'gpt-5.6-sol?reasoning=medium',
    description: 'switch to Codex GPT-5.6 Sol',
  },
  {
    command: '/terra',
    provider: 'codex',
    model: 'gpt-5.6-terra?reasoning=medium',
    description: 'switch to Codex GPT-5.6 Terra',
  },
  {
    command: '/luna',
    provider: 'codex',
    model: 'gpt-5.6-luna?reasoning=medium',
    description: 'switch to Codex GPT-5.6 Luna',
  },
  {
    command: '/gpt55',
    provider: 'codex',
    model: 'gpt-5.5?reasoning=medium',
    description: 'switch to Codex GPT-5.5',
  },
  {
    command: '/codex',
    provider: 'codex',
    model: 'gpt-5.6-sol?reasoning=medium',
    description: 'switch to Codex GPT-5.6 Sol',
  },
  {
    command: '/dsflash',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    description: 'switch to DeepSeek V4 Flash',
  },
  {
    command: '/dspro',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    description: 'switch to DeepSeek V4 Pro',
  },
  {
    command: '/gemma',
    provider: 'lmstudio-lan',
    model: 'gemma-4-12b-obliterated',
    description: 'switch to LM Studio Gemma 4 12B Obliterated',
  },
  {
    command: '/gemmacoder',
    provider: 'lmstudio-lan',
    model: 'huihui-gemma-4-12b-coder-fable5-composer2.5-v1-abliterated',
    description: 'switch to LM Studio Huihui Gemma Coder',
  },
  {
    command: '/omni',
    provider: 'omniroute',
    model: 'auto',
    description: 'switch to OmniRoute automatic routing',
  },
  {
    command: '/omnicode',
    provider: 'omniroute',
    model: 'auto/coding',
    description: 'switch to OmniRoute coding routing',
  },
  {
    command: '/omnifast',
    provider: 'omniroute',
    model: 'auto/fast',
    description: 'switch to OmniRoute fast routing',
  },
  {
    command: '/omnicheap',
    provider: 'omniroute',
    model: 'auto/cheap',
    description: 'switch to OmniRoute low-cost routing',
  },
  {
    command: '/omnismart',
    provider: 'omniroute',
    model: 'auto/smart',
    description: 'switch to OmniRoute smart routing',
  },
  {
    command: '/omnioffline',
    provider: 'omniroute',
    model: 'auto/offline',
    description: 'switch to OmniRoute offline routing',
  },
]

const TELEGRAM_COMMAND_HELP_SECTIONS: TelegramCommandHelpSection[] = [
  {
    title: 'Basics',
    commands: [
      { syntax: '/help', description: 'show this command reference', botDescription: 'Show Telegram control help' },
      { syntax: '/commands', description: 'show this command reference' },
      { syntax: '/panel', description: 'open the button control panel', botDescription: 'Open agent control panel' },
      { syntax: '/control', description: 'open the button control panel' },
      { syntax: '/newchat', description: 'reset chat context; keep durable memory', botDescription: 'Start a new chat context' },
      { syntax: '/chatid', description: 'show the current chat ID' },
      { syntax: '/status', description: 'show gateway and worker status' },
      { syntax: '/transcribe', description: 'show audio transcription status' },
    ],
  },
  {
    title: 'MCP servers',
    commands: [
      { syntax: '/mcp', description: 'open the MCP server control panel', botDescription: 'Manage MCP servers' },
      { syntax: '/mcp add <json>', description: 'import mcpServers JSON' },
      { syntax: '/mcp enable <name>', description: 'enable an MCP server' },
      { syntax: '/mcp disable <name>', description: 'disable an MCP server' },
      { syntax: '/mcp remove <name>', description: 'remove an MCP server' },
    ],
  },
  {
    title: 'Android',
    commands: [
      { syntax: '/android', description: 'manage Android devices', botDescription: 'Manage Android MCP devices' },
    ],
  },
  {
    title: 'Skill Store',
    commands: [
      { syntax: '/skills', description: 'browse the Skill Store', botDescription: 'Browse and create agent skills' },
      { syntax: '/skill [name]', description: 'open a skill card by name' },
      { syntax: '/skill create <json>', description: 'create a persistent SKILL.md' },
      { syntax: '/skill create <name> | <description> | <instructions>', description: 'create a skill' },
      { syntax: '/skill delete <name>', description: 'remove a user-created Store skill' },
    ],
  },
  {
    title: 'Inference',
    commands: [
      { syntax: '/provider', description: 'show provider, model, and API endpoint', botDescription: 'Show or switch provider/model' },
      { syntax: '/provider models', description: 'load models from the active endpoint' },
      { syntax: '/provider set <provider> <model> [base_url] [api_key]', description: 'switch provider and model' },
      ...TELEGRAM_PROVIDER_SHORTCUTS.map(shortcut => ({
        syntax: shortcut.command,
        description: shortcut.description,
      })),
      { syntax: '/context', description: 'show active context window', botDescription: 'Show or set context window' },
      { syntax: '/context auto|1m|<tokens>', description: 'set context window or auto mode' },
      { syntax: '/models', description: 'open the model picker for the active provider', botDescription: 'Choose provider model' },
      { syntax: '/model [model]', description: 'pick or set a model' },
      { syntax: '/reasoning [level]', description: 'set low, medium, high, xhigh, max, or ultra', botDescription: 'Choose reasoning level' },
      { syntax: '/baseurl <url>', description: 'set OpenAI-compatible base URL' },
      { syntax: '/apikey <key>', description: 'store a provider API key' },
      { syntax: '/subagents [...]', description: 'manage subagent routes', botDescription: 'Manage subagent routing' },
      { syntax: '/delegate <role> <task>', description: 'delegate a task', botDescription: 'Delegate a task to a subagent' },
    ],
  },
  {
    title: 'Research modes',
    commands: [
      { syntax: '/bio [prompt]', description: 'biology scientist mode for research tasks', botDescription: 'Biology research mode' },
      { syntax: '/social [prompt]', description: 'defensive social-engineering analysis mode' },
      { syntax: '/code [prompt]', description: 'scientific coding, MVP, and test-building mode' },
      { syntax: '/pentest [prompt|auth id|targets|proof]', description: 'pentest mode', botDescription: 'Authorized pentest mode' },
      { syntax: '/qwen [prompt]', description: 'Qwen3.8 Max collaboration', botDescription: 'Use Qwen3.8 Max collaborator' },
      { syntax: '/mode off', description: 'clear the active research mode for this chat' },
    ],
  },
  {
    title: 'Tasks and files',
    commands: [
      { syntax: '/stop', description: 'abort the current running task' },
      { syntax: '/retry', description: 'retry the last task with the same prompt' },
      { syntax: '/files', description: 'list recent files downloaded from this chat' },
      { syntax: '/errors [n]', description: 'show recent Telegram/gateway errors' },
    ],
  },
  {
    title: 'Cron',
    commands: [
      { syntax: '/schedule every 1h | prompt', description: 'create a cron job that replies here' },
      { syntax: '/cron [...]', description: 'manage cron jobs' },
      { syntax: '/jobs', description: 'list jobs created for this chat' },
      { syntax: '/runjob <id>', description: 'trigger a scheduled job now' },
      { syntax: '/pausejob <id>', description: 'pause a scheduled job' },
      { syntax: '/resumejob <id>', description: 'resume a paused job' },
      { syntax: '/deletejob <id>', description: 'delete a job permanently' },
    ],
  },
  {
    title: 'Runtime control',
    commands: [
      { syntax: '/restart', description: 'soft-restart the gateway runtime' },
      { syntax: '/panic', description: 'stop tasks and gateway runtime' },
      { syntax: '/bg [start|stop|now|status]', description: 'control background consciousness' },
      { syntax: '/consciousness [start|stop|now|status]', description: 'alias for /bg' },
      { syntax: '/evolution [on|off|status]', description: 'control scheduled evolution cycles' },
      { syntax: '/evolve [on|off|now|status]', description: 'control evolution or run one cycle' },
      { syntax: '/tools [on|off|list|enable NAME|disable NAME]', description: 'toggle model tools', botDescription: 'Control model tools' },
      { syntax: '/review', description: 'run a deep architecture review cycle' },
      { syntax: '/infinite <goal>', description: 'run a persistent task loop' },
    ],
  },
  {
    title: 'Memory',
    commands: [
      { syntax: '/identity', description: 'show current identity' },
      { syntax: '/scratchpad', description: 'show working memory' },
      { syntax: '/bible', description: 'show Constitution (BIBLE.md)' },
      { syntax: '/architecture', description: 'show architecture doc' },
      { syntax: '/git', description: 'show git command help' },
      { syntax: '/git status', description: 'show git status' },
      { syntax: '/git log', description: 'show recent commits' },
      { syntax: '/git diff [path]', description: 'show uncommitted changes' },
      { syntax: '/git commit <msg>', description: 'stage and commit all changes' },
      { syntax: '/undo', description: 'revert the last git commit with a hard reset' },
    ],
  },
]

export function buildTelegramHelpText(
  config: Pick<AgentGatewayConfig, 'api' | 'openWebUI' | 'openRAG'> = getDefaultAgentGatewayConfig(),
): string {
  const lines = [
    'OpenClaude Telegram inference is online.',
    '',
    'Commands:',
  ]

  for (const section of TELEGRAM_COMMAND_HELP_SECTIONS) {
    lines.push('', `${section.title}:`)
    for (const command of section.commands) {
      if (command.syntax === '/help') {
        lines.push('/help|commands - command reference')
        continue
      }
      if (command.syntax === '/commands') continue
      if (command.syntax === '/panel') {
        lines.push('/panel|control - button control panel')
        continue
      }
      if (command.syntax === '/control') continue
      if (command.syntax === '/context') continue
      if (command.syntax.startsWith('/omni')) {
        if (command.syntax !== '/omni') continue
        lines.push('/omni* - OmniRoute modes: auto,code,fast,cheap,smart,offline')
        continue
      }
      lines.push(`${command.syntax} - ${command.description}`)
    }
  }

  const links = getAgentGatewayWebLinks(config)
  lines.push(
    '',
    'Web consoles:',
    `Tool Router: ${links.toolRouter}`,
    `Open WebUI: ${links.openWebUI}`,
    `Hindsight: ${links.hindsight}`,
    `OpenRAG: ${links.openRAG}`,
    `Telegram MCP: ${links.telegramMcp}`,
    `File Manager: ${links.fileManager}`,
    `OmniRoute: ${links.omniRoute}`,
  )

  return lines.join('\n')
}

export function buildTelegramBotCommands(): TelegramBotCommand[] {
  const commands = new Map<string, string>()
  for (const section of TELEGRAM_COMMAND_HELP_SECTIONS) {
    for (const item of section.commands) {
      const command = parseTelegramBotCommandName(item.syntax)
      if (!command || commands.has(command)) continue
      commands.set(command, item.botDescription || item.description)
    }
  }

  return [...commands.entries()]
    .slice(0, 100)
    .map(([command, description]) => ({
      command,
      description: description.slice(0, 256),
    }))
}

export function getTelegramProviderShortcut(commandText: string): TelegramProviderShortcut | undefined {
  const command = commandText
    .trim()
    .split(/\s+/u)[0]
    ?.replace(/@[A-Za-z0-9_]+$/u, '')
    .toLowerCase()
  if (!command) return undefined
  return TELEGRAM_PROVIDER_SHORTCUTS.find(shortcut => shortcut.command === command)
}

function parseTelegramBotCommandName(syntax: string): string | undefined {
  const command = syntax.trim().split(/\s+/, 1)[0]?.replace(/^\//, '')
  if (!command || !/^[a-z0-9_]{1,32}$/.test(command)) return undefined
  return command
}

export class TelegramAgentBridge {
  private readonly config: AgentGatewayConfig
  private stopped = false
  private pollAbortController: AbortController | undefined
  private pollPromise: Promise<void> | undefined
  private offset = 0
  private pollLoopRunning = false
  private pollStartedAt: string | undefined
  private lastPollStartedAt: string | undefined
  private lastPollOkAt: string | undefined
  private lastUpdateAt: string | undefined
  private lastPollErrorAt: string | undefined
  private lastPollError: string | undefined
  private consecutivePollErrors = 0
  /** Active AbortControllers per chatId — for /stop */
  private activeTasks = new Map<string, ActiveTelegramTask>()
  /** FIFO agent task queue per chatId. Commands still run immediately. */
  private taskQueues = new Map<string, Promise<void>>()
  private queuedTaskCounts = new Map<string, number>()
  private chatQueueEpochs = new Map<string, number>()
  private queueEpoch = 0
  private chatModes = new Map<string, TelegramResearchMode>()
  /** Last prompt per chatId — for /retry */
  private lastPrompts = new Map<string, {
    prompt: string
    messageId: number
    toolPolicy?: 'pentest'
  }>()
  private chatSessions = new Map<string, string>()
  private chatSessionsLoaded: Promise<void> | undefined
  private chatSessionsWrite = Promise.resolve()
  private chatModesLoaded: Promise<void> | undefined
  private chatModesWrite = Promise.resolve()

  constructor(config: AgentGatewayConfig) {
    this.config = config
  }

  start(): void {
    if (!this.config.telegram.enabled || !this.config.telegram.botToken) return
    void this.ensureChatModesLoaded()
    void this.registerBotCommands()
    this.pollAbortController = new AbortController()
    this.pollPromise = this.pollLoop(this.pollAbortController.signal).catch(error => {
      this.pollLoopRunning = false
      this.lastPollErrorAt = new Date().toISOString()
      this.lastPollError = summarizeTelegramError(error)
      void recordTelegramError('system', 'telegram-poll-fatal', error)
    })
  }

  getStatus(): TelegramBridgeStatus {
    const queuedTasks = [...this.queuedTaskCounts.values()]
      .reduce((total, count) => total + count, 0)
    return {
      stopped: this.stopped,
      polling: this.pollLoopRunning && !this.stopped,
      pollStartedAt: this.pollStartedAt,
      lastPollStartedAt: this.lastPollStartedAt,
      lastPollOkAt: this.lastPollOkAt,
      lastUpdateAt: this.lastUpdateAt,
      lastPollErrorAt: this.lastPollErrorAt,
      lastPollError: this.lastPollError,
      consecutivePollErrors: this.consecutivePollErrors,
      offset: this.offset,
      activeTasks: this.activeTasks.size,
      queuedChats: this.taskQueues.size,
      queuedTasks,
    }
  }

  private async registerBotCommands(): Promise<void> {
    try {
      await this.callTelegram('setMyCommands', {
        commands: buildTelegramBotCommands(),
      })
    } catch {
      // Command menu registration is best-effort; polling still matters.
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.queueEpoch++
    this.pollAbortController?.abort()
    for (const task of this.activeTasks.values()) {
      task.progress?.dispose()
      task.controller.abort()
    }
    const pending = [
      ...(this.pollPromise ? [this.pollPromise] : []),
      ...this.taskQueues.values(),
    ]
    this.activeTasks.clear()
    this.taskQueues.clear()
    this.queuedTaskCounts.clear()
    this.chatQueueEpochs.clear()
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        sleep(getTelegramShutdownTimeoutMs()),
      ])
    }
    this.pollPromise = undefined
    this.pollAbortController = undefined
  }

  private async ensureChatSessionsLoaded(): Promise<void> {
    if (!this.chatSessionsLoaded) {
      this.chatSessionsLoaded = (async () => {
        try {
          const raw = await readFile(telegramConversationSessionsPath(), 'utf8')
          const parsed = JSON.parse(raw) as TelegramConversationSessions
          for (const [chatId, sessionId] of Object.entries(parsed)) {
            if (typeof sessionId === 'string' && sessionId) {
              this.chatSessions.set(chatId, sessionId)
            }
          }
        } catch {
          // No stored session means this chat keeps its existing transcript.
        }
      })()
    }
    await this.chatSessionsLoaded
  }

  private async getChatSessionId(chatId: string): Promise<string | undefined> {
    await this.ensureChatSessionsLoaded()
    return this.chatSessions.get(chatId)
  }

  private async ensureChatModesLoaded(): Promise<void> {
    if (!this.chatModesLoaded) {
      this.chatModesLoaded = (async () => {
        try {
          const raw = await readFile(telegramResearchModesPath(), 'utf8')
          const parsed = JSON.parse(raw) as TelegramResearchModes
          for (const [chatId, mode] of Object.entries(parsed)) {
            if (mode === 'bio' || mode === 'social' || mode === 'code' || mode === 'pentest') {
              this.chatModes.set(chatId, mode)
            }
          }
        } catch {
          // No stored mode means the chat starts in normal mode.
        }
      })()
    }
    await this.chatModesLoaded
  }

  private async getChatMode(chatId: string): Promise<TelegramResearchMode | undefined> {
    await this.ensureChatModesLoaded()
    return this.chatModes.get(chatId)
  }

  private async setChatMode(
    chatId: string,
    mode: TelegramResearchMode | undefined,
  ): Promise<void> {
    await this.ensureChatModesLoaded()
    if (mode) this.chatModes.set(chatId, mode)
    else this.chatModes.delete(chatId)
    const snapshot = JSON.stringify(Object.fromEntries(this.chatModes), null, 2)
    this.chatModesWrite = this.chatModesWrite
      .catch(() => {})
      .then(async () => {
        await mkdir(getAgentGatewayStateDir(), { recursive: true })
        await writeFile(telegramResearchModesPath(), `${snapshot}\n`, 'utf8')
      })
    await this.chatModesWrite
  }

  private async persistChatSessions(): Promise<void> {
    const snapshot = JSON.stringify(Object.fromEntries(this.chatSessions), null, 2)
    this.chatSessionsWrite = this.chatSessionsWrite
      .catch(() => {})
      .then(async () => {
        await mkdir(getAgentGatewayStateDir(), { recursive: true })
        await writeFile(telegramConversationSessionsPath(), `${snapshot}\n`, 'utf8')
      })
    await this.chatSessionsWrite
  }

  private async handleNewChatCommand(chatId: string): Promise<void> {
    const task = this.activeTasks.get(chatId)
    this.invalidateChatQueue(chatId)
    await this.setChatMode(chatId, undefined)
    this.lastPrompts.delete(chatId)

    if (task) {
      task.controller.abort()
      task.progress?.dispose()
      this.activeTasks.delete(chatId)
      try {
        await this.callTelegram('editMessageText', {
          chat_id: chatId,
          message_id: task.messageId,
          text: 'Task stopped: new chat context started.',
        })
      } catch {
        // The progress message may already be complete or deleted.
      }
    }

    await this.ensureChatSessionsLoaded()
    this.chatSessions.set(chatId, randomUUID())
    await this.persistChatSessions()
    await this.sendMessage(
      chatId,
      'New chat context started. Previous dialogue history and queued tasks are cleared for future requests; durable memory, files, cron jobs, provider settings, and RPG records are unchanged.',
    )
  }

  async sendHomeMessage(text: string): Promise<void> {
    const chatId = this.config.telegram.homeChatId
    if (!chatId) return
    await this.sendMessage(chatId, text)
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const chunks = splitTelegramText(text)
    for (const chunk of chunks) {
      await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      })
    }
  }

  private async sendMessageWithKeyboard(
    chatId: string,
    text: string,
    inlineKeyboard: TelegramInlineKeyboard,
  ): Promise<void> {
    const chunks = splitTelegramText(text)
    for (let index = 0; index < chunks.length; index++) {
      await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: chunks[index]!,
        disable_web_page_preview: true,
        ...(index === chunks.length - 1
          ? { reply_markup: { inline_keyboard: inlineKeyboard } }
          : {}),
      })
    }
  }

  private async editCallbackMessage(
    query: TelegramCallbackQuery,
    text: string,
    inlineKeyboard: TelegramInlineKeyboard,
  ): Promise<void> {
    const chatId = query.message?.chat?.id
    const messageId = query.message?.message_id
    if (chatId === undefined || !messageId) return

    await this.callTelegram('editMessageText', {
      chat_id: String(chatId),
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: inlineKeyboard },
    })
  }

  private async sendChatAction(
    chatId: string,
    action: 'typing' | 'upload_photo' | 'upload_document' = 'typing',
  ): Promise<void> {
    await this.callTelegram('sendChatAction', {
      chat_id: chatId,
      action,
    })
  }

  private startTypingLoop(
    chatId: string,
    signal?: AbortSignal,
  ): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      if (stopped || signal?.aborted) return
      try {
        await this.sendChatAction(chatId, 'typing')
      } catch {
        // Chat actions are best-effort; the actual response still matters.
      }
      if (!stopped && !signal?.aborted) {
        timer = setTimeout(tick, 4_000)
      }
    }

    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }

  private async createTaskProgress(
    chatId: string,
    phase: string,
    signal?: AbortSignal,
  ): Promise<TelegramTaskProgress> {
    const providerProfile = await loadProviderProfile()
    const startedAt = Date.now()
    const response = await this.callTelegram<any>('sendMessage', {
      chat_id: chatId,
      text: formatTelegramProgressText({
        status: 'running',
        phase,
        startedAt,
        events: [],
        providerProfile,
      }),
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Stop', callback_data: `stop:${chatId}` },
        ]],
      },
    })
    const messageId = response?.message_id ?? response?.result?.message_id ?? 0
    const stopTyping = this.startTypingLoop(chatId, signal)
    return new TelegramTaskProgress({
      messageId,
      phase,
      startedAt,
      providerProfile,
      stopTyping,
      edit: async text => {
        if (!messageId) return
        await this.callTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Stop', callback_data: `stop:${chatId}` },
            ]],
          },
        })
      },
    })
  }

  private async runAgentWithProgress(
    chatId: string,
    prompt: string,
    phase = 'Running agent',
    options?: {
      suppressObservers?: boolean
      toolPolicy?: 'pentest'
    },
  ): Promise<AgentRunResult> {
    if (this.activeTasks.has(chatId)) {
      throw new Error('A task is already running. Use /stop first.')
    }

    const controller = new AbortController()
    const progress = await this.createTaskProgress(chatId, phase, controller.signal)
    this.activeTasks.set(chatId, {
      controller,
      messageId: progress.messageId,
      progress,
    })

    let result: AgentRunResult | undefined
    try {
      result = await this.runAgentWithRecovery({
        chatId,
        prompt,
        phase,
        controller,
        progress,
        suppressObservers: options?.suppressObservers,
        toolPolicy: options?.toolPolicy,
      })
    } finally {
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
    }

    if (!result) {
      progress.dispose()
      throw new Error('Agent run did not return a result.')
    }

    if (controller.signal.aborted) {
      progress.dispose()
    } else if (result.exitCode === 0) {
      await progress.finish('completed', 'Done. Sending response.')
    } else {
      await progress.finish('failed', formatAgentFailurePhase(result))
    }

    return result
  }

  private async runAgentWithRecovery(input: {
    chatId: string
    prompt: string
    phase: string
    controller: AbortController
    progress: TelegramTaskProgress
    suppressObservers?: boolean
    toolPolicy?: 'pentest'
  }): Promise<AgentRunResult> {
    const recovery = getTelegramAgentRecoveryAttemptLimit()
    let recoveryAttempt = 0
    let currentPrompt = input.prompt
    const repeatedFailures = new Map<string, number>()
    const failureKindCounts = new Map<string, number>()
    let verificationAttempts = 0
    let verificationPending = false
    const completionPasses: AgentRunResult[] = []

    while (true) {
      const isRecovery = recoveryAttempt > 0
      const isVerification = verificationPending
      verificationPending = false
      input.progress.setPhase(
        isVerification
          ? 'Verifying implementation and final diff'
          : isRecovery
          ? formatTelegramRecoveryPhase(recoveryAttempt, recovery.maxRecoveryAttempts)
          : input.phase,
      )
      if (isVerification) {
        input.progress.addEvent('coding completion gate: verifier pass')
      } else if (isRecovery) {
        input.progress.addEvent(
          `recovery attempt ${recoveryAttempt}${recovery.maxRecoveryAttempts === null ? '' : `/${recovery.maxRecoveryAttempts}`}`,
        )
      }

      const startedAt = Date.now()
      let result = await runOpenClaudeAgent({
        prompt: currentPrompt,
        config: this.config,
        signal: input.controller.signal,
        suppressObservers: input.suppressObservers,
        toolPolicy: input.toolPolicy,
        streamEvents: true,
        onProgress: event => input.progress.addEvent(event),
        onStdout: chunk => input.progress.observeStdout(chunk),
      }).catch(error => buildAgentExceptionResult(error, Date.now() - startedAt))

      if (input.controller.signal.aborted) {
        return result
      }
      if (result.exitCode === 0) {
        completionPasses.push(result)
        result = mergeAgentRunResults(completionPasses)
        const completionGap = getCodingCompletionGap(input.prompt, result)
        if (completionGap) {
          if (verificationAttempts < 2) {
            verificationAttempts += 1
            verificationPending = true
            currentPrompt = buildCodingVerificationPrompt({
              originalPrompt: input.prompt,
              previousResult: result,
              gap: completionGap,
            })
            continue
          }
          result = buildCodingCompletionFailure(result, completionGap)
        } else {
          return result
        }
      }

      await recordTelegramError(
        input.chatId,
        recoveryAttempt === 0 ? 'agent-run-attempt' : `agent-run-recovery-${recoveryAttempt}`,
        result,
      )

      if (!shouldRetryTelegramAgentFailure(result)) {
        return withNonRetryableFailureDiagnostic(result)
      }

      const signature = getAgentRecoveryFailureSignature(result)
      const repeatedCount = (repeatedFailures.get(signature) ?? 0) + 1
      repeatedFailures.set(signature, repeatedCount)
      const failureKind = result.failureKind || 'unknown'
      const failureKindCount = (failureKindCounts.get(failureKind) ?? 0) + 1
      failureKindCounts.set(failureKind, failureKindCount)
      if (repeatedCount >= getTelegramAgentRepeatedFailureLimit()) {
        return withRepeatedFailureDiagnostic(result, repeatedCount)
      }
      if (failureKindCount >= getTelegramAgentFailureKindLimit()) {
        return withFailureKindLimitDiagnostic(
          result,
          failureKind,
          failureKindCount,
        )
      }

      if (
        recovery.maxRecoveryAttempts !== null
        && recoveryAttempt >= recovery.maxRecoveryAttempts
      ) {
        return result
      }

      recoveryAttempt += 1
      if (result.failureKind === 'quality_gate') {
        verificationAttempts = 0
      }
      const backoffMs = getTelegramRecoveryBackoffMs(
        result,
        recoveryAttempt,
      )
      if (backoffMs > 0) {
        input.progress.addEvent(
          `recovery backoff: ${formatDuration(backoffMs)}`,
        )
        const completedDelay = await delayWithAbort(
          backoffMs,
          input.controller.signal,
        )
        if (!completedDelay) return result
      }
      currentPrompt = buildTelegramAgentRecoveryPrompt({
        originalPrompt: input.prompt,
        previousResult: result,
        recoveryAttempt,
        maxRecoveryAttempts: recovery.maxRecoveryAttempts,
      })
    }
  }

  private async enqueueChatTask(
    chatId: string,
    label: string,
    run: () => Promise<void>,
  ): Promise<void> {
    const waitingBefore = this.queuedTaskCounts.get(chatId) ?? 0
    const limits = getTelegramQueueLimits()
    const waitingTotal = [...this.queuedTaskCounts.values()]
      .reduce((total, count) => total + count, 0)
    if (
      waitingBefore >= limits.perChat
      || waitingTotal >= limits.global
    ) {
      await this.sendMessage(
        chatId,
        `Queue is full (${waitingBefore}/${limits.perChat} for this chat, ${waitingTotal}/${limits.global} globally). Wait for an active task or use /stop to clear this chat queue.`,
      )
      return
    }
    const epoch = this.getChatQueueEpoch(chatId)
    const position = getTelegramQueuePosition({
      active: this.activeTasks.has(chatId),
      waiting: waitingBefore,
    })
    this.queuedTaskCounts.set(chatId, waitingBefore + 1)

    if (position > 0) {
      await this.sendMessage(chatId, formatTelegramQueueNotice(position, label))
    }

    const previous = this.taskQueues.get(chatId) ?? Promise.resolve()
    const next = previous
      .catch(() => {
        // The previous task already reported its own error. Keep the FIFO alive.
      })
      .then(async () => {
        if (epoch !== this.getChatQueueEpoch(chatId) || this.stopped) return
        const remaining = Math.max(
          0,
          (this.queuedTaskCounts.get(chatId) ?? 1) - 1,
        )
        if (remaining === 0) this.queuedTaskCounts.delete(chatId)
        else this.queuedTaskCounts.set(chatId, remaining)

        if (position > 0) {
          await this.sendMessage(chatId, `Starting queued task: ${label}`)
        }
        await run()
      })

    let tracked: Promise<void>
    tracked = next.finally(() => {
      if (this.taskQueues.get(chatId) === tracked) {
        this.taskQueues.delete(chatId)
      }
      if ((this.queuedTaskCounts.get(chatId) ?? 0) <= 0) {
        this.queuedTaskCounts.delete(chatId)
      }
    })
    this.taskQueues.set(chatId, tracked)
    await tracked
  }

  private getChatQueueEpoch(chatId: string): string {
    return `${this.queueEpoch}:${this.chatQueueEpochs.get(chatId) ?? 0}`
  }

  private invalidateChatQueue(chatId: string): void {
    this.chatQueueEpochs.set(chatId, (this.chatQueueEpochs.get(chatId) ?? 0) + 1)
    this.queuedTaskCounts.delete(chatId)
  }

  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string,
    kind: TelegramSendDirective['kind'] = 'auto',
  ): Promise<void> {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      throw new Error(`Not a file: ${filePath}`)
    }
    if (fileStat.size > this.config.telegram.maxUploadBytes) {
      throw new Error(
        `file is larger than maxUploadBytes (${fileStat.size} > ${this.config.telegram.maxUploadBytes})`,
      )
    }

    const isImage = kind === 'image' || (kind !== 'document' && isTelegramPhotoFile(filePath))
    await this.sendMultipart(
      isImage ? 'sendPhoto' : 'sendDocument',
      chatId,
      isImage ? 'photo' : 'document',
      filePath,
      caption,
    )
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    this.pollLoopRunning = true
    this.pollStartedAt = new Date().toISOString()
    try {
      while (!this.stopped && !signal.aborted) {
        try {
          this.lastPollStartedAt = new Date().toISOString()
          const updates = await this.getUpdates(signal)
          this.lastPollOkAt = new Date().toISOString()
          this.consecutivePollErrors = 0
          if (updates.length > 0) this.lastUpdateAt = this.lastPollOkAt
          for (const update of updates) {
            this.offset = Math.max(this.offset, update.update_id + 1)
            if (update.callback_query) {
              await this.handleCallbackQuery(update.callback_query)
            }
            if (update.message) {
              this.handleMessageUpdateInBackground(update)
            }
          }
        } catch (error) {
          if (this.stopped || signal.aborted) break
          this.consecutivePollErrors++
          this.lastPollErrorAt = new Date().toISOString()
          this.lastPollError = summarizeTelegramError(error)
          if (this.consecutivePollErrors === 1 || this.consecutivePollErrors % 12 === 0) {
            await recordTelegramError('system', 'telegram-poll', error)
          }
          await sleep(5_000)
        }
      }
    } finally {
      this.pollLoopRunning = false
    }
  }

  private handleMessageUpdateInBackground(update: TelegramUpdate): void {
    void this.handleUpdate(update).catch(error => {
      void this.reportMessageUpdateError(update, error).catch(() => {})
    })
  }

  private async reportMessageUpdateError(update: TelegramUpdate, error: unknown): Promise<void> {
    const message = update.message
    const chatId = message?.chat?.id === undefined ? '' : String(message.chat.id)
    if (!message || !chatId || !this.isMessageAllowed(message, chatId)) return

    const detail = error instanceof Error ? error.message : String(error)
    await recordTelegramError(chatId, 'telegram-message', detail)
    await this.sendMessage(chatId, `Telegram bridge error: ${detail}`)
  }

  private async getUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const token = this.config.telegram.botToken
    if (!token) return []

    const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`)
    url.searchParams.set('timeout', '30')
    url.searchParams.set('allowed_updates', JSON.stringify(['message', 'callback_query']))
    if (this.offset) url.searchParams.set('offset', String(this.offset))

    const response = await fetch(url, {
      signal: combineAbortSignals(signal, getTelegramFetchTimeoutMs('getUpdates')),
    })
    const data = await response.json() as TelegramApiResponse<TelegramUpdate[]>
    if (!data.ok) {
      throw new Error(data.description || 'Telegram getUpdates failed')
    }
    return data.result || []
  }

  private async acknowledgeTelegramUpdates(): Promise<void> {
    const token = this.config.telegram.botToken
    if (!token || !this.offset) return

    try {
      const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`)
      url.searchParams.set('timeout', '0')
      url.searchParams.set('offset', String(this.offset))
      await fetch(url, {
        signal: AbortSignal.timeout(getTelegramFetchTimeoutMs('getUpdates')),
      })
    } catch {
      // Best effort. Restart/stop should not fail because Telegram ack failed.
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    const text = getTelegramMessageText(message)
    const chatId = message?.chat?.id === undefined ? '' : String(message.chat.id)
    if (!message || !chatId) return
    if (!this.isMessageAllowed(message, chatId)) return
    const commandText = normalizeTelegramCommand(text)

    if (commandText === '/start' || commandText === '/help' || commandText === '/commands') {
      await this.sendMessageWithKeyboard(
        chatId,
        buildTelegramHelpText(this.config),
        buildTelegramControlKeyboard(),
      )
      return
    }

    if (commandText === '/panel' || commandText === '/control') {
      await this.sendControlPanel(chatId)
      return
    }

    if (commandText === '/newchat') {
      await this.handleNewChatCommand(chatId)
      return
    }

    if (text === '/chatid') {
      await this.sendMessage(chatId, `Chat ID: ${chatId}`)
      return
    }

    if (text === '/transcribe') {
      await this.handleTranscribeStatusCommand(chatId)
      return
    }

    if (commandText === '/status') {
      await this.handleStatusCommand(chatId)
      return
    }

    const providerShortcut = getTelegramProviderShortcut(commandText)
    if (providerShortcut) {
      await this.handleProviderShortcutCommand(chatId, providerShortcut)
      return
    }

    if (commandText === '/subagents' || commandText.startsWith('/subagents ')) {
      await this.handleSubagentsCommand(
        chatId,
        getTelegramCommandBody(text, 'subagents'),
      )
      return
    }

    if (commandText === '/delegate' || commandText.startsWith('/delegate ')) {
      await this.handleDelegateCommand(
        chatId,
        message,
        getTelegramCommandBody(text, 'delegate'),
      )
      return
    }

    if (commandText === '/provider' || commandText.startsWith('/provider ')) {
      await this.handleProviderCommand(
        chatId,
        commandText.slice('/provider'.length).trim(),
      )
      return
    }

    if (commandText === '/mcp' || commandText.startsWith('/mcp ')) {
      await this.handleMcpCommand(chatId, getTelegramCommandBody(text, 'mcp'))
      return
    }

    if (commandText === '/android' || commandText.startsWith('/android ')) {
      await this.handleAndroidCommand(
        chatId,
        getTelegramCommandBody(text, 'android'),
      )
      return
    }

    if (
      commandText === '/skills'
      || commandText === '/skillstore'
      || commandText === '/skill'
      || commandText.startsWith('/skill ')
    ) {
      await this.handleSkillCommand(
        chatId,
        commandText === '/skills' || commandText === '/skillstore'
          ? ''
          : getTelegramCommandBody(text, 'skill'),
      )
      return
    }

    if (commandText === '/models') {
      await this.handleModelCommand(chatId, '')
      return
    }

    if (commandText === '/context' || commandText.startsWith('/context ')) {
      await this.handleContextCommand(chatId, commandText.slice('/context'.length).trim())
      return
    }

    if (commandText === '/mode off') {
      await this.setChatMode(chatId, undefined)
      await this.sendMessage(chatId, 'Research mode cleared for this chat.')
      return
    }

    const researchMode = getTelegramResearchMode(commandText)
    if (researchMode) {
      await this.handleResearchModeCommand(
        chatId,
        message,
        researchMode,
        commandText.slice(`/${researchMode}`.length).trim(),
      )
      return
    }

    if (commandText === '/model' || commandText.startsWith('/model ')) {
      await this.handleModelCommand(
        chatId,
        commandText.slice('/model'.length).trim(),
      )
      return
    }

    if (commandText === '/reasoning' || commandText.startsWith('/reasoning ')) {
      await this.handleReasoningCommand(
        chatId,
        commandText.slice('/reasoning'.length).trim(),
      )
      return
    }

    if (text.startsWith('/baseurl ')) {
      await this.handleBaseUrlCommand(chatId, text.slice('/baseurl '.length))
      return
    }

    if (text.startsWith('/apikey ')) {
      await this.handleApiKeyCommand(chatId, text.slice('/apikey '.length))
      return
    }

    if (text === '/errors' || text.startsWith('/errors ')) {
      await this.handleErrorsCommand(chatId, text.slice('/errors'.length).trim())
      return
    }

    if (commandText === '/panic') {
      await this.handlePanicCommand(chatId)
      return
    }

    if (commandText === '/restart') {
      await this.handleRestartCommand(chatId)
      return
    }

    if (commandText === '/review') {
      await this.handleReviewCommand(chatId)
      return
    }

    if (commandText === '/tools' || commandText.startsWith('/tools ')) {
      await this.handleToolsCommand(chatId, commandText.slice('/tools'.length).trim())
      return
    }

    if (commandText === '/bg' || commandText.startsWith('/bg ')) {
      await this.handleBgCommand(chatId, commandText.slice('/bg'.length).trim())
      return
    }

    if (commandText === '/consciousness' || commandText.startsWith('/consciousness ')) {
      await this.handleBgCommand(
        chatId,
        commandText.slice('/consciousness'.length).trim(),
      )
      return
    }

    if (commandText === '/evolution' || commandText.startsWith('/evolution ')) {
      await this.handleEvolutionModeCommand(
        chatId,
        commandText.slice('/evolution'.length).trim(),
      )
      return
    }

    if (commandText === '/evolve' || commandText.startsWith('/evolve ')) {
      await this.handleEvolveCommand(chatId, commandText.slice('/evolve'.length).trim())
      return
    }

    if (text === '/cron' || text.startsWith('/cron ')) {
      await this.handleCronCommand(chatId, text.slice('/cron'.length).trim())
      return
    }

    if (text.startsWith('/schedule ')) {
      await this.handleScheduleCommand(chatId, text.slice('/schedule '.length))
      return
    }

    if (text === '/jobs') {
      await this.handleJobsCommand(chatId)
      return
    }

    if (text === '/files') {
      await this.handleFilesCommand(chatId)
      return
    }

    if (text.startsWith('/runjob ')) {
      await this.handleRunJobCommand(chatId, text.slice('/runjob '.length))
      return
    }

    if (text.startsWith('/deletejob ')) {
      await this.handleDeleteJobCommand(chatId, text.slice('/deletejob '.length))
      return
    }

    if (text.startsWith('/pausejob ')) {
      await this.handlePauseJobCommand(chatId, text.slice('/pausejob '.length))
      return
    }

    if (text.startsWith('/resumejob ')) {
      await this.handleResumeJobCommand(chatId, text.slice('/resumejob '.length))
      return
    }

    if (text === '/identity') {
      await this.handleIdentityCommand(chatId)
      return
    }

    if (text === '/scratchpad') {
      await this.handleScratchpadCommand(chatId)
      return
    }

    if (text === '/bible') {
      await this.handleBibleCommand(chatId)
      return
    }

    if (text === '/architecture') {
      await this.handleArchitectureCommand(chatId)
      return
    }

    if (commandText === '/git') {
      await this.sendMessage(
        chatId,
        [
          'Git commands:',
          '/git status - show git status',
          '/git log - show recent commits',
          '/git diff [path] - show uncommitted changes',
          '/git commit <msg> - stage and commit all changes',
          '/undo - revert the last git commit with a hard reset',
        ].join('\n'),
      )
      return
    }

    if (text === '/git status') {
      await this.handleGitStatusCommand(chatId)
      return
    }

    if (text === '/git log') {
      await this.handleGitLogCommand(chatId)
      return
    }

    if (text.startsWith('/git diff')) {
      await this.handleGitDiffCommand(chatId, text.slice('/git diff'.length).trim())
      return
    }

    if (text.startsWith('/git commit ')) {
      await this.handleGitCommitCommand(chatId, text.slice('/git commit '.length))
      return
    }

    if (text === '/stop') {
      await this.handleStopCommand(chatId)
      return
    }

    if (text === '/retry') {
      await this.handleRetryCommand(chatId)
      return
    }

    if (text.startsWith('/infinite ')) {
      await this.handleInfiniteTaskCommand(chatId, text.slice('/infinite '.length))
      return
    }

    if (text === '/undo') {
      await this.handleUndoCommand(chatId)
      return
    }

    const mcpImport = parseMcpConfigImport(text)
    if (mcpImport) {
      await this.handleMcpImport(chatId, mcpImport)
      return
    }

    const skillImport = parseSkillStoreImport(text)
    if (skillImport) {
      await this.handleSkillImport(chatId, skillImport)
      return
    }

    const audioCandidate = getAudioTranscriptionCandidate(message)
    if (audioCandidate && this.config.telegram.transcribeAudio) {
      await this.enqueueChatTask(
        chatId,
        `${audioCandidate.type} message ${message.message_id}`,
        () => this.handleAudioMessage(chatId, message, text, audioCandidate),
      )
      return
    }

    await this.enqueueChatTask(
      chatId,
      buildTelegramQueueLabel(text, message),
      () => this.handleQueuedTextMessage(chatId, message, text),
    )
  }

  private async handleQueuedTextMessage(
    chatId: string,
    message: TelegramMessage,
    text: string,
    modeOverride?: TelegramResearchMode,
  ): Promise<void> {
    const activeMode = modeOverride ?? await this.getChatMode(chatId)
    const effectiveText = applyTelegramResearchMode(activeMode, text)
    const attachments = await this.collectAttachments(message, chatId)
    if (!effectiveText && attachments.length === 0) return

    const providerProfile = await loadProviderProfile()
    const replyContext = buildTelegramReplyContext(message)
    const sessionId = await this.getChatSessionId(chatId)
    const conversationTranscript = await buildTelegramConversationTranscript(chatId, {
      excludeMessageId: message.message_id,
      model: providerProfile.model,
      sessionId,
    })

    // Log the incoming message to chat log (for dialogue consolidation)
    await appendChatLog({
      direction: 'in',
      text: effectiveText || '(attachments only)',
      chatId,
      ...(sessionId ? { sessionId } : {}),
      messageId: message.message_id,
      username: message.from?.username,
      ...(replyContext
        ? {
            replyToMessageId: replyContext.messageId,
            replyToText: replyContext.text?.slice(0, 1000),
            replyToAttachmentSummary: replyContext.attachmentSummary,
            replyToUsername: replyContext.from?.username,
          }
        : {}),
    })

    const bridgeHandled = await this.tryHandleCronStyleFeedback(
      chatId,
      effectiveText,
      conversationTranscript,
      replyContext,
    )
    if (bridgeHandled) {
      await appendChatLog({
        direction: 'out',
        text: bridgeHandled,
        chatId,
        ...(sessionId ? { sessionId } : {}),
        exitCode: 0,
      })
      await this.sendMessage(chatId, bridgeHandled)
      return
    }

    const progressStartedAt = Date.now()
    const progressPhase = 'Running Telegram request'

    // Send initial progress message with Stop button
    const thinkingMsg = await this.callTelegram('sendMessage', {
      chat_id: chatId,
      text: formatTelegramProgressText({
        status: 'running',
        phase: progressPhase,
        startedAt: progressStartedAt,
        events: [],
        providerProfile,
      }),
      reply_markup: {
        inline_keyboard: [[
          { text: 'Stop', callback_data: `stop:${chatId}` },
        ]],
      },
    })
    const thinkingMessageId = (thinkingMsg as any)?.message_id ?? (thinkingMsg as any)?.result?.message_id ?? 0

    const controller = new AbortController()
    const progress = new TelegramTaskProgress({
      messageId: thinkingMessageId,
      phase: progressPhase,
      startedAt: progressStartedAt,
      providerProfile,
      stopTyping: this.startTypingLoop(chatId, controller.signal),
      edit: async progressText => {
        if (!thinkingMessageId) return
        await this.callTelegram('editMessageText', {
          chat_id: chatId,
          message_id: thinkingMessageId,
          text: progressText,
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[
              { text: 'Stop', callback_data: `stop:${chatId}` },
            ]],
          },
        })
      },
    })
    progress.setPhase('Running Telegram request')
    this.activeTasks.set(chatId, { controller, messageId: thinkingMessageId, progress })

    const prompt = await buildTelegramAgentPromptWithMemory({
      chatId,
      messageId: message.message_id,
      from: message.from,
      text: effectiveText,
      attachments,
      config: this.config,
      model: providerProfile.model,
      conversationTranscript,
      replyContext,
    })

    // Save for /retry
    const toolPolicy = activeMode === 'pentest' ? 'pentest' : undefined
    this.lastPrompts.set(chatId, {
      prompt,
      messageId: message.message_id,
      toolPolicy,
    })

    let result: AgentRunResult
    try {
      result = await this.runAgentWithRecovery({
        chatId,
        prompt,
        phase: 'Running Telegram request',
        controller,
        progress,
        toolPolicy,
      })
    } finally {
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
    }

    if (controller.signal.aborted) {
      progress.dispose()
      return
    }

    if (result.exitCode === 0) {
      await progress.finish('completed', 'Done. Sending response.')
    } else {
      await progress.finish('failed', formatAgentFailurePhase(result))
    }

    // Log the agent response to chat log
    await appendChatLog(buildAgentChatLogOutput(result, chatId, sessionId))

    if (result.exitCode !== 0) {
      await recordTelegramError(chatId, 'agent-run', result)
      await this.sendMessage(chatId, formatAgentFailureForTelegram(result))
      return
    }

    await this.deliverAgentText(
      chatId,
      result.text,
      '(No response generated)',
      result.artifacts,
    )
  }

  private async handleAudioMessage(
    chatId: string,
    message: TelegramMessage,
    caption: string,
    candidate: IncomingAttachmentCandidate,
  ): Promise<void> {
    try {
      await this.sendMessage(chatId, `Transcribing ${candidate.type}...`)

      const audioPath = await this.downloadTelegramFile(
        candidate,
        chatId,
        message.message_id,
      )

      const attachment: TelegramAttachment = {
        type: candidate.type,
        fileId: candidate.file.file_id,
        fileName: candidate.file.file_name || basename(audioPath),
        mimeType: candidate.file.mime_type,
        size: candidate.file.file_size,
        width: candidate.width,
        height: candidate.height,
        duration: candidate.duration ?? candidate.file.duration,
        localPath: audioPath,
      }
      await recordTelegramAttachment(chatId, message.message_id, attachment)

      const transcription = await transcribeAudio(audioPath, {
        provider: this.config.telegram.transcriptionProvider,
        whisperModel: this.config.telegram.transcriptionWhisperModel,
        openAIModel: this.config.telegram.transcriptionOpenAIModel,
        timeoutMs: this.config.telegram.transcriptionTimeoutMs,
      })
      const transcribedText = transcription.text
      attachment.transcript = transcribedText
      attachment.transcriptPath = transcription.outputPath

      if (!transcribedText) {
        await this.sendMessage(chatId, "I couldn't transcribe the audio.")
        return
      }

      if (this.config.telegram.replyWithTranscript) {
        await this.sendTranscript(chatId, transcribedText, message.message_id)
      }

      const agentText = [
        caption,
        `Transcribed ${candidate.type} message:`,
        transcribedText,
      ]
        .filter(Boolean)
        .join('\n')
      const activeMode = await this.getChatMode(chatId)
      const effectiveAgentText = applyTelegramResearchMode(activeMode, agentText)
      const providerProfile = await loadProviderProfile()
      const replyContext = buildTelegramReplyContext(message)
      const sessionId = await this.getChatSessionId(chatId)
      const conversationTranscript = await buildTelegramConversationTranscript(chatId, {
        excludeMessageId: message.message_id,
        model: providerProfile.model,
        sessionId,
      })

      // Log the transcribed voice message to chat log
      await appendChatLog({
        direction: 'in',
        text: `[${candidate.type} transcribed] ${effectiveAgentText.slice(0, 500)}`,
        chatId,
        ...(sessionId ? { sessionId } : {}),
        messageId: message.message_id,
        username: message.from?.username,
        ...(replyContext
          ? {
              replyToMessageId: replyContext.messageId,
              replyToText: replyContext.text?.slice(0, 1000),
              replyToAttachmentSummary: replyContext.attachmentSummary,
              replyToUsername: replyContext.from?.username,
            }
          : {}),
      })

      // Run the agent with the transcribed text
      const prompt = await buildTelegramAgentPromptWithMemory({
        chatId,
        messageId: message.message_id,
        from: message.from,
        text: effectiveAgentText,
        attachments: [attachment],
        config: this.config,
        model: providerProfile.model,
        conversationTranscript,
        replyContext,
      })
      const result = await this.runAgentWithProgress(
        chatId,
        prompt,
        `Running agent from transcribed ${candidate.type}`,
        { toolPolicy: activeMode === 'pentest' ? 'pentest' : undefined },
      )

      // Log the agent response
      await appendChatLog(buildAgentChatLogOutput(result, chatId, sessionId))

      if (result.exitCode !== 0) {
        await recordTelegramError(chatId, 'agent-run-audio', result)
        await this.sendMessage(chatId, formatAgentFailureForTelegram(result))
        return
      }

      await this.deliverAgentText(
        chatId,
        result.text,
        '(No response generated)',
        result.artifacts,
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      await recordTelegramError(chatId, 'audio-message', detail)
      const errorMessage = err && (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Audio transcription unavailable. Install whisper: pip install openai-whisper (ffmpeg also required), or configure OpenAI transcription explicitly.'
        : `Error processing audio message: ${detail}`
      await this.sendMessage(chatId, errorMessage)
    }
  }

  private mcpProjectRoot(): string {
    return this.config.runner.cwd || process.cwd()
  }

  private async sendControlPanel(chatId: string): Promise<void> {
    const profile = await loadProviderProfile()
    const servers = await listManagedMcpServers(this.mcpProjectRoot())
    const skills = await listSkillStore(this.mcpProjectRoot())
    const evolution = await loadEvolutionState()
    await this.sendMessageWithKeyboard(
      chatId,
      formatTelegramControlPanel({
        profile,
        mcpEnabled: servers.filter(server => server.enabled).length,
        mcpTotal: servers.length,
        skillManaged: skills.filter(skill => skill.managed).length,
        skillTotal: skills.length,
        toolsEnabled: !this.config.runner.disableTools,
        cronEnabled: this.config.cron.enabled,
        consciousnessEnabled: Boolean(getAgentGatewayRuntime()?.consciousness),
        evolutionEnabled: evolution.enabled,
      }),
      buildTelegramControlKeyboard(),
    )
  }

  private async sendMcpMenu(chatId: string): Promise<void> {
    const servers = await listManagedMcpServers(this.mcpProjectRoot())
    await this.sendMessageWithKeyboard(
      chatId,
      formatTelegramMcpMenu(servers),
      buildTelegramMcpKeyboard(servers),
    )
  }

  private async editMcpMenu(query: TelegramCallbackQuery): Promise<void> {
    const servers = await listManagedMcpServers(this.mcpProjectRoot())
    await this.editCallbackMessage(
      query,
      formatTelegramMcpMenu(servers),
      buildTelegramMcpKeyboard(servers),
    )
  }

  private async handleMcpImport(
    chatId: string,
    parsed: NonNullable<ReturnType<typeof parseMcpConfigImport>>,
  ): Promise<void> {
    if (parsed.ok === false) {
      await this.sendMessageWithKeyboard(
        chatId,
        `MCP import rejected: ${parsed.error}`,
        [[{ text: 'MCP servers', callback_data: 'menu:mcp' }]],
      )
      return
    }

    const imported = Object.keys(parsed.config.mcpServers)
    const servers = await importManagedMcpServers(this.mcpProjectRoot(), parsed.config)
    const lines = [
      `MCP import complete: ${imported.join(', ')}`,
      'The new configuration is applied to the next agent run.',
    ]
    if (parsed.normalizedNpxServers.length > 0) {
      lines.push(
        `Cross-platform npx launcher applied: ${parsed.normalizedNpxServers.join(', ')}`,
      )
    }
    await this.sendMessageWithKeyboard(
      chatId,
      lines.join('\n'),
      buildTelegramMcpKeyboard(servers),
    )
  }

  private async handleMcpCommand(chatId: string, commandBody: string): Promise<void> {
    const body = commandBody.trim()
    if (!body || ['list', 'status', 'show'].includes(body.toLowerCase())) {
      await this.sendMcpMenu(chatId)
      return
    }

    if (body.toLowerCase() === 'add') {
      await this.sendMessageWithKeyboard(
        chatId,
        buildTelegramMcpImportInstructions(),
        [[
          { text: 'MCP servers', callback_data: 'menu:mcp' },
          { text: 'Control panel', callback_data: 'menu:control' },
        ]],
      )
      return
    }

    if (body.toLowerCase().startsWith('add ')) {
      const parsed = parseMcpConfigImport(body.slice(4))
      if (!parsed) {
        await this.sendMessage(chatId, 'MCP import rejected: expected a JSON object with mcpServers.')
        return
      }
      await this.handleMcpImport(chatId, parsed)
      return
    }

    const actionMatch = body.match(/^(enable|disable|remove|delete)\s+([A-Za-z0-9._-]{1,40})$/iu)
    if (actionMatch) {
      const action = actionMatch[1]!.toLowerCase()
      const name = actionMatch[2]!
      try {
        const servers = action === 'remove' || action === 'delete'
          ? await removeManagedMcpServer(this.mcpProjectRoot(), name)
          : await setManagedMcpServerEnabled(
              this.mcpProjectRoot(),
              name,
              action === 'enable',
            )
        await this.sendMessageWithKeyboard(
          chatId,
          `${action === 'delete' ? 'remove' : action}: ${name}\nApplied to the next agent run.`,
          buildTelegramMcpKeyboard(servers),
        )
      } catch (error) {
        await this.sendMessage(chatId, `MCP command failed: ${summarizeTelegramError(error)}`)
      }
      return
    }

    const parsed = parseMcpConfigImport(body)
    if (parsed) {
      await this.handleMcpImport(chatId, parsed)
      return
    }

    await this.sendMessage(
      chatId,
      'Usage: /mcp | /mcp add <json> | /mcp enable <name> | /mcp disable <name> | /mcp remove <name>',
    )
  }

  private async handleAndroidCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const body = commandBody.trim()
    const action = body.split(/\s+/u)[0]?.toLowerCase() || ''
    try {
      if (!body || ['list', 'status', 'show'].includes(action)) {
        await this.sendAndroidMenu(chatId)
        return
      }
      if (action === 'discover') {
        await this.sendAndroidMenu(chatId, await discoverAndroidDevices())
        return
      }
      if (action === 'add') {
        const match = body.match(
          /^add\s+([a-z][a-z0-9-]{0,31})\s+(auto|usb|wifi)\s+(\S+)$/iu,
        )
        if (!match) {
          await this.sendMessageWithKeyboard(
            chatId,
            buildTelegramAndroidAddInstructions(),
            buildTelegramAndroidBackKeyboard(),
          )
          return
        }
        const registry = await registerAndroidDeviceProfile({
          projectRoot: this.mcpProjectRoot(),
          alias: match[1]!,
          connection: match[2]!,
          serial: match[3]!,
          makeActive: true,
        })
        await this.sendMessageWithKeyboard(
          chatId,
          `Android profile saved. It is available as Android-MCP tools on the next agent run.\n\n${formatTelegramAndroidMenu(registry)}`,
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }
      if (action === 'pair') {
        const match = body.match(/^pair\s+(\S+)\s+([0-9]{4,12})$/iu)
        if (!match) {
          await this.sendMessage(
            chatId,
            'Usage: /android pair <host:pairing-port> <pairing-code>',
          )
          return
        }
        const result = await pairAndroidDevice(match[1]!, match[2]!)
        await this.sendMessage(
          chatId,
          `Android WiFi pairing: ${result.target}\n${result.message || 'Pairing command completed.'}`,
        )
        return
      }
      if (action === 'connect') {
        const identifier = body.slice('connect'.length).trim()
        if (!identifier) {
          await this.sendMessage(
            chatId,
            'Usage: /android connect <alias|serial|host:port>',
          )
          return
        }
        const checked = await connectAndroidDevice(identifier)
        if (checked.alias) await setActiveAndroidDeviceProfile(checked.alias)
        await this.sendMessageWithKeyboard(
          chatId,
          formatTelegramAndroidCheck(checked),
          buildTelegramAndroidBackKeyboard(),
        )
        return
      }
      if (action === 'use') {
        const alias = body.slice('use'.length).trim()
        const registry = await setActiveAndroidDeviceProfile(alias)
        await this.sendMessageWithKeyboard(
          chatId,
          formatTelegramAndroidMenu(registry),
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }
      if (action === 'check' || action === 'test') {
        const identifier = body.slice(action.length).trim()
        const checked = await checkAndroidDevice(identifier || undefined)
        await this.sendMessageWithKeyboard(
          chatId,
          formatTelegramAndroidCheck(checked),
          buildTelegramAndroidBackKeyboard(),
        )
        return
      }
      const stateMatch = body.match(
        /^(enable|disable|remove|delete)\s+([a-z][a-z0-9-]{0,31})$/iu,
      )
      if (stateMatch) {
        const stateAction = stateMatch[1]!.toLowerCase()
        const alias = stateMatch[2]!
        const registry = stateAction === 'remove' || stateAction === 'delete'
          ? await removeAndroidDeviceProfile(this.mcpProjectRoot(), alias)
          : await setAndroidDeviceProfileEnabled(
              this.mcpProjectRoot(),
              alias,
              stateAction === 'enable',
            )
        await this.sendMessageWithKeyboard(
          chatId,
          formatTelegramAndroidMenu(registry),
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }
      await this.sendMessage(chatId, buildTelegramAndroidUsage())
    } catch (error) {
      await this.sendMessage(
        chatId,
        `Android command failed: ${summarizeTelegramError(error)}`,
      )
    }
  }

  private async sendAndroidMenu(
    chatId: string,
    discovered: AndroidDiscoveredDevice[] = [],
  ): Promise<void> {
    const registry = await listAndroidDeviceProfiles()
    await this.sendMessageWithKeyboard(
      chatId,
      formatTelegramAndroidMenu(registry, discovered),
      buildTelegramAndroidKeyboard(registry),
    )
  }

  private async sendSkillStoreMenu(chatId: string, page = 0): Promise<void> {
    const skills = await listSkillStore(this.mcpProjectRoot())
    await this.sendMessageWithKeyboard(
      chatId,
      formatTelegramSkillStoreMenu(skills, page),
      buildTelegramSkillStoreKeyboard(skills, page),
    )
  }

  private async editSkillStoreMenu(
    query: TelegramCallbackQuery,
    page = 0,
  ): Promise<void> {
    const skills = await listSkillStore(this.mcpProjectRoot())
    await this.editCallbackMessage(
      query,
      formatTelegramSkillStoreMenu(skills, page),
      buildTelegramSkillStoreKeyboard(skills, page),
    )
  }

  private async handleSkillImport(
    chatId: string,
    parsed: SkillStoreImportResult,
  ): Promise<void> {
    if (parsed.ok === false) {
      await this.sendMessageWithKeyboard(
        chatId,
        `Skill creation rejected: ${parsed.error}`,
        [[{ text: 'Skill Store', callback_data: 'menu:skills' }]],
      )
      return
    }

    try {
      const created = await createManagedSkill(
        this.mcpProjectRoot(),
        parsed.input,
      )
      await this.sendMessageWithKeyboard(
        chatId,
        `Skill created and available to the next agent run.\n\n${formatTelegramSkillDetails(created)}`,
        buildTelegramSkillDetailsKeyboard(created),
      )
    } catch (error) {
      await this.sendMessageWithKeyboard(
        chatId,
        `Skill creation failed: ${summarizeTelegramError(error)}`,
        [[{ text: 'Skill Store', callback_data: 'menu:skills' }]],
      )
    }
  }

  private async handleSkillCommand(chatId: string, commandBody: string): Promise<void> {
    const body = commandBody.trim()
    if (!body || ['list', 'store', 'status'].includes(body.toLowerCase())) {
      await this.sendSkillStoreMenu(chatId)
      return
    }

    if (body.toLowerCase() === 'create' || body.toLowerCase() === 'add') {
      await this.sendMessageWithKeyboard(
        chatId,
        buildTelegramSkillCreateInstructions(),
        [[
          { text: 'Skill Store', callback_data: 'menu:skills' },
          { text: 'Control panel', callback_data: 'menu:control' },
        ]],
      )
      return
    }

    const createMatch = body.match(/^(?:create|add)\s+([\s\S]+)$/iu)
    if (createMatch) {
      await this.handleSkillImport(
        chatId,
        parseTelegramSkillCreateInput(createMatch[1]!),
      )
      return
    }

    const actionMatch = body.match(/^(view|show|delete|remove)\s+(.+)$/iu)
    const action = actionMatch?.[1]?.toLowerCase() || 'view'
    const selector = (actionMatch?.[2] || body).trim()
    const skill = await getSkillStoreItemDetails(this.mcpProjectRoot(), selector)
    if (!skill) {
      await this.sendMessage(chatId, `Skill not found: ${selector}`)
      return
    }

    if (action === 'delete' || action === 'remove') {
      if (!skill.managed) {
        await this.sendMessage(
          chatId,
          `Only user-created Store skills can be removed: ${skill.name}`,
        )
        return
      }
      await this.sendMessageWithKeyboard(
        chatId,
        `Remove user-created skill ${skill.name}?`,
        [[
          { text: 'Remove', callback_data: `skill:confirm-delete:${skill.id}` },
          { text: 'Cancel', callback_data: `skill:view:${skill.id}` },
        ]],
      )
      return
    }

    await this.sendMessageWithKeyboard(
      chatId,
      formatTelegramSkillDetails(skill),
      buildTelegramSkillDetailsKeyboard(skill),
    )
  }

  private async handleToolsCommand(chatId: string, commandBody: string): Promise<void> {
    const [rawAction = 'status', rawTool = ''] = commandBody.trim().split(/\s+/, 2)
    const action = rawAction.toLowerCase() || 'status'
    if (action === 'status') {
      const catalog = describeRouterBuiltinTools(this.config.runner)
      await this.sendMessageWithKeyboard(
        chatId,
        [
          `Model tool calls: ${this.config.runner.disableTools ? 'OFF' : 'ON'}`,
          `Built-in tools: ${catalog.filter(tool => tool.enabled).length}/${catalog.length} enabled`,
        ].join('\n'),
        buildTelegramRuntimeKeyboard({
          toolsEnabled: !this.config.runner.disableTools,
          cronEnabled: this.config.cron.enabled,
          consciousnessEnabled: Boolean(getAgentGatewayRuntime()?.consciousness),
          evolutionEnabled: (await loadEvolutionState()).enabled,
        }),
      )
      return
    }
    if (action === 'list') {
      const catalog = describeRouterBuiltinTools(this.config.runner)
      await this.sendMessage(
        chatId,
        [
          `Model tool calls: ${this.config.runner.disableTools ? 'OFF' : 'ON'}`,
          ...catalog.map(tool =>
            `${tool.enabled ? 'ON ' : 'OFF'} ${tool.name} (${tool.group})`,
          ),
          '',
          'Use /tools enable NAME or /tools disable NAME.',
        ].join('\n'),
      )
      return
    }
    if ((action === 'enable' || action === 'disable') && rawTool) {
      const selected = ROUTER_BUILTIN_TOOLS.find(
        tool => tool.name.toLowerCase() === rawTool.toLowerCase(),
      )
      if (!selected) {
        await this.sendMessage(chatId, `Unknown built-in tool: ${rawTool}`)
        return
      }
      const enabled = action === 'enable'
      const next = updateRouterBuiltinToolState(
        this.config.runner,
        selected.name,
        enabled,
      )
      const updates = {
        OPENCLAUDE_AGENT_RUNNER_TOOLS: next.availableTools.join(','),
        OPENCLAUDE_AGENT_RUNNER_DISALLOWED_TOOLS:
          next.disallowedTools.join(','),
      }
      await updateProjectEnvFile(updates)
      applyRuntimeEnvUpdates(updates)
      await updateAgentGatewayConfig(current => ({
        ...current,
        runner: {
          ...current.runner,
          availableTools: next.availableTools,
          disallowedTools: next.disallowedTools,
        },
      }))
      this.config.runner.availableTools = next.availableTools
      this.config.runner.disallowedTools = next.disallowedTools
      await this.sendMessage(
        chatId,
        `${selected.name}: ${enabled ? 'ON' : 'OFF'} for subsequent runs`,
      )
      return
    }
    if (!['on', 'off', '1', '0', 'enable', 'disable'].includes(action)) {
      await this.sendMessage(
        chatId,
        'Usage: /tools [on|off|list|enable NAME|disable NAME]',
      )
      return
    }

    const enabled = ['on', '1', 'enable'].includes(action)
    const updates = { OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS: enabled ? '0' : '1' }
    await updateProjectEnvFile(updates)
    applyRuntimeEnvUpdates(updates)
    await updateAgentGatewayConfig(current => ({
      ...current,
      runner: { ...current.runner, disableTools: !enabled },
    }))
    this.config.runner.disableTools = !enabled
    await this.sendMessage(chatId, `Model tool calls: ${enabled ? 'ON' : 'OFF'}`)
  }

  private async editRuntimeMenu(query: TelegramCallbackQuery): Promise<void> {
    const evolution = await loadEvolutionState()
    await this.editCallbackMessage(
      query,
      formatTelegramRuntimePanel({
        toolsEnabled: !this.config.runner.disableTools,
        cronEnabled: this.config.cron.enabled,
        consciousnessEnabled: Boolean(getAgentGatewayRuntime()?.consciousness),
        evolutionEnabled: evolution.enabled,
      }),
      buildTelegramRuntimeKeyboard({
        toolsEnabled: !this.config.runner.disableTools,
        cronEnabled: this.config.cron.enabled,
        consciousnessEnabled: Boolean(getAgentGatewayRuntime()?.consciousness),
        evolutionEnabled: evolution.enabled,
      }),
    )
  }

  private async handleTranscribeStatusCommand(chatId: string): Promise<void> {
    const tool = await detectTranscriptionTool(
      this.config.telegram.transcriptionProvider,
    )
    if (tool) {
      await this.sendMessage(
        chatId,
        [
          `Audio transcription is available (using ${tool}).`,
          `configured provider: ${this.config.telegram.transcriptionProvider}`,
          `whisper model: ${this.config.telegram.transcriptionWhisperModel}`,
          `timeout: ${this.config.telegram.transcriptionTimeoutMs}ms`,
          'Send voice messages, audio files, or audio documents and they will be transcribed before the agent runs.',
        ].join('\n'),
      )
    } else {
      await this.sendMessage(
        chatId,
        'Audio transcription is NOT available.\nInstall whisper: pip install openai-whisper (ffmpeg also required in PATH), install parakeet-mlx, or set transcriptionProvider=openai with OPENAI_API_KEY.',
      )
    }
  }

  private async handleResearchModeCommand(
    chatId: string,
    message: TelegramMessage,
    mode: TelegramResearchMode,
    body: string,
  ): Promise<void> {
    if (mode === 'pentest' && /^(?:auth|authorize)(?:\s|$)/iu.test(body)) {
      try {
        const authorization = parseTelegramPentestAuthorization(body)
        const result = await runTrustedPentestAuthorization(
          authorization,
          this.config.runner.cwd || process.cwd(),
        )
        await this.setChatMode(chatId, 'pentest')
        await this.sendMessage(
          chatId,
          [
            `Pentest engagement authorized: ${String(result.engagementId || authorization.engagement_id)}`,
            `Targets: ${authorization.targets.join(', ')}`,
            `Actions: ${authorization.allowed_actions.join(', ')}`,
            'Pentest mode is active for this chat.',
          ].join('\n'),
        )
      } catch (error) {
        await this.sendMessage(
          chatId,
          `Pentest authorization failed: ${redactAgentText(String(error))}`,
        )
      }
      return
    }

    if (!body) {
      await this.setChatMode(chatId, mode)
      await this.sendMessage(
        chatId,
        `Research mode set: /${mode}\nSend /mode off to clear it.`,
      )
      return
    }

    await this.enqueueChatTask(
      chatId,
      `/${mode}: ${body.slice(0, 80)}`,
      () => this.handleQueuedTextMessage(chatId, {
        ...message,
        text: body,
      }, body, mode),
    )
  }

  private async handleSubagentsCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const body = commandBody.trim()
    const [action = 'status', ...parts] = body.split(/\s+/u)
    const normalizedAction = action.toLowerCase()

    if (!body || ['status', 'list', 'show'].includes(normalizedAction)) {
      await this.sendMessage(chatId, formatTelegramSubagentStatus(this.config))
      return
    }

    if (['on', 'off'].includes(normalizedAction)) {
      const next = await updateAgentGatewayConfig(current => ({
        ...current,
        subagents: { ...current.subagents, enabled: normalizedAction === 'on' },
      }))
      this.config.subagents = next.subagents
      await this.sendMessage(chatId, formatTelegramSubagentStatus(this.config))
      return
    }

    if (normalizedAction === 'parallel') {
      const maxParallel = Number(parts[0])
      if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) {
        await this.sendMessage(chatId, 'Usage: /subagents parallel <1-8>')
        return
      }
      const next = await updateAgentGatewayConfig(current => ({
        ...current,
        subagents: { ...current.subagents, maxParallel },
      }))
      this.config.subagents = next.subagents
      await this.sendMessage(chatId, formatTelegramSubagentStatus(this.config))
      return
    }

    if (normalizedAction === 'remove') {
      const name = normalizeSubagentRole(parts[0] || '')
      if (!name) {
        await this.sendMessage(chatId, 'Usage: /subagents remove <role>')
        return
      }
      if (!this.config.subagents.routes[name]) {
        await this.sendMessage(chatId, `Subagent route not found: ${name}`)
        return
      }
      const next = await updateAgentGatewayConfig(current => {
        const routes = { ...current.subagents.routes }
        delete routes[name]
        return { ...current, subagents: { ...current.subagents, routes } }
      })
      this.config.subagents = next.subagents
      await this.sendMessage(chatId, `Removed subagent route: ${name}`)
      return
    }

    if (normalizedAction === 'set') {
      const [rawName, rawProvider, rawModel, rawBaseUrl, rawApiKey] = parts
      const name = normalizeSubagentRole(rawName || '')
      const provider = String(rawProvider || '').trim().toLowerCase()
      const model = String(rawModel || '').trim()
      if (!name || !provider || !model) {
        await this.sendMessage(
          chatId,
          'Usage: /subagents set <role> <provider> <model> [base_url] [api_key]',
        )
        return
      }
      const previous = this.config.subagents.routes[name]
      const info = getTelegramProviderInfo(provider)
      const baseUrl = String(
        rawBaseUrl || previous?.baseUrl || info.baseUrl ||
          (provider === 'codex' ? 'https://chatgpt.com/backend-api/codex' : ''),
      ).trim().replace(/\/+$/, '')
      if (!baseUrl) {
        await this.sendMessage(chatId, 'This provider needs an explicit base_url.')
        return
      }
      const route: AgentGatewaySubagentRoute = {
        provider,
        model,
        baseUrl,
        ...(rawApiKey ? { apiKey: rawApiKey } : previous?.apiKey ? { apiKey: previous.apiKey } : {}),
        ...(previous?.apiKeyEnv
          ? { apiKeyEnv: previous.apiKeyEnv }
          : defaultSubagentApiKeyEnv(provider)
            ? { apiKeyEnv: defaultSubagentApiKeyEnv(provider) }
            : {}),
      }
      const next = await updateAgentGatewayConfig(current => ({
        ...current,
        subagents: {
          ...current.subagents,
          routes: { ...current.subagents.routes, [name]: route },
        },
      }))
      this.config.subagents = next.subagents
      await this.sendMessage(chatId, formatTelegramSubagentStatus(this.config))
      return
    }

    await this.sendMessage(
      chatId,
      'Usage:\n/subagents [status|on|off|list]\n/subagents parallel <1-8>\n/subagents set <role> <provider> <model> [base_url] [api_key]\n/subagents remove <role>\n/delegate <plan|code|review|explore|vision> <task>',
    )
  }

  private async handleDelegateCommand(
    chatId: string,
    message: TelegramMessage,
    commandBody: string,
  ): Promise<void> {
    const [rawRole, ...taskParts] = splitCommandLike(commandBody)
    const role = normalizeSubagentRole(rawRole || '')
    const task = taskParts.join(' ').trim()
    if (!role || !task) {
      await this.sendMessage(chatId, 'Usage: /delegate <plan|code|review|explore|vision> <task>')
      return
    }
    if (!this.config.subagents.enabled || !this.config.subagents.routes[role]) {
      await this.sendMessage(chatId, `Subagent route is unavailable: ${role}. Open /subagents first.`)
      return
    }
    const delegatedPrompt = [
      '[Explicit user delegation]',
      `You MUST call the Agent tool once with subagent_type: ${role}.`,
      'Pass the task below unchanged to that subagent, then integrate its result and verify it before answering.',
      '',
      `Task: ${task}`,
    ].join('\n')
    await this.enqueueChatTask(
      chatId,
      `delegate ${role}: ${task.slice(0, 72)}`,
      () => this.handleQueuedTextMessage(chatId, { ...message, text: delegatedPrompt }, delegatedPrompt),
    )
  }

  private async handleProviderCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const body = commandBody.trim()
    if (!body || ['show', 'status'].includes(body.toLowerCase())) {
      await this.sendProviderMenu(chatId)
      return
    }

    if (body.toLowerCase() === 'models') {
      await this.sendModelMenu(chatId)
      return
    }

    if (body.toLowerCase().startsWith('set ')) {
      const parsed = parseProviderSetCommand(body.slice(4))
      if (!parsed) {
        await this.sendMessage(
          chatId,
          'Usage: /provider set <provider> <model> [base_url] [api_key]',
        )
        return
      }
      const previous = await loadProviderProfile()
      const resolved = await resolveShortcutProviderProfile(
        await hydrateShortcutProviderProfile(
        buildTelegramProviderProfileUpdate(previous, parsed),
        ),
      )
      await saveProviderProfile(resolved.profile)
      await this.sendMessage(
        chatId,
        [
          'Provider updated for next agent runs.',
          '',
          formatProviderProfile(resolved.profile),
          ...(resolved.warning ? ['', resolved.warning] : []),
          '',
          'Use /restart if you need to restart the long-lived gateway runtime; normal child agent runs pick this up from .env.',
        ].join('\n'),
      )
      return
    }

    await this.sendMessage(
      chatId,
      [
        'Provider commands:',
        '/provider - show current provider',
        '/provider models - load models from current OpenAI-compatible endpoint',
        '/provider set <provider> <model> [base_url] [api_key]',
        '/provider set deepseek deepseek-v4-pro',
        '/provider set codex gpt-5.5',
        '/provider set lmstudio-lan gemma-4-12b-obliterated',
        '',
        'Short switches:',
        ...TELEGRAM_PROVIDER_SHORTCUTS.map(shortcut => `${shortcut.command} - ${shortcut.provider}/${shortcut.model}`),
        '/model <model>',
        '/baseurl <url>',
        '/apikey <key>',
      ].join('\n'),
    )
  }

  private async sendProviderMenu(chatId: string): Promise<void> {
    const profile = await loadProviderProfile()
    await this.sendMessageWithKeyboard(
      chatId,
      formatProviderProfile(profile),
      buildTelegramProviderKeyboard(profile.provider),
    )
  }

  private async sendModelMenu(chatId: string, page = 0): Promise<void> {
    const profile = await loadProviderProfile()
    const menu = await buildTelegramModelMenu(profile, page)
    await this.sendMessageWithKeyboard(chatId, menu.text, menu.keyboard)
  }

  private async handleProviderShortcutCommand(
    chatId: string,
    shortcut: TelegramProviderShortcut,
  ): Promise<void> {
    const previous = await loadProviderProfile()
    const resolved = await resolveShortcutProviderProfile(
      await hydrateShortcutProviderProfile(
      buildTelegramProviderProfileUpdate(previous, {
        provider: shortcut.provider,
        model: shortcut.model,
      }),
      ),
    )
    await saveProviderProfile(resolved.profile)
    await this.sendMessageWithKeyboard(
      chatId,
      [
        `Switched: ${shortcut.command}`,
        '',
        formatProviderProfile(resolved.profile),
        ...(resolved.warning ? ['', resolved.warning] : []),
        '',
        resolved.profile.provider === 'lmstudio-lan'
          ? 'LM Studio Gemma profiles run with model tools disabled because the current LM Studio templates reject OpenAI tool schemas.'
          : 'Model tools are enabled for this provider.',
      ].join('\n'),
      buildTelegramActiveProfileKeyboard(resolved.profile),
    )
  }

  private async handleContextCommand(chatId: string, commandBody: string): Promise<void> {
    const body = commandBody.trim()
    if (!body || ['show', 'status'].includes(body.toLowerCase())) {
      await this.sendMessage(chatId, await formatContextWindowStatus())
      return
    }

    const update = normalizeTelegramContextWindow(body)
    if (!update) {
      await this.sendMessage(
        chatId,
        'Usage: /context auto | /context 1m | /context <tokens>\nExamples: /context auto, /context 512k, /context 1000000, /context unlimited',
      )
      return
    }

    const updates = contextWindowEnv(update.value)
    await updateProjectEnvFile(updates)
    applyRuntimeEnvUpdates(updates)

    await this.sendMessage(
      chatId,
      [
        update.value
          ? `Context window set to ${formatTokenCount(update.tokens)} tokens for next agent runs.`
          : 'Context window returned to auto model/provider mode for next agent runs.',
        '',
        await formatContextWindowStatus(),
      ].join('\n'),
    )
  }

  private async handleModelCommand(chatId: string, commandBody: string): Promise<void> {
    const model = commandBody.trim()
    if (!model) {
      await this.sendModelMenu(chatId)
      return
    }
    const profile = await loadProviderProfile()
    const next = normalizeProviderProfile({ ...profile, model })
    await saveProviderProfile(next)
    await this.sendMessageWithKeyboard(
      chatId,
      `Model updated for next agent runs.\n\n${formatProviderProfile(next)}`,
      buildTelegramActiveProfileKeyboard(next),
    )
  }

  private async handleReasoningCommand(chatId: string, commandBody: string): Promise<void> {
    const profile = await loadProviderProfile()
    if (profile.provider !== 'codex') {
      await this.sendMessage(
        chatId,
        'Reasoning levels are available for the Codex provider. Open /provider and choose Codex first.',
      )
      return
    }

    const effort = parseTelegramReasoningEffort(commandBody)
    if (!commandBody || !effort) {
      const catalog = await loadProviderModelCatalog(profile)
      const option = findCatalogModel(catalog, profile.model)
      await this.sendMessageWithKeyboard(
        chatId,
        commandBody
          ? 'Unknown reasoning level. Choose one below.'
          : formatProviderProfile(profile),
        buildTelegramReasoningKeyboard(option, profile),
      )
      return
    }

    const catalog = await loadProviderModelCatalog(profile)
    const option = findCatalogModel(catalog, profile.model)
    if (option && !option.reasoningLevels.includes(effort)) {
      await this.sendMessage(
        chatId,
        `${option.label} does not expose reasoning=${effort}. Available: ${option.reasoningLevels.join(', ') || 'none'}`,
      )
      return
    }

    const next = normalizeProviderProfile({
      ...profile,
      model: withModelReasoning(profile.model, effort),
    })
    await saveProviderProfile(next)
    await this.sendMessageWithKeyboard(
      chatId,
      `Reasoning updated.\n\n${formatProviderProfile(next)}`,
      buildTelegramReasoningKeyboard(option, next),
    )
  }

  private async handleBaseUrlCommand(chatId: string, commandBody: string): Promise<void> {
    const baseUrl = commandBody.trim().replace(/\/+$/, '')
    if (!baseUrl) {
      await this.sendMessage(chatId, 'Usage: /baseurl <url>')
      return
    }
    const profile = await loadProviderProfile()
    const next = normalizeProviderProfile({ ...profile, baseUrl })
    await saveProviderProfile(next)
    await this.sendMessage(chatId, `Base URL updated for next agent runs: ${next.baseUrl}`)
  }

  private async handleApiKeyCommand(chatId: string, commandBody: string): Promise<void> {
    const apiKey = commandBody.trim()
    if (!apiKey) {
      await this.sendMessage(chatId, 'Usage: /apikey <key>')
      return
    }
    const profile = await loadProviderProfile()
    const next = normalizeProviderProfile({ ...profile, apiKey })
    await saveProviderProfile(next)
    await this.sendMessage(chatId, `API key updated for next agent runs: ${maskSecretForTelegram(next.apiKey)}`)
  }

  private async handleErrorsCommand(chatId: string, commandBody: string): Promise<void> {
    const limit = Math.min(20, Math.max(1, Number(commandBody.trim() || 5)))
    const errors = await loadTelegramErrorLog(chatId, limit)
    if (errors.length === 0) {
      await this.sendMessage(chatId, 'No recorded errors for this chat.')
      return
    }
    await this.sendMessage(
      chatId,
      errors.map(formatTelegramErrorLogEntry).join('\n\n'),
    )
  }

  private async sendTranscript(
    chatId: string,
    text: string,
    replyToMessageId: number,
  ): Promise<void> {
    const header = 'Transcript:'
    const fullText = `${header}\n${text}`
    const chunks = splitTelegramText(fullText)
    for (let i = 0; i < chunks.length; i++) {
      await this.callTelegram('sendMessage', {
        chat_id: chatId,
        text: chunks[i]!,
        disable_web_page_preview: true,
        ...(i === 0 && replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
      })
    }
  }

  private async handleCronCommand(chatId: string, commandBody: string): Promise<void> {
    const [rawSubcommand] = commandBody.split(/\s+/, 1)
    const subcommand = (rawSubcommand || 'list').toLowerCase()

    if (subcommand === 'list') {
      await this.handleJobsCommand(chatId)
      return
    }

    if (subcommand === 'reload') {
      const ticked = await getAgentGatewayRuntime()?.cron?.tick()
      await this.sendMessage(
        chatId,
        ticked === undefined
          ? 'Cron scheduler is not running.'
          : `Cron scheduler reloaded. Due jobs run now: ${ticked}.`,
      )
      return
    }

    if (subcommand === 'chatid') {
      await this.sendMessage(chatId, `Chat ID: ${chatId}`)
      return
    }

    if (subcommand === 'path') {
      await this.sendMessage(chatId, `Cron jobs file:\n${getCronJobsPath()}`)
      return
    }

    if (subcommand === 'examples') {
      await this.sendMessage(
        chatId,
        [
          'Cron examples:',
          '/schedule every 30m | check project status',
          '/schedule */15 * * * * | summarize git status',
          '/schedule */10 * * * * * | quick heartbeat every 10 seconds',
          '/schedule 2030-01-02T03:04:05Z | one-shot task',
        ].join('\n'),
      )
      return
    }

    await this.sendMessage(chatId, 'Usage: /cron [list|reload|chatid|path|examples]')
  }

  private async handleScheduleCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const separator = commandBody.indexOf('|')
    if (separator === -1) {
      await this.sendMessage(
        chatId,
        'Usage: /schedule every 1h | prompt for the agent',
      )
      return
    }

    const schedule = commandBody.slice(0, separator).trim()
    const prompt = commandBody.slice(separator + 1).trim()
    if (!schedule || !prompt) {
      await this.sendMessage(
        chatId,
        'Usage: /schedule every 1h | prompt for the agent',
      )
      return
    }

    try {
      const timezone = getTelegramCronTimezone()
      const job = await createCronJob({
        name: prompt.slice(0, 50),
        prompt,
        schedule,
        timezone,
        deliver: 'origin',
        origin: { platform: 'telegram', chatId },
      })
      await this.sendMessage(
        chatId,
        `Scheduled job ${job.id}: ${job.scheduleDisplay}${timezone ? ` (${timezone})` : ''}`,
      )
    } catch (error) {
      await this.sendMessage(chatId, `Could not schedule job: ${String(error)}`)
    }
  }

  private async handleJobsCommand(chatId: string): Promise<void> {
    const jobs = (await listCronJobs(true)).filter(
      job => job.origin?.platform === 'telegram' && job.origin.chatId === chatId,
    )
    if (jobs.length === 0) {
      await this.sendMessage(chatId, 'No jobs for this chat.')
      return
    }

    await this.sendMessage(
      chatId,
      jobs
        .map(job =>
          [
            `${job.id} - ${job.name}`,
            `state: ${job.state}`,
            `schedule: ${job.scheduleDisplay}`,
            `next: ${job.nextRunAt ?? 'none'}`,
          ].join('\n'),
        )
        .join('\n\n'),
    )
  }

  private async handleFilesCommand(chatId: string): Promise<void> {
    const files = await listTelegramStoredFiles(chatId, 10)
    if (files.length === 0) {
      await this.sendMessage(chatId, 'No downloaded files for this chat.')
      return
    }

    await this.sendMessage(
      chatId,
      files
        .map(file =>
          [
            `${file.createdAt} - ${file.type}`,
            file.fileName ? `name: ${file.fileName}` : undefined,
            file.mimeType ? `mime: ${file.mimeType}` : undefined,
            file.size ? `size: ${file.size} bytes` : undefined,
            `path: ${file.localPath}`,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n'),
    )
  }

  private async handleRunJobCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const jobId = commandBody.trim()
    if (!jobId) {
      await this.sendMessage(chatId, 'Usage: /runjob <job-id>')
      return
    }

    const existing = await getCronJob(jobId)
    if (
      !existing ||
      existing.origin?.platform !== 'telegram' ||
      existing.origin.chatId !== chatId
    ) {
      await this.sendMessage(chatId, 'Job not found for this chat.')
      return
    }

    await this.sendMessage(chatId, `Running job ${existing.id} now...`)
    const job = await runCronJobNow(jobId, this.config, async content => {
      await this.deliverAgentText(
        chatId,
        `Cronjob Response: ${existing.name}\n-----------\n\n${content}`,
      )
    })
    if (!job) {
      await this.sendMessage(chatId, 'Job disappeared before it could run.')
      return
    }

    if (job.lastStatus === 'error') {
      await this.sendMessage(chatId, `Job ${job.id} failed: ${job.lastError || 'unknown error'}`)
      return
    }

    await this.sendMessage(
      chatId,
      job.lastOutputFile
        ? `Job ${job.id} finished. Output saved: ${job.lastOutputFile}`
        : `Job ${job.id} finished.`,
    )
  }

  private async handleDeleteJobCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const jobId = commandBody.trim()
    if (!jobId) {
      await this.sendMessage(chatId, 'Usage: /deletejob <job-id>')
      return
    }

    const existing = await getCronJob(jobId)
    if (
      !existing ||
      existing.origin?.platform !== 'telegram' ||
      existing.origin.chatId !== chatId
    ) {
      await this.sendMessage(chatId, 'Job not found for this chat.')
      return
    }

    const deleted = await deleteCronJob(jobId)
    if (deleted) {
      await this.sendMessage(chatId, `Job ${jobId} deleted.`)
    } else {
      await this.sendMessage(chatId, `Failed to delete job ${jobId}.`)
    }
  }

  private async handlePauseJobCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const jobId = commandBody.trim()
    if (!jobId) {
      await this.sendMessage(chatId, 'Usage: /pausejob <job-id>')
      return
    }

    const existing = await getCronJob(jobId)
    if (
      !existing ||
      existing.origin?.platform !== 'telegram' ||
      existing.origin.chatId !== chatId
    ) {
      await this.sendMessage(chatId, 'Job not found for this chat.')
      return
    }

    const job = await pauseCronJob(jobId)
    if (job) {
      await this.sendMessage(chatId, `Job ${jobId} paused.`)
    } else {
      await this.sendMessage(chatId, `Failed to pause job ${jobId}.`)
    }
  }

  private async handleResumeJobCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const jobId = commandBody.trim()
    if (!jobId) {
      await this.sendMessage(chatId, 'Usage: /resumejob <job-id>')
      return
    }

    const existing = await getCronJob(jobId)
    if (
      !existing ||
      existing.origin?.platform !== 'telegram' ||
      existing.origin.chatId !== chatId
    ) {
      await this.sendMessage(chatId, 'Job not found for this chat.')
      return
    }

    const job = await resumeCronJob(jobId)
    if (job) {
      await this.sendMessage(chatId, `Job ${jobId} resumed.`)
    } else {
      await this.sendMessage(chatId, `Failed to resume job ${jobId}.`)
    }
  }

  private async handleStatusCommand(chatId: string): Promise<void> {
    const runtime = getAgentGatewayRuntime()
    const jobs = await listCronJobs(true)
    const chatJobs = jobs.filter(
      job => job.origin?.platform === 'telegram' && job.origin.chatId === chatId,
    )
    const evolution = await loadEvolutionState()
    const consciousness = runtime?.consciousness
    const consciousnessStatus = consciousness?.getStatus()
    const uptimeMs = runtime ? Date.now() - runtime.startedAt : 0
    const queuedTelegramTasks = [...this.queuedTaskCounts.values()]
      .reduce((sum, count) => sum + count, 0)

    const lines = [
      'OpenClaude gateway status',
      '',
      `Runtime: ${runtime ? `running for ${formatDuration(uptimeMs)}` : 'stopped'}`,
      `API: ${runtime?.api ? 'running' : this.config.api.enabled ? 'configured' : 'off'}`,
      `Telegram: ${runtime?.telegram ? 'running' : this.config.telegram.enabled ? 'configured' : 'off'}`,
      `Cron: ${runtime?.cron ? 'running' : this.config.cron.enabled ? 'configured' : 'off'}`,
      `Active Telegram tasks: ${this.activeTasks.size}`,
      `Queued Telegram tasks: ${queuedTelegramTasks}`,
      `Cron jobs for this chat: ${chatJobs.length} (${chatJobs.filter(job => job.enabled).length} enabled)`,
      '',
      `Ouroboros: ${this.config.ouroboros.enabled ? 'enabled' : 'off'}`,
      `Background consciousness: ${consciousnessStatus ? consciousnessStatus.paused ? 'paused' : consciousnessStatus.inFlight ? 'thinking' : 'running' : this.config.ouroboros.consciousnessEnabled ? 'configured' : 'off'}`,
      consciousnessStatus ? `Wakeups: ${consciousnessStatus.wakeupCount}; next: ${consciousnessStatus.nextWakeupSec}s` : undefined,
      consciousnessStatus ? `Measured background cost: $${consciousnessStatus.budgetSpentUsd.toFixed(4)}` : undefined,
      `Evolution mode: ${evolution.enabled ? 'ON' : 'OFF'}`,
      `Evolution cycles: ${evolution.totalCyclesCompleted} completed, ${evolution.totalCyclesFailed} failed`,
      evolution.lastCycleAt ? `Last evolution: ${evolution.lastCycleAt.slice(0, 16)} (${evolution.lastCycleType})` : 'Last evolution: never',
    ].filter(Boolean) as string[]

    await this.sendMessage(chatId, lines.join('\n'))
  }

  private async handlePanicCommand(chatId: string): Promise<void> {
    for (const task of this.activeTasks.values()) {
      task.progress?.dispose()
      task.controller.abort()
    }
    this.activeTasks.clear()
    this.taskQueues.clear()
    this.queuedTaskCounts.clear()
    this.chatQueueEpochs.clear()
    this.queueEpoch++
    await this.sendMessage(chatId, 'PANIC: active tasks aborted. Stopping gateway runtime.')
    await this.acknowledgeTelegramUpdates()
    await stopAgentGateway()
  }

  private async handleRestartCommand(chatId: string): Promise<void> {
    for (const task of this.activeTasks.values()) {
      task.progress?.dispose()
      task.controller.abort()
    }
    this.activeTasks.clear()
    this.taskQueues.clear()
    this.queuedTaskCounts.clear()
    this.chatQueueEpochs.clear()
    this.queueEpoch++
    await this.sendMessage(chatId, 'Restarting gateway runtime.')
    await this.acknowledgeTelegramUpdates()
    await restartAgentGateway()
    await this.sendMessage(chatId, 'Gateway runtime restarted.')
  }

  private async handleBgCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const action = commandBody.trim().toLowerCase() || 'status'
    if (['start', 'on', '1'].includes(action)) {
      const updates = {
        OPENCLAUDE_OUROBOROS_ENABLED: '1',
        OPENCLAUDE_CONSCIOUSNESS_ENABLED: '1',
      }
      await updateProjectEnvFile(updates)
      applyRuntimeEnvUpdates(updates)
      await updateAgentGatewayConfig(current => ({
        ...current,
        ouroboros: {
          ...current.ouroboros,
          enabled: true,
          consciousnessEnabled: true,
        },
      }))
      this.config.ouroboros.enabled = true
      this.config.ouroboros.consciousnessEnabled = true
      await this.sendMessage(chatId, 'Background consciousness: starting.')
      await this.acknowledgeTelegramUpdates()
      const runtime = await restartAgentGateway()
      const scheduled = runtime?.consciousness?.wakeNow() === true
      await this.sendMessage(
        chatId,
        scheduled
          ? 'Background consciousness: running; immediate wakeup scheduled.'
          : 'Background consciousness: running; next wakeup follows the configured interval.',
      )
      return
    }

    if (['stop', 'off', '0'].includes(action)) {
      getAgentGatewayRuntime()?.consciousness?.pause()
      const updates = { OPENCLAUDE_CONSCIOUSNESS_ENABLED: '0' }
      await updateProjectEnvFile(updates)
      applyRuntimeEnvUpdates(updates)
      await updateAgentGatewayConfig(current => ({
        ...current,
        ouroboros: {
          ...current.ouroboros,
          consciousnessEnabled: false,
        },
      }))
      this.config.ouroboros.consciousnessEnabled = false
      await this.sendMessage(chatId, 'Background consciousness: stopping.')
      await this.acknowledgeTelegramUpdates()
      await restartAgentGateway()
      await this.sendMessage(chatId, 'Background consciousness: stopped.')
      return
    }

    if (['now', 'wake', 'run'].includes(action)) {
      const consciousness = getAgentGatewayRuntime()?.consciousness
      if (!consciousness) {
        await this.sendMessage(chatId, 'Background consciousness is not running. Start it with /bg start.')
        return
      }
      const scheduled = consciousness.wakeNow()
      await this.sendMessage(
        chatId,
        scheduled
          ? 'Background consciousness: immediate wakeup scheduled.'
          : 'Background consciousness is paused, busy, or an agent task is active. Try again after the current run.',
      )
      return
    }

    if (!['status', 'state'].includes(action)) {
      await this.sendMessage(chatId, 'Usage: /bg [start|stop|now|status]')
      return
    }

    await this.handleConsciousnessCommand(chatId)
  }

  private async handleCronToggleCommand(chatId: string, enabled: boolean): Promise<void> {
    const updates = { OPENCLAUDE_AGENT_CRON_ENABLED: enabled ? '1' : '0' }
    await updateProjectEnvFile(updates)
    applyRuntimeEnvUpdates(updates)
    await updateAgentGatewayConfig(current => ({
      ...current,
      cron: { ...current.cron, enabled },
    }))
    this.config.cron.enabled = enabled
    await this.sendMessage(chatId, `Cron scheduler: ${enabled ? 'ON' : 'OFF'}. Restarting gateway.`)
    await this.acknowledgeTelegramUpdates()
    await restartAgentGateway()
  }

  private async handleEvolveCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const action = commandBody.trim().toLowerCase() || 'status'

    if (['stop', 'off', '0'].includes(action)) {
      await this.handleEvolutionToggleCommand(chatId, false)
      return
    }

    if (['now', 'run', 'once'].includes(action)) {
      await this.handleEvolveNowCommand(chatId)
      return
    }

    if (['status', 'state'].includes(action)) {
      await this.handleEvolutionCommand(chatId)
      return
    }

    if (['start', 'on', '1'].includes(action)) {
      await this.handleEvolutionToggleCommand(chatId, true)
      return
    }

    await this.sendMessage(chatId, 'Usage: /evolve [on|off|now|status]')
  }

  private async handleEvolutionModeCommand(
    chatId: string,
    commandBody: string,
  ): Promise<void> {
    const action = commandBody.trim().toLowerCase() || 'status'
    if (['on', 'start', '1'].includes(action)) {
      await this.handleEvolutionToggleCommand(chatId, true)
      return
    }
    if (['off', 'stop', '0'].includes(action)) {
      await this.handleEvolutionToggleCommand(chatId, false)
      return
    }
    if (['status', 'state'].includes(action)) {
      await this.handleEvolutionCommand(chatId)
      return
    }
    await this.sendMessage(chatId, 'Usage: /evolution [on|off|status]')
  }

  private async handleReviewCommand(chatId: string): Promise<void> {
    await this.runEvolutionCommandCycle(
      chatId,
      'architecture_review',
      'Running deep architecture review',
      true,
    )
  }

  private async runEvolutionCommandCycle(
    chatId: string,
    type: EvolutionType | undefined,
    phase: string,
    allowWhenDisabled = false,
  ): Promise<void> {
    const state = await loadEvolutionState()
    if (!state.enabled && !allowWhenDisabled) {
      await this.sendMessage(chatId, 'Evolution mode is OFF. Enable it with /evolution on or run a one-off /review.')
      return
    }

    if (this.activeTasks.has(chatId)) {
      await this.sendMessage(chatId, 'A task is already running. Use /stop first.')
      return
    }

    const controller = new AbortController()
    const progress = await this.createTaskProgress(chatId, phase, controller.signal)
    this.activeTasks.set(chatId, { controller, messageId: progress.messageId, progress })
    try {
      const result = await runEvolutionCycle(this.config, type, {
        signal: controller.signal,
        onProgress: event => progress.addEvent(event),
        onStdout: chunk => progress.observeStdout(chunk),
        allowWhenDisabled,
      })
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
      if (controller.signal.aborted) {
        progress.dispose()
        return
      }
      if (!result) {
        await progress.finish('failed', 'Evolution cycle returned no result.')
        await this.sendMessage(chatId, 'Evolution cycle returned no results.')
        return
      }

      progress.addEvent(`evolution: ${result.type}`)
      await progress.finish('completed', 'Evolution cycle finished.')
      await this.sendEvolutionResult(chatId, result)
    } catch (error) {
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
      await progress.finish('failed', 'Evolution cycle failed.')
      await recordTelegramError(chatId, 'evolution-cycle', error)
      await this.sendMessage(chatId, error instanceof Error ? error.message : String(error))
    } finally {
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
    }
  }

  private async sendEvolutionResult(
    chatId: string,
    result: EvolutionResult,
  ): Promise<void> {
    const lines = [
      `Evolution: ${result.type}`,
      `Summary: ${result.summary}`,
    ]
    if (result.insights.length > 0) {
      lines.push('')
      lines.push('Insights:')
      for (const insight of result.insights.slice(0, 5)) {
        lines.push(`- ${insight.slice(0, 200)}`)
      }
    }
    if (result.changes.length > 0) {
      lines.push('')
      lines.push('Changes:')
      for (const change of result.changes.slice(0, 5)) {
        lines.push(`- ${change.slice(0, 200)}`)
      }
    }

    await this.sendMessage(chatId, lines.join('\n'))
  }

  private async handleConsciousnessCommand(chatId: string): Promise<void> {
    const runtime = getAgentGatewayRuntime()
    const consciousness = runtime?.consciousness
    const configured =
      Boolean(runtime?.config.ouroboros.enabled) &&
      Boolean(runtime?.config.ouroboros.consciousnessEnabled)

    const lines: string[] = []

    if (consciousness) {
      const status = consciousness.getStatus()
      lines.push(`Background consciousness is ${status.paused ? 'paused' : status.inFlight ? 'thinking' : 'running'}.`)
      lines.push(`Wakeups: ${status.wakeupCount}`)
      lines.push(`Last rounds: ${status.lastRoundCount}/${status.maxRounds}`)
      lines.push(`Next wakeup: ${status.nextWakeupSec}s`)
      lines.push(`Measured cost: $${status.budgetSpentUsd.toFixed(4)}`)
      lines.push(`Budget guard: ${status.budgetLimited ? 'LIMIT REACHED' : process.env.TOTAL_BUDGET ? 'active' : 'unlimited'}`)
      if (status.lastWakeupAt) lines.push(`Last wakeup: ${status.lastWakeupAt.slice(0, 19)}`)
      if (status.lastSuccessAt) lines.push(`Last success: ${status.lastSuccessAt.slice(0, 19)}`)
      if (status.lastError) lines.push(`Last error: ${status.lastError.slice(0, 500)}`)
    } else {
      lines.push(
        configured
          ? 'Background consciousness is configured but not running.'
          : 'Background consciousness is disabled. Enable it in /agent-gateway.',
      )
    }

    // Show memory stats
    const blocks = await loadScratchpadBlocks()
    const identity = await loadIdentity()
    const patterns = await loadPatterns()
    const reflections = await loadRecentReflections(3)

    lines.push('')
    lines.push(`Scratchpad: ${blocks.length} blocks`)
    lines.push(`Identity: ${identity.length} chars`)
    lines.push(`Pattern register: ${patterns.length} chars`)
    lines.push(`Recent reflections: ${reflections.length}`)

    await this.sendMessage(chatId, lines.join('\n'))
  }

  private async handleEvolutionCommand(chatId: string): Promise<void> {
    const status = await getEvolutionStatus()
    const consciousness = getAgentGatewayRuntime()?.consciousness
    await this.sendMessage(
      chatId,
      `${status}\nAutonomous scheduler: ${consciousness ? `background consciousness, every ${this.config.ouroboros.evolutionIntervalSeconds}s` : 'not running; use /bg start'}\n\nCommands:\n/evolution on - enable scheduled self-improvement\n/evolution off - disable scheduled evolution\n/evolve now - run one cycle immediately\n/review - run a one-off architecture review`,
    )
  }

  private async handleEvolutionToggleCommand(
    chatId: string,
    enabled: boolean,
  ): Promise<void> {
    const state = await toggleEvolution(enabled)
    await this.sendMessage(
      chatId,
      [
        `Evolution mode: ${enabled ? 'ON' : 'OFF'}`,
        `Completed cycles: ${state.totalCyclesCompleted}`,
        `Failed cycles: ${state.totalCyclesFailed}`,
        enabled
          ? getAgentGatewayRuntime()?.consciousness
            ? `Automatic cycle interval: ${this.config.ouroboros.evolutionIntervalSeconds}s`
            : 'Automatic cycles require background consciousness. Start it with /bg start.'
          : 'Manual /evolve now and /review remain available.',
      ].join('\n'),
    )
  }

  private async handleEvolveNowCommand(chatId: string): Promise<void> {
    await this.runEvolutionCommandCycle(
      chatId,
      undefined,
      'Running evolution cycle',
      true,
    )
  }

  private async handleIdentityCommand(chatId: string): Promise<void> {
    const identity = await loadIdentity()
    const dialogueBlocks = await loadDialogueBlocks()
    const state = await loadEvolutionState()

    const lines = [
      '## Identity',
      '',
      identity.slice(0, 3000),
      '',
      `Dialogue blocks: ${dialogueBlocks.length}`,
      `Evolution cycles: ${state.totalCyclesCompleted}`,
    ]

    await this.sendMessage(chatId, lines.join('\n'))
  }

  private async handleScratchpadCommand(chatId: string): Promise<void> {
    const blocks = await loadScratchpadBlocks()

    if (blocks.length === 0) {
      await this.sendMessage(chatId, 'Scratchpad is empty.')
      return
    }

    const lines = [`## Scratchpad (${blocks.length} blocks)\n`]
    for (const block of [...blocks].reverse()) {
      const ts = block.ts.slice(0, 16)
      lines.push(`### [${ts} — ${block.source}]`)
      lines.push(block.content.slice(0, 1500))
      lines.push('---')
    }

    await this.sendMessage(chatId, lines.join('\n'))
  }

  private async handleBibleCommand(chatId: string): Promise<void> {
    const { loadBible } = await import('./memory.js')
    const bible = await loadBible()
    if (!bible) {
      await this.sendMessage(chatId, 'BIBLE.md not found.')
      return
    }
    // Send in chunks (Telegram 4096 char limit)
    const chunks = splitTelegramText(bible.slice(0, 10000))
    for (const chunk of chunks) {
      await this.sendMessage(chatId, chunk)
    }
  }

  private async handleArchitectureCommand(chatId: string): Promise<void> {
    const { loadArchitecture } = await import('./memory.js')
    const arch = await loadArchitecture()
    if (!arch) {
      await this.sendMessage(chatId, 'ARCHITECTURE.md not found.')
      return
    }
    const chunks = splitTelegramText(arch.slice(0, 10000))
    for (const chunk of chunks) {
      await this.sendMessage(chatId, chunk)
    }
  }

  private async handleGitStatusCommand(chatId: string): Promise<void> {
    try {
      const status = await gitStatus()
      await this.sendMessage(chatId, status || 'Working tree clean.')
    } catch (err) {
      await this.sendMessage(chatId, `Git error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async handleGitLogCommand(chatId: string): Promise<void> {
    try {
      const log = await gitLog(15)
      await this.sendMessage(chatId, log || 'No commits yet.')
    } catch (err) {
      await this.sendMessage(chatId, `Git error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async handleGitDiffCommand(chatId: string, path: string): Promise<void> {
    try {
      const diff = await gitDiff(path || undefined)
      if (!diff) {
        await this.sendMessage(chatId, 'No uncommitted changes.')
        return
      }
      const chunks = splitTelegramText(diff.slice(0, 4000))
      for (const chunk of chunks) {
        await this.sendMessage(chatId, chunk)
      }
    } catch (err) {
      await this.sendMessage(chatId, `Git error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async handleGitCommitCommand(chatId: string, message: string): Promise<void> {
    if (!message.trim()) {
      await this.sendMessage(chatId, 'Usage: /git commit <message>')
      return
    }
    try {
      const result = await gitCommit(message.trim())
      if (result.success) {
        await this.sendMessage(chatId, `Committed: ${message.trim()}`)
      } else {
        await this.sendMessage(chatId, `Commit failed: ${result.error}`)
      }
    } catch (err) {
      await this.sendMessage(chatId, `Git error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // -----------------------------------------------------------------------
  // Stop / Retry / Undo
  // -----------------------------------------------------------------------

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    try {
      await this.callTelegram('answerCallbackQuery', {
        callback_query_id: query.id,
      })
    } catch {
      // The abort action matters more than clearing Telegram's button spinner.
    }

    const chatId = query.message?.chat?.id === undefined
      ? ''
      : String(query.message.chat.id)
    if (!chatId) return
    const userId = query.from?.id === undefined ? '' : String(query.from.id)
    if (!isTelegramActorAllowed({
      chatId,
      userId,
      allowedChatIds: this.config.telegram.allowedChatIds,
      allowedUserIds: this.config.telegram.allowedUserIds,
      homeChatId: this.config.telegram.homeChatId,
    })) return

    const data = query.data || ''

    // stop:<chatId>
    if (data.startsWith('stop:')) {
      if (data.slice(5) !== chatId) return
      await this.stopTask(chatId)
      return
    }

    try {
      if (data === 'menu:control') {
        const profile = await loadProviderProfile()
        const servers = await listManagedMcpServers(this.mcpProjectRoot())
        const skills = await listSkillStore(this.mcpProjectRoot())
        const evolution = await loadEvolutionState()
        await this.editCallbackMessage(
          query,
          formatTelegramControlPanel({
            profile,
            mcpEnabled: servers.filter(server => server.enabled).length,
            mcpTotal: servers.length,
            skillManaged: skills.filter(skill => skill.managed).length,
            skillTotal: skills.length,
            toolsEnabled: !this.config.runner.disableTools,
            cronEnabled: this.config.cron.enabled,
            consciousnessEnabled: Boolean(getAgentGatewayRuntime()?.consciousness),
            evolutionEnabled: evolution.enabled,
          }),
          buildTelegramControlKeyboard(),
        )
        return
      }

      if (data === 'control:help') {
        await this.sendMessageWithKeyboard(
          chatId,
          buildTelegramHelpText(this.config),
          buildTelegramControlKeyboard(),
        )
        return
      }

      if (data === 'control:status') {
        await this.handleStatusCommand(chatId)
        return
      }

      if (data === 'conversation:new') {
        await this.handleNewChatCommand(chatId)
        return
      }

      if (data === 'menu:mcp') {
        await this.editMcpMenu(query)
        return
      }

      if (data === 'menu:android') {
        const registry = await listAndroidDeviceProfiles()
        await this.editCallbackMessage(
          query,
          formatTelegramAndroidMenu(registry),
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }

      if (data === 'android:discover') {
        const [registry, devices] = await Promise.all([
          listAndroidDeviceProfiles(),
          discoverAndroidDevices(),
        ])
        await this.editCallbackMessage(
          query,
          formatTelegramAndroidMenu(registry, devices),
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }

      if (data === 'android:add') {
        await this.editCallbackMessage(
          query,
          buildTelegramAndroidAddInstructions(),
          buildTelegramAndroidBackKeyboard(),
        )
        return
      }

      const androidAction = data.match(
        /^android:(view|use|connect|check|toggle|delete|confirm-delete):([a-z][a-z0-9-]{0,31})$/u,
      )
      if (androidAction) {
        const action = androidAction[1]!
        const alias = androidAction[2]!
        let registry = await listAndroidDeviceProfiles()
        const profile = registry.profiles[alias]
        if (!profile) throw new Error(`Android profile not found: ${alias}`)
        if (action === 'view') {
          await this.editCallbackMessage(
            query,
            formatTelegramAndroidProfile(profile, registry),
            buildTelegramAndroidProfileKeyboard(profile, registry),
          )
          return
        }
        if (action === 'use') {
          registry = await setActiveAndroidDeviceProfile(alias)
          await this.editCallbackMessage(
            query,
            formatTelegramAndroidProfile(registry.profiles[alias]!, registry),
            buildTelegramAndroidProfileKeyboard(registry.profiles[alias]!, registry),
          )
          return
        }
        if (action === 'connect' || action === 'check') {
          const checked = action === 'connect'
            ? await connectAndroidDevice(alias)
            : await checkAndroidDevice(alias)
          if (action === 'connect') {
            registry = await setActiveAndroidDeviceProfile(alias)
          }
          await this.editCallbackMessage(
            query,
            formatTelegramAndroidCheck(checked),
            buildTelegramAndroidProfileKeyboard(registry.profiles[alias]!, registry),
          )
          return
        }
        if (action === 'toggle') {
          registry = await setAndroidDeviceProfileEnabled(
            this.mcpProjectRoot(),
            alias,
            !profile.enabled,
          )
          await this.editCallbackMessage(
            query,
            formatTelegramAndroidProfile(registry.profiles[alias]!, registry),
            buildTelegramAndroidProfileKeyboard(registry.profiles[alias]!, registry),
          )
          return
        }
        if (action === 'delete') {
          await this.editCallbackMessage(
            query,
            `Remove Android profile ${alias}? The device itself is not modified.`,
            [[
              { text: 'Remove', callback_data: `android:confirm-delete:${alias}` },
              { text: 'Cancel', callback_data: `android:view:${alias}` },
            ]],
          )
          return
        }
        registry = await removeAndroidDeviceProfile(
          this.mcpProjectRoot(),
          alias,
        )
        await this.editCallbackMessage(
          query,
          formatTelegramAndroidMenu(registry),
          buildTelegramAndroidKeyboard(registry),
        )
        return
      }

      if (data === 'menu:subagents') {
        await this.editCallbackMessage(
          query,
          formatTelegramSubagentStatus(this.config),
          buildTelegramSubagentKeyboard(this.config.subagents.enabled),
        )
        return
      }

      if (data === 'subagents:toggle') {
        const next = await updateAgentGatewayConfig(current => ({
          ...current,
          subagents: { ...current.subagents, enabled: !current.subagents.enabled },
        }))
        this.config.subagents = next.subagents
        await this.editCallbackMessage(
          query,
          formatTelegramSubagentStatus(this.config),
          buildTelegramSubagentKeyboard(this.config.subagents.enabled),
        )
        return
      }

      if (data === 'mcp:add') {
        await this.editCallbackMessage(
          query,
          buildTelegramMcpImportInstructions(),
          [[
            { text: 'MCP servers', callback_data: 'menu:mcp' },
            { text: 'Control panel', callback_data: 'menu:control' },
          ]],
        )
        return
      }

      const mcpAction = data.match(/^mcp:(view|toggle|delete|confirm-delete):([A-Za-z0-9._-]{1,40})$/u)
      if (mcpAction) {
        const action = mcpAction[1]!
        const name = mcpAction[2]!
        const servers = await listManagedMcpServers(this.mcpProjectRoot())
        const server = servers.find(item => item.name === name)
        if (!server) throw new Error(`MCP server not found: ${name}`)

        if (action === 'view') {
          await this.editCallbackMessage(
            query,
            formatTelegramMcpServer(server),
            buildTelegramMcpServerKeyboard(server),
          )
          return
        }
        if (action === 'toggle') {
          await setManagedMcpServerEnabled(
            this.mcpProjectRoot(),
            name,
            !server.enabled,
          )
          await this.editMcpMenu(query)
          return
        }
        if (action === 'delete') {
          if (server.origin === 'base') {
            throw new Error(`Base MCP server ${name} can be disabled but not removed`)
          }
          await this.editCallbackMessage(
            query,
            `Remove runtime MCP configuration ${name}?`,
            [[
              { text: 'Remove', callback_data: `mcp:confirm-delete:${name}` },
              { text: 'Cancel', callback_data: `mcp:view:${name}` },
            ]],
          )
          return
        }
        await removeManagedMcpServer(this.mcpProjectRoot(), name)
        await this.editMcpMenu(query)
        return
      }

      if (data === 'menu:skills') {
        await this.editSkillStoreMenu(query)
        return
      }

      const skillPage = data.match(/^skills:page:(\d+)$/u)
      if (skillPage) {
        await this.editSkillStoreMenu(query, Number(skillPage[1]))
        return
      }

      if (data === 'skills:create') {
        await this.editCallbackMessage(
          query,
          buildTelegramSkillCreateInstructions(),
          [[
            { text: 'Skill Store', callback_data: 'menu:skills' },
            { text: 'Control panel', callback_data: 'menu:control' },
          ]],
        )
        return
      }

      const skillAction = data.match(
        /^skill:(view|delete|confirm-delete):([a-f0-9]{12})$/u,
      )
      if (skillAction) {
        const action = skillAction[1]!
        const id = skillAction[2]!
        const skill = await getSkillStoreItemDetails(this.mcpProjectRoot(), id)
        if (!skill) throw new Error(`Skill not found: ${id}`)

        if (action === 'view') {
          await this.editCallbackMessage(
            query,
            formatTelegramSkillDetails(skill),
            buildTelegramSkillDetailsKeyboard(skill),
          )
          return
        }
        if (!skill.managed) {
          throw new Error(`Only user-created Store skills can be removed: ${skill.name}`)
        }
        if (action === 'delete') {
          await this.editCallbackMessage(
            query,
            `Remove user-created skill ${skill.name}?`,
            [[
              { text: 'Remove', callback_data: `skill:confirm-delete:${skill.id}` },
              { text: 'Cancel', callback_data: `skill:view:${skill.id}` },
            ]],
          )
          return
        }

        const skills = await deleteManagedSkill(this.mcpProjectRoot(), skill.id)
        await this.editCallbackMessage(
          query,
          `Skill removed: ${skill.name}\n\n${formatTelegramSkillStoreMenu(skills)}`,
          buildTelegramSkillStoreKeyboard(skills),
        )
        return
      }

      if (data === 'menu:runtime') {
        await this.editRuntimeMenu(query)
        return
      }

      if (data === 'runtime:tools') {
        await this.handleToolsCommand(
          chatId,
          this.config.runner.disableTools ? 'on' : 'off',
        )
        await this.editRuntimeMenu(query)
        return
      }

      if (data === 'runtime:consciousness') {
        await this.handleBgCommand(
          chatId,
          getAgentGatewayRuntime()?.consciousness ? 'stop' : 'start',
        )
        return
      }

      if (data === 'runtime:wake') {
        await this.handleBgCommand(chatId, 'now')
        return
      }

      if (data === 'runtime:evolution') {
        const state = await loadEvolutionState()
        await this.handleEvolutionToggleCommand(chatId, !state.enabled)
        await this.editRuntimeMenu(query)
        return
      }

      if (data === 'runtime:cron') {
        await this.handleCronToggleCommand(chatId, !this.config.cron.enabled)
        return
      }

      if (data === 'runtime:evolve') {
        await this.handleEvolveNowCommand(chatId)
        return
      }

      if (data === 'runtime:review') {
        await this.handleReviewCommand(chatId)
        return
      }

      if (data === 'runtime:restart') {
        await this.editCallbackMessage(
          query,
          'Restart the gateway runtime?',
          [[
            { text: 'Restart', callback_data: 'runtime:confirm-restart' },
            { text: 'Cancel', callback_data: 'menu:runtime' },
          ]],
        )
        return
      }

      if (data === 'runtime:confirm-restart') {
        await this.handleRestartCommand(chatId)
        return
      }

      if (data === 'runtime:panic') {
        await this.editCallbackMessage(
          query,
          'Stop all tasks and the gateway runtime?',
          [[
            { text: 'Stop runtime', callback_data: 'runtime:confirm-panic' },
            { text: 'Cancel', callback_data: 'menu:runtime' },
          ]],
        )
        return
      }

      if (data === 'runtime:confirm-panic') {
        await this.handlePanicCommand(chatId)
        return
      }

      if (data === 'menu:schedule') {
        const jobs = (await listCronJobs(true)).filter(
          job => job.origin?.platform === 'telegram' && job.origin.chatId === chatId,
        )
        await this.editCallbackMessage(
          query,
          formatTelegramSchedulePanel(jobs),
          buildTelegramScheduleKeyboard(jobs),
        )
        return
      }

      if (data === 'cron:add') {
        await this.editCallbackMessage(
          query,
          'Create a scheduled task with:\n/schedule every 1h | prompt\n/schedule 0 22 * * * | prompt',
          [[
            { text: 'Schedules', callback_data: 'menu:schedule' },
            { text: 'Control panel', callback_data: 'menu:control' },
          ]],
        )
        return
      }

      if (data === 'cron:reload') {
        await this.handleCronCommand(chatId, 'reload')
        return
      }

      const cronAction = data.match(/^cron:(run|pause|resume|delete|confirm-delete):([^:]{1,48})$/u)
      if (cronAction) {
        const action = cronAction[1]!
        const jobId = cronAction[2]!
        if (action === 'run') await this.handleRunJobCommand(chatId, jobId)
        else if (action === 'pause') await this.handlePauseJobCommand(chatId, jobId)
        else if (action === 'resume') await this.handleResumeJobCommand(chatId, jobId)
        else if (action === 'delete') {
          await this.editCallbackMessage(
            query,
            `Delete scheduled job ${jobId}?`,
            [[
              { text: 'Delete', callback_data: `cron:confirm-delete:${jobId}` },
              { text: 'Cancel', callback_data: 'menu:schedule' },
            ]],
          )
          return
        } else await this.handleDeleteJobCommand(chatId, jobId)
        return
      }

      if (data === 'menu:memory') {
        await this.editCallbackMessage(
          query,
          'Memory and repository knowledge',
          buildTelegramMemoryKeyboard(),
        )
        return
      }

      if (data === 'memory:identity') {
        await this.handleIdentityCommand(chatId)
        return
      }
      if (data === 'memory:scratchpad') {
        await this.handleScratchpadCommand(chatId)
        return
      }
      if (data === 'memory:bible') {
        await this.handleBibleCommand(chatId)
        return
      }
      if (data === 'memory:architecture') {
        await this.handleArchitectureCommand(chatId)
        return
      }

      if (data === 'menu:research') {
        const activeMode = await this.getChatMode(chatId)
        await this.editCallbackMessage(
          query,
          `Research mode: ${activeMode || 'off'}`,
          buildTelegramResearchKeyboard(activeMode),
        )
        return
      }

      const modeAction = data.match(/^mode:(bio|social|code|pentest|off)$/u)
      if (modeAction) {
        const mode = modeAction[1] as TelegramResearchMode | 'off'
        await this.setChatMode(chatId, mode === 'off' ? undefined : mode)
        await this.editCallbackMessage(
          query,
          `Research mode: ${mode}`,
          buildTelegramResearchKeyboard(mode === 'off' ? undefined : mode),
        )
        return
      }

      if (data === 'menu:git') {
        await this.editCallbackMessage(query, 'Repository controls', buildTelegramGitKeyboard())
        return
      }
      if (data === 'git:status') {
        await this.handleGitStatusCommand(chatId)
        return
      }
      if (data === 'git:log') {
        await this.handleGitLogCommand(chatId)
        return
      }
      if (data === 'git:diff') {
        await this.handleGitDiffCommand(chatId, '')
        return
      }
      if (data === 'git:commit') {
        await this.sendMessage(chatId, 'Commit with: /git commit <message>')
        return
      }
      if (data === 'git:undo') {
        await this.editCallbackMessage(
          query,
          'Hard-reset the last git commit?',
          [[
            { text: 'Undo commit', callback_data: 'git:confirm-undo' },
            { text: 'Cancel', callback_data: 'menu:git' },
          ]],
        )
        return
      }
      if (data === 'git:confirm-undo') {
        await this.handleUndoCommand(chatId)
        return
      }

      if (data === 'menu:providers') {
        const profile = await loadProviderProfile()
        await this.editCallbackMessage(
          query,
          formatProviderProfile(profile),
          buildTelegramProviderKeyboard(profile.provider),
        )
        return
      }

      if (data === 'menu:reasoning') {
        const profile = await loadProviderProfile()
        if (profile.provider !== 'codex') {
          throw new Error('Switch to the Codex provider before choosing reasoning.')
        }
        const catalog = await loadProviderModelCatalog(profile)
        const option = findCatalogModel(catalog, profile.model)
        await this.editCallbackMessage(
          query,
          formatProviderProfile(profile),
          buildTelegramReasoningKeyboard(option, profile),
        )
        return
      }

      const providerMatch = data.match(/^provider:([a-z0-9-]+)$/u)
      if (providerMatch) {
        const provider = providerMatch[1]!
        if (!isKnownTelegramProvider(provider)) return
        const previous = await loadProviderProfile()
        const defaultModel = defaultTelegramProviderModel(provider)
        const resolved = await resolveShortcutProviderProfile(
          await hydrateShortcutProviderProfile(
          buildTelegramProviderProfileUpdate(previous, {
            provider,
            model: defaultModel,
          }),
          ),
        )
        await saveProviderProfile(resolved.profile)
        const menu = await buildTelegramModelMenu(resolved.profile, 0)
        if (resolved.warning) {
          menu.text = `${menu.text}\n\n${resolved.warning}`
        }
        await this.editCallbackMessage(query, menu.text, menu.keyboard)
        return
      }

      const modelsMatch = data.match(/^models:([a-z0-9-]+):(\d+)$/u)
      if (modelsMatch) {
        const provider = modelsMatch[1]!
        const page = Number(modelsMatch[2])
        if (!isKnownTelegramProvider(provider)) return
        const current = await loadProviderProfile()
        const profile = current.provider === provider
          ? current
          : (await resolveShortcutProviderProfile(
              await hydrateShortcutProviderProfile(
              buildTelegramProviderProfileUpdate(current, {
                provider,
                model: defaultTelegramProviderModel(provider),
              }),
              ),
            )).profile
        if (profile !== current) await saveProviderProfile(profile)
        const menu = await buildTelegramModelMenu(profile, page)
        await this.editCallbackMessage(query, menu.text, menu.keyboard)
        return
      }

      const modelMatch = data.match(/^model:([a-z0-9-]+):(\d+)$/u)
      if (modelMatch) {
        const provider = modelMatch[1]!
        const modelIndex = Number(modelMatch[2])
        if (!isKnownTelegramProvider(provider)) return
        const current = await loadProviderProfile()
        const targetProfile = current.provider === provider
          ? current
          : await hydrateShortcutProviderProfile(
              buildTelegramProviderProfileUpdate(current, {
                provider,
                model: defaultTelegramProviderModel(provider),
              }),
            )
        const catalog = await loadProviderModelCatalog(targetProfile)
        const option = catalog.models[modelIndex]
        if (!option) throw new Error('Model menu expired. Open /models again.')
        const selectedModel = provider === 'codex' && option.defaultReasoning
          ? withModelReasoning(option.id, option.defaultReasoning)
          : option.id
        const next = await hydrateShortcutProviderProfile(
          buildTelegramProviderProfileUpdate(current, {
            provider,
            model: selectedModel,
          }),
        )
        await saveProviderProfile(next)
        await this.editCallbackMessage(
          query,
          `Provider and model updated.\n\n${formatProviderProfile(next)}`,
          provider === 'codex'
            ? buildTelegramReasoningKeyboard(option, next)
            : buildTelegramActiveProfileKeyboard(next),
        )
        return
      }

      const reasoningMatch = data.match(/^reason:(low|medium|high|xhigh|max|ultra)$/u)
      if (reasoningMatch) {
        const effort = reasoningMatch[1] as ReasoningEffort
        const profile = await loadProviderProfile()
        if (profile.provider !== 'codex') {
          throw new Error('Switch to the Codex provider before choosing reasoning.')
        }
        const catalog = await loadProviderModelCatalog(profile)
        const option = findCatalogModel(catalog, profile.model)
        if (option && !option.reasoningLevels.includes(effort)) {
          throw new Error(`${option.label} does not support reasoning=${effort}.`)
        }
        const next = normalizeProviderProfile({
          ...profile,
          model: withModelReasoning(profile.model, effort),
        })
        await saveProviderProfile(next)
        await this.editCallbackMessage(
          query,
          `Reasoning updated.\n\n${formatProviderProfile(next)}`,
          buildTelegramReasoningKeyboard(option, next),
        )
        return
      }

      if (data === 'manual:provider') {
        await this.sendMessageWithKeyboard(
          chatId,
          [
            'Add or update a provider:',
            '/provider set <provider> <model> [base_url] [api_key]',
            '/model <model>',
            '/reasoning low|medium|high|xhigh|max|ultra',
          ].join('\n'),
          [[
            { text: 'Providers', callback_data: 'menu:providers' },
            { text: 'Control panel', callback_data: 'menu:control' },
          ]],
        )
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await recordTelegramError(chatId, 'telegram-control-callback', detail)
      await this.sendMessage(chatId, `Control panel error: ${detail}`)
    }
  }

  private async handleStopCommand(chatId: string): Promise<void> {
    await this.stopTask(chatId)
  }

  private async stopTask(chatId: string): Promise<void> {
    const task = this.activeTasks.get(chatId)
    this.invalidateChatQueue(chatId)
    if (!task) {
      await this.sendMessage(chatId, 'No active task to stop. Queued tasks for this chat were cleared.')
      return
    }

    task.controller.abort()
    task.progress?.dispose()
    this.activeTasks.delete(chatId)

    // Edit the "thinking" message to show it was stopped
    try {
      await this.callTelegram('editMessageText', {
        chat_id: chatId,
        message_id: task.messageId,
        text: 'Task stopped by user.',
      })
    } catch {
      // Message may have already been replaced
    }

    await this.sendMessage(chatId, 'Task stopped. Queued tasks for this chat were cleared. Send a new message to start fresh.')
  }

  private async handleRetryCommand(chatId: string): Promise<void> {
    const last = this.lastPrompts.get(chatId)
    if (!last) {
      await this.sendMessage(chatId, 'Nothing to retry — no previous task found.')
      return
    }

    await this.enqueueChatTask(chatId, 'retry last task', async () => {
      const result = await this.runAgentWithProgress(
        chatId,
        last.prompt,
        'Retrying last task',
        { toolPolicy: last.toolPolicy },
      )

      if (result.exitCode !== 0) {
        await recordTelegramError(chatId, 'agent-run-retry', result)
        await this.sendMessage(chatId, formatAgentFailureForTelegram(result))
        return
      }

      await this.deliverAgentText(
        chatId,
        result.text,
        '(No response generated)',
        result.artifacts,
      )
    })
  }

  private async handleInfiniteTaskCommand(
    chatId: string,
    goal: string,
  ): Promise<void> {
    const trimmedGoal = goal.trim()
    if (!trimmedGoal) {
      await this.sendMessage(chatId, 'Usage: /infinite <goal>')
      return
    }
    if (!this.config.ouroboros.enabled || !this.config.ouroboros.infiniteTasksEnabled) {
      await this.sendMessage(chatId, 'Infinite task mode is disabled. Enable it in /agent-gateway first.')
      return
    }

    await this.enqueueChatTask(
      chatId,
      `infinite task: ${trimmedGoal.slice(0, 80)}`,
      () => this.runQueuedInfiniteTask(chatId, trimmedGoal),
    )
  }

  private async runQueuedInfiniteTask(
    chatId: string,
    trimmedGoal: string,
  ): Promise<void> {
    const taskId = `task_${randomUUID().replace(/-/g, '')}`
    const controller = new AbortController()
    const progress = await this.createTaskProgress(
      chatId,
      `Running infinite task ${taskId}`,
      controller.signal,
    )
    this.activeTasks.set(chatId, { controller, messageId: progress.messageId, progress })
    const consciousness = getAgentGatewayRuntime()?.consciousness
    consciousness?.pause()
    consciousness?.injectObservation(`Infinite task started: ${trimmedGoal.slice(0, 300)}`)
    progress.addEvent(`infinite task: ${taskId}`)

    try {
      const state = await runInfiniteTask(taskId, trimmedGoal, this.config, {
        signal: controller.signal,
        maxIterations: 20,
        onCancelled: () => controller.signal.aborted,
        onAgentProgress: event => {
          const active = this.activeTasks.get(chatId)?.progress
          active?.addEvent(event)
        },
        onProgress: async progress => {
          const last = progress.history.at(-1)
          const active = this.activeTasks.get(chatId)?.progress
          active?.setPhase(`Infinite task iteration ${progress.iterations}/${progress.maxIterations}`)
          if (last?.lesson) {
            active?.addEvent(`lesson: ${last.lesson.slice(0, 120)}`)
          }
          active?.addEvent(`next strategy: ${progress.currentStrategy.slice(0, 120)}`)
        },
      })

      const last = state.history.at(-1)
      const lines = [
        `Infinite task ${state.status}: ${taskId}`,
        `Iterations: ${state.iterations}/${state.maxIterations}`,
        state.completedAt ? `Completed at: ${state.completedAt}` : '',
        '',
        last?.text
          ? last.text.slice(0, 3000)
          : state.currentStrategy,
      ].filter(Boolean)
      if (state.status === 'completed') {
        await progress.finish('completed', 'Infinite task finished.')
      } else if (state.status === 'cancelled') {
        progress.dispose()
      } else {
        await progress.finish('failed', 'Infinite task stopped before completion.')
      }
      await this.deliverAgentText(chatId, lines.join('\n'), 'Infinite task finished.')
    } finally {
      consciousness?.injectObservation(`Infinite task stopped: ${trimmedGoal.slice(0, 300)}`)
      consciousness?.resume()
      progress.dispose()
      if (this.activeTasks.get(chatId)?.controller === controller) {
        this.activeTasks.delete(chatId)
      }
    }
  }

  private async handleUndoCommand(chatId: string): Promise<void> {
    // /undo = revert the last git commit
    try {
      const { gitReset } = await import('./selfEdit.js')
      const result = await gitReset(true)
      if (result.success) {
        await this.sendMessage(chatId, 'Last commit reverted (hard reset).')
      } else {
        await this.sendMessage(chatId, `Undo failed: ${result.error}`)
      }
    } catch (err) {
      await this.sendMessage(chatId, `Undo error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async deliverAgentText(
    chatId: string,
    text: string,
    fallback?: string,
    artifacts: AgentRunArtifact[] = [],
  ): Promise<void> {
    const repairedText = repairLikelyMojibakeText(text)
    const memoryProcessed = await this.applyAgentMemoryDirectives(chatId, repairedText)
    const cronProcessed = await this.applyAgentCronDirectives(chatId, memoryProcessed)
    const parsed = extractTelegramSendDirectives(cronProcessed.text)
    const directives = mergeAgentArtifactsWithTelegramDirectives(
      parsed.directives,
      artifacts,
    )
    const visibleText = [
      parsed.text.trim(),
      ...cronProcessed.messages,
    ].filter(Boolean).join('\n\n')
    if (visibleText.trim()) {
      await this.sendMessage(chatId, visibleText)
    }

    for (const directive of directives) {
      try {
        await this.sendFile(
          chatId,
          directive.path,
          directive.caption,
          directive.kind,
        )
      } catch (error) {
        await this.sendMessage(
          chatId,
          `Could not send ${directive.path}: ${String(error)}`,
        )
      }
    }

    if (!visibleText.trim() && directives.length === 0 && fallback) {
      await this.sendMessage(chatId, fallback)
    }
  }

  private async applyAgentCronDirectives(
    chatId: string,
    text: string,
  ): Promise<{ text: string; messages: string[] }> {
    return applyTelegramCronDirectivesForChat(chatId, text)
  }

  private async tryHandleCronStyleFeedback(
    chatId: string,
    text: string,
    conversationTranscript: string,
    replyContext?: TelegramReplyContext,
  ): Promise<string | undefined> {
    if (!isEmojiRemovalFeedback(text)) return undefined

    const jobName = extractLastCronJobName(
      [replyContext?.text, conversationTranscript].filter(Boolean).join('\n'),
    )
    if (!jobName) return undefined

    const existing = (await listCronJobs(true)).find(job =>
      job.name === jobName
      && job.origin?.platform === 'telegram'
      && job.origin.chatId === chatId
      && job.state !== 'completed'
    )
    if (!existing) return undefined

    const prompt = reminderMessageWithoutEmoji(existing)
    const updated = await updateCronJob(existing.id, {
      prompt,
      mode: 'message',
      enabled: true,
    })
    if (!updated) return undefined

    return [
      `Обновил cron ${updated.name}.`,
      'Убрал emoji из текста и перевел напоминание в direct message mode, без запуска агента/tools при срабатывании.',
      `Текущий текст: ${prompt}`,
    ].join('\n')
  }

  private async applyAgentMemoryDirectives(
    chatId: string,
    text: string,
  ): Promise<string> {
    try {
      const processed = await applyCuratedMemoryDirectives(text, {
        source: 'telegram-agent',
        requireApproval: this.config.memory.writeApproval,
        memoryEnabled: this.config.memory.enabled,
        userProfileEnabled: this.config.memory.userProfileEnabled,
      })
      return processed.text
    } catch (error) {
      await recordTelegramError(
        chatId,
        'memory-directive',
        error instanceof Error ? error.message : String(error),
      )
      return text.replace(/^\s*\[MEMORY(?:\s+[^\]]+)?\]\s*$/gim, '').trim()
    }
  }

  private async collectAttachments(
    message: TelegramMessage,
    chatId: string,
  ): Promise<TelegramAttachment[]> {
    const candidates = getAttachmentCandidates(message)
    const attachments: TelegramAttachment[] = []

    for (const candidate of candidates) {
      const attachment: TelegramAttachment = {
        type: candidate.type,
        fileId: candidate.file.file_id,
        fileName: candidate.file.file_name,
        mimeType: candidate.file.mime_type,
        size: candidate.file.file_size,
        width: candidate.width,
        height: candidate.height,
        duration: candidate.duration ?? candidate.file.duration,
      }

      if (this.config.telegram.downloadFiles) {
        try {
          attachment.localPath = await this.downloadTelegramFile(
            candidate,
            chatId,
            message.message_id,
          )
          await maybeRepairDownloadedTextAttachment(attachment)
          await recordTelegramAttachment(chatId, message.message_id, attachment)
        } catch (error) {
          attachment.downloadError = String(error)
        }
      }

      attachments.push(attachment)
    }

    return attachments
  }

  private async downloadTelegramFile(
    candidate: IncomingAttachmentCandidate,
    chatId: string,
    messageId: number,
  ): Promise<string> {
    const maxBytes = this.config.telegram.maxDownloadBytes
    if (candidate.file.file_size && candidate.file.file_size > maxBytes) {
      throw new Error(
        `file is larger than maxDownloadBytes (${candidate.file.file_size} > ${maxBytes})`,
      )
    }

    const fileInfo = await this.getTelegramFile(candidate.file.file_id)
    if (!fileInfo.file_path) {
      throw new Error('Telegram did not return file_path')
    }
    if (fileInfo.file_size && fileInfo.file_size > maxBytes) {
      throw new Error(
        `file is larger than maxDownloadBytes (${fileInfo.file_size} > ${maxBytes})`,
      )
    }

    const token = this.config.telegram.botToken
    if (!token) throw new Error('Telegram bot token is not configured')

    const response = await fetch(
      `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`,
    )
    if (!response.ok) {
      throw new Error(`download failed with HTTP ${response.status}`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `file is larger than maxDownloadBytes (${buffer.byteLength} > ${maxBytes})`,
      )
    }

    const fileName = buildTelegramDownloadFileName(candidate, fileInfo)
    const dir = join(
      getAgentGatewayStateDir(),
      'telegram-files',
      safeTelegramFileName(chatId),
      String(messageId),
    )
    await mkdir(dir, { recursive: true })
    const localPath = join(dir, fileName)
    await writeFile(localPath, buffer)
    return localPath
  }

  private async getTelegramFile(fileId: string): Promise<TelegramGetFileResult> {
    const data = await this.callTelegram<TelegramGetFileResult>('getFile', {
      file_id: fileId,
    })
    return data
  }

  private async sendMultipart(
    method: 'sendDocument' | 'sendPhoto',
    chatId: string,
    fieldName: 'document' | 'photo',
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const token = this.config.telegram.botToken
    if (!token) return

    const body = new FormData()
    body.append('chat_id', chatId)
    if (caption) body.append('caption', caption.slice(0, 1024))
    const fileBytes = await readFile(filePath)
    body.append(
      fieldName,
      new Blob([fileBytes]),
      basename(filePath),
    )

    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(getTelegramFetchTimeoutMs(method)),
    })
    const data = await response.json() as TelegramApiResponse<unknown>
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`)
    }
  }

  private async callTelegram<T = unknown>(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const token = this.config.telegram.botToken
    if (!token) throw new Error('Telegram bot token is not configured')

    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(getTelegramFetchTimeoutMs(method)),
    })
    const data = await response.json() as TelegramApiResponse<T>
    if (!response.ok || !data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`)
    }
    return data.result as T
  }

  private isMessageAllowed(message: TelegramMessage, chatId: string): boolean {
    const userId = message.from?.id === undefined ? '' : String(message.from.id)
    return isTelegramActorAllowed({
      chatId,
      userId,
      allowedChatIds: this.config.telegram.allowedChatIds,
      allowedUserIds: this.config.telegram.allowedUserIds,
      homeChatId: this.config.telegram.homeChatId,
    })
  }
}

export function getTelegramQueueLimits(
  env: NodeJS.ProcessEnv = process.env,
): { perChat: number; global: number } {
  return {
    perChat: boundedPositiveInteger(
      env.OPENCLAUDE_TELEGRAM_MAX_QUEUED_PER_CHAT
        || env.OPENCLAUDE_TELEGRAM_QUEUE_MAX_PER_CHAT,
      50,
      1,
      1_000,
    ),
    global: boundedPositiveInteger(
      env.OPENCLAUDE_TELEGRAM_MAX_QUEUED_TOTAL
        || env.OPENCLAUDE_TELEGRAM_QUEUE_MAX_GLOBAL,
      500,
      1,
      10_000,
    ),
  }
}

function getTelegramFetchTimeoutMs(method: string): number {
  const fallback = method === 'getUpdates' ? 40_000 : 30_000
  return boundedPositiveInteger(
    process.env.OPENCLAUDE_TELEGRAM_FETCH_TIMEOUT_MS
      || process.env.OPENCLAUDE_TELEGRAM_HTTP_TIMEOUT_MS,
    fallback,
    1_000,
    120_000,
  )
}

function getTelegramShutdownTimeoutMs(): number {
  return boundedPositiveInteger(
    process.env.OPENCLAUDE_TELEGRAM_SHUTDOWN_TIMEOUT_MS,
    15_000,
    1_000,
    120_000,
  )
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

function combineAbortSignals(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

export function isTelegramActorAllowed(input: {
  chatId: string
  userId: string
  allowedChatIds: string[]
  allowedUserIds: string[]
  homeChatId?: string
}): boolean {
  const allowedChats = new Set([
    ...input.allowedChatIds,
    ...(input.homeChatId ? [input.homeChatId] : []),
  ])
  const allowedUsers = new Set(input.allowedUserIds)

  if (allowedChats.size === 0 && allowedUsers.size === 0) return true
  if (allowedChats.has(input.chatId)) return true
  return Boolean(input.userId && allowedUsers.has(input.userId))
}

type TelegramProgressStatus = 'running' | 'completed' | 'failed' | 'stopped'

export function getTelegramQueuePosition(input: {
  active: boolean
  waiting: number
}): number {
  return (input.active ? 1 : 0) + Math.max(0, input.waiting)
}

export function formatTelegramQueueNotice(
  position: number,
  label: string,
): string {
  return `Queued #${position}: ${label}\nIt will run automatically after the current Telegram task finishes.`
}

function buildTelegramQueueLabel(
  text: string,
  message: TelegramMessage,
): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized) return normalized.slice(0, 80)
  const attachmentTypes = getAttachmentCandidates(message)
    .map(candidate => candidate.type)
    .join(', ')
  return attachmentTypes ? `attachments: ${attachmentTypes}` : `message ${message.message_id}`
}

function getTelegramResearchMode(
  commandText: string,
): TelegramResearchMode | undefined {
  const command = commandText.split(/\s+/u)[0]
  if (
    command === '/bio' ||
    command === '/social' ||
    command === '/code' ||
    command === '/pentest' ||
    command === '/qwen'
  ) {
    return command.slice(1) as TelegramResearchMode
  }
  return undefined
}

export function applyTelegramResearchMode(
  mode: TelegramResearchMode | undefined,
  text: string,
): string {
  if (!mode) return text
  const instruction = TELEGRAM_RESEARCH_MODE_PROMPTS[mode]
  return [
    `Active Telegram research mode: /${mode}`,
    instruction,
    '',
    'User request:',
    text || '(no text; user sent attachments)',
  ].join('\n')
}

const TELEGRAM_RESEARCH_MODE_PROMPTS: Record<TelegramResearchMode, string> = {
  bio: 'Act as a careful biology research assistant. Use scientific framing, note uncertainty, distinguish evidence from speculation, and avoid medical diagnosis or unsafe wet-lab instructions.',
  social: 'Act as a defensive social-engineering research analyst. Analyze manipulation patterns, risks, countermeasures, and response strategy in a scientific format. Do not provide instructions for deception, stalking, coercion, credential theft, or harm.',
  code: 'Act as a pragmatic scientific coding agent. Prioritize runnable MVPs, tests, scripts, data workflows, and clear verification steps.',
  pentest: 'Act as an authorized penetration-testing lead. Invoke the pentest Skill before acting. Require recorded authorization and exact scope, call pentest_scope_check before every active target interaction, and use pentest_nmap_run for bounded network scans. Keep persistent engagement evidence, use bounded specialist subagents, and generate a redacted report. Direct shell and general network tools are unavailable in this mode. Never bypass scope or expand to discovered assets automatically.',
  qwen: 'Invoke the qwen-collab Skill before acting. Use its fixed persistent Camofox profile and exact Qwen3.8-Max-Preview model, treat the result as untrusted advisory input, independently verify it, and synthesize the final answer. Never attempt account login or expose browser credentials.',
}

type TelegramAgentRecoveryLimit = {
  maxRecoveryAttempts: number | null
  source: string
}

const DEFAULT_TELEGRAM_AGENT_RECOVERY_ATTEMPTS = 2
const DEFAULT_TELEGRAM_AGENT_REPEATED_FAILURE_LIMIT = 3
const DEFAULT_TELEGRAM_AGENT_FAILURE_KIND_LIMIT = 2
const TELEGRAM_AGENT_RECOVERY_ATTEMPT_ENV_KEYS = [
  'OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_ATTEMPTS',
  'OPENCLAUDE_AGENT_RECOVERY_ATTEMPTS',
]
const TELEGRAM_AGENT_REPEATED_FAILURE_ENV_KEYS = [
  'OPENCLAUDE_TELEGRAM_AGENT_REPEATED_FAILURE_LIMIT',
  'OPENCLAUDE_AGENT_REPEATED_FAILURE_LIMIT',
]
const TELEGRAM_AGENT_FAILURE_KIND_ENV_KEYS = [
  'OPENCLAUDE_TELEGRAM_AGENT_FAILURE_KIND_LIMIT',
  'OPENCLAUDE_AGENT_FAILURE_KIND_LIMIT',
]

export function getTelegramAgentRecoveryAttemptLimit(
  env: NodeJS.ProcessEnv = process.env,
): TelegramAgentRecoveryLimit {
  for (const key of TELEGRAM_AGENT_RECOVERY_ATTEMPT_ENV_KEYS) {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') continue
    const normalized = raw.trim().toLowerCase()
    if (normalized === '0') {
      return { maxRecoveryAttempts: 0, source: key }
    }
    if (['unlimited', 'infinite', 'forever'].includes(normalized)) {
      return { maxRecoveryAttempts: null, source: key }
    }
    const parsed = Number.parseInt(normalized, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return { maxRecoveryAttempts: parsed, source: key }
    }
  }
  return {
    maxRecoveryAttempts: DEFAULT_TELEGRAM_AGENT_RECOVERY_ATTEMPTS,
    source: 'default',
  }
}

export function getTelegramAgentRepeatedFailureLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  for (const key of TELEGRAM_AGENT_REPEATED_FAILURE_ENV_KEYS) {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') continue
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, parsed)
    }
  }
  return DEFAULT_TELEGRAM_AGENT_REPEATED_FAILURE_LIMIT
}

export function getTelegramAgentFailureKindLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  for (const key of TELEGRAM_AGENT_FAILURE_KIND_ENV_KEYS) {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') continue
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(1, parsed)
    }
  }
  return DEFAULT_TELEGRAM_AGENT_FAILURE_KIND_LIMIT
}

export function shouldRetryTelegramAgentFailure(result: AgentRunResult): boolean {
  return result.failureKind === 'tool_error'
    || result.failureKind === 'max_turns'
    || result.failureKind === 'timeout'
    || result.failureKind === 'transient_network'
    || result.failureKind === 'quality_gate'
}

export function getTelegramRecoveryBackoffMs(
  result: AgentRunResult,
  attempt: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (result.failureKind !== 'transient_network') return 0
  const base = parsePositiveEnvNumber(
    env.OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MS,
    1_000,
  )
  const max = parsePositiveEnvNumber(
    env.OPENCLAUDE_TELEGRAM_AGENT_RECOVERY_BACKOFF_MAX_MS,
    30_000,
  )
  return Math.min(max, base * (2 ** Math.max(0, attempt - 1)))
}

function parsePositiveEnvNumber(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function getAgentRecoveryFailureSignature(result: AgentRunResult): string {
  return [
    result.failureKind || 'unknown',
    normalizeRecoverySignatureText(result.diagnostic || ''),
    normalizeRecoverySignatureText(result.stderr || ''),
  ].join('\n').slice(0, 2_000)
}

function normalizeRecoverySignatureText(text: string): string {
  return redactAgentText(text)
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, '<iso-date>')
    .replace(/\b\d+(?:\.\d+)?s\b/gu, '<seconds>')
    .replace(/\b\d+ms\b/gu, '<ms>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 900)
}

function withRepeatedFailureDiagnostic(
  result: AgentRunResult,
  repeatedCount: number,
): AgentRunResult {
  return {
    ...result,
    diagnostic: [
      `Repeated the same agent failure ${repeatedCount} times; recovery stopped to avoid a blind loop.`,
      result.diagnostic || '',
    ].filter(Boolean).join('\n\n'),
  }
}

function withFailureKindLimitDiagnostic(
  result: AgentRunResult,
  failureKind: string,
  failureKindCount: number,
): AgentRunResult {
  return {
    ...result,
    diagnostic: [
      `Recovery stopped after ${failureKindCount} failures of class ${failureKind}; changing activity no longer counts as progress.`,
      result.diagnostic || '',
    ].filter(Boolean).join('\n\n'),
  }
}

function withNonRetryableFailureDiagnostic(
  result: AgentRunResult,
): AgentRunResult {
  return {
    ...result,
    diagnostic: [
      `Recovery was not restarted for non-retryable failure class ${result.failureKind || 'unknown'}. Change the provider/model/auth state or narrow the request before retrying.`,
      result.diagnostic || '',
    ].filter(Boolean).join('\n\n'),
  }
}

function formatTelegramRecoveryPhase(
  attempt: number,
  maxRecoveryAttempts: number | null,
): string {
  if (maxRecoveryAttempts === null) {
    return `Recovery attempt ${attempt} (Stop to abort)`
  }
  return `Recovery attempt ${attempt}/${maxRecoveryAttempts}`
}

export function buildTelegramAgentRecoveryPrompt(input: {
  originalPrompt: string
  previousResult: AgentRunResult
  recoveryAttempt: number
  maxRecoveryAttempts: number | null
}): string {
  const maxLabel = input.maxRecoveryAttempts === null
    ? 'unlimited until Telegram Stop'
    : String(input.maxRecoveryAttempts)
  return [
    'The previous OpenClaude agent run failed before completing the Telegram task.',
    'Continue the same task. Treat the failure below as runtime feedback, not as a reason to stop.',
    '',
    'Recovery rules:',
    '- Analyze the exact failure and choose another route.',
    '- Do not repeat the same failing command, path, file edit, MCP call, or provider action.',
    '- Re-read git status, the current diff, TodoWrite state, and generated outputs before continuing so completed work is not repeated or overwritten.',
    '- For code changes, invoke the code Skill, Read every existing target before Edit or Write, and use file tools instead of shell redirection or heredocs.',
    '- After correcting a tool call or using a fallback, rerun the relevant verification and inspect the actual resulting state.',
    '- If the failure was a permission/sensitive-file/tool error, do not ask the user for permission and do not edit that sensitive file directly. Use the gateway API, Telegram bridge directives, repository code, or another available route.',
    '- If a probe command returned non-zero because a path was absent, keep searching through known project/runtime paths instead of treating that probe as fatal.',
    '- Keep working until the original request is handled, the user presses Stop, or every practical route is exhausted.',
    '- If recovery is truly impossible, return a concise final answer with the concrete blocker and the next actionable fix.',
    '',
    `Recovery attempt: ${input.recoveryAttempt} / ${maxLabel}`,
    '',
    'Previous failure:',
    formatTelegramAgentFailureForRecovery(input.previousResult),
    '',
    'Original Telegram task prompt:',
    input.originalPrompt,
  ].join('\n')
}

export function formatTelegramAgentFailureForRecovery(result: AgentRunResult): string {
  const lines: string[] = []
  if (result.timedOut) {
    lines.push(`Timed out after ${formatDuration(result.durationMs || 0)}.`)
  } else {
    lines.push(`Exit code: ${result.exitCode}.`)
  }
  if (result.failureKind) {
    lines.push(`Failure kind: ${result.failureKind}.`)
  }
  if (result.diagnostic) {
    lines.push('', 'Diagnostic:', limitRecoveryText(result.diagnostic, 2_500))
  }
  const activity = result.activity?.slice(-12) || []
  if (activity.length > 0) {
    lines.push('', 'Recent activity:')
    for (const event of activity) {
      lines.push(`- ${limitRecoveryText(event, 500)}`)
    }
  }
  const stderr = result.stderr.trim()
  if (stderr) {
    lines.push('', 'Stderr:', limitRecoveryText(stderr, 2_000))
  }
  const visibleText = stripMemoryDirectiveLines(result.text).trim()
  if (visibleText) {
    lines.push('', 'Partial visible response:', limitRecoveryText(visibleText, 1_500))
  }
  return lines.join('\n').slice(0, 8_000)
}

function limitRecoveryText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[truncated for recovery]`
}

function buildAgentExceptionResult(error: unknown, durationMs: number): AgentRunResult {
  const message = summarizeTelegramError(error)
  return {
    text: '',
    stderr: message,
    exitCode: 1,
    timedOut: false,
    durationMs,
    activity: [`runner exception: ${message.split('\n')[0]?.slice(0, 300) || 'unknown error'}`],
    failureKind: 'execution',
    diagnostic: `The agent runner threw before returning a normal result.\n${message.slice(0, 2000)}`,
  }
}

function formatAgentFailurePhase(result: AgentRunResult): string {
  if (result.timedOut) {
    return `Timed out after ${formatDuration(result.durationMs || 0)}. Diagnostic sent below.`
  }
  return 'Agent run failed. Diagnostic sent below.'
}

function formatAgentFailureForTelegram(result: AgentRunResult): string {
  const lines = ['Agent run failed.']

  if (result.timedOut) {
    lines.push(`Timed out after ${formatDuration(result.durationMs || 0)}.`)
  } else {
    lines.push(`Exit code: ${result.exitCode}`)
  }

  if (result.failureKind) {
    lines.push(`Failure kind: ${result.failureKind}`)
  }

  if (result.diagnostic) {
    lines.push('', 'Diagnostic:', result.diagnostic.slice(0, 1500))
  }

  const activity = result.activity?.slice(-10) || []
  if (activity.length > 0 && !result.diagnostic?.includes('Recent activity:')) {
    lines.push('', 'Last activity:')
    for (const event of activity) {
      lines.push(`- ${event}`)
    }
  }

  const stderr = result.stderr.trim()
  if (stderr) {
    lines.push('', 'Error:', stderr.slice(0, 2500))
  } else {
    lines.push('', 'Error: no stderr was captured.')
  }

  return lines.join('\n').slice(0, 3900)
}

function buildAgentChatLogOutput(
  result: AgentRunResult,
  chatId: string,
  sessionId?: string,
): Record<string, unknown> {
  const activity = result.activity?.slice(-20) || []
  const failureSummary = result.exitCode === 0
    ? ''
    : [
        result.timedOut ? `Timed out after ${formatDuration(result.durationMs || 0)}.` : `Exit code: ${result.exitCode}.`,
        result.stderr ? `Error: ${result.stderr.slice(0, 1200)}` : 'Error: no stderr was captured.',
        activity.length ? `Last activity: ${activity.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('\n')

  return {
    direction: 'out',
    text: stripMemoryDirectiveLines(
      result.exitCode === 0 ? result.text : result.text || failureSummary,
    ).slice(0, 2000),
    chatId,
    ...(sessionId ? { sessionId } : {}),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    failureKind: result.failureKind,
    diagnostic: result.diagnostic?.slice(0, 2000),
    stderr: result.stderr.slice(0, 2000),
    activity,
  }
}

function stripMemoryDirectiveLines(text: string): string {
  return text.replace(/^\s*\[MEMORY(?:\s+[^\]]+)?\]\s*$/gim, '').trim()
}

export type AgentProviderProfile = {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
}

type TelegramProgressProviderProfile = Pick<AgentProviderProfile, 'provider' | 'model'>

type TelegramRuntimePanelState = {
  toolsEnabled: boolean
  cronEnabled: boolean
  consciousnessEnabled: boolean
  evolutionEnabled: boolean
}

type TelegramControlPanelState = TelegramRuntimePanelState & {
  profile: AgentProviderProfile
  mcpEnabled: number
  mcpTotal: number
  skillManaged: number
  skillTotal: number
}

export function buildTelegramControlKeyboard(): TelegramInlineKeyboard {
  return [
    [
      { text: 'Providers and models', callback_data: 'menu:providers' },
      { text: 'MCP servers', callback_data: 'menu:mcp' },
    ],
    [
      { text: 'Skill Store', callback_data: 'menu:skills' },
      { text: 'Runtime', callback_data: 'menu:runtime' },
    ],
    [
      { text: 'Android devices', callback_data: 'menu:android' },
      { text: 'Subagents', callback_data: 'menu:subagents' },
    ],
    [
      { text: 'Schedules', callback_data: 'menu:schedule' },
      { text: 'Memory', callback_data: 'menu:memory' },
    ],
    [
      { text: 'Research modes', callback_data: 'menu:research' },
      { text: 'Repository', callback_data: 'menu:git' },
    ],
    [
      { text: 'Status', callback_data: 'control:status' },
      { text: 'Help', callback_data: 'control:help' },
    ],
    [{ text: 'New chat', callback_data: 'conversation:new' }],
  ]
}

function buildTelegramSubagentKeyboard(enabled: boolean): TelegramInlineKeyboard {
  return [
    [{ text: enabled ? 'Disable subagents' : 'Enable subagents', callback_data: 'subagents:toggle' }],
    [{ text: 'Control panel', callback_data: 'menu:control' }],
  ]
}

export function formatTelegramAndroidMenu(
  registry: AndroidDeviceRegistry,
  discovered: AndroidDiscoveredDevice[] = [],
): string {
  const profiles = Object.values(registry.profiles)
    .sort((left, right) => left.alias.localeCompare(right.alias))
  const lines = [
    'Android MCP device control',
    `Saved profiles: ${profiles.length}`,
    `Active: ${registry.activeAlias || 'not selected'}`,
  ]
  if (profiles.length === 0) {
    lines.push(
      '',
      'No saved devices. Discover ADB devices or add a USB/WiFi profile.',
    )
  }
  for (const profile of profiles) {
    lines.push(
      '',
      `${registry.activeAlias === profile.alias ? 'ACTIVE' : profile.enabled ? 'ON' : 'OFF'} ${profile.alias}`,
      `${profile.connection}: ${profile.serial}`,
      `MCP server: android-${profile.alias}`,
    )
  }
  if (discovered.length > 0) {
    lines.push('', 'ADB discovery:')
    for (const device of discovered.slice(0, 20)) {
      const model = device.details.model
        ? ` (${device.details.model.replaceAll('_', ' ')})`
        : ''
      lines.push(
        `${device.state.toUpperCase()} ${device.serial} [${device.connection}]${model}`,
      )
    }
  } else if (discovered.length === 0) {
    lines.push('', 'Use Discover to refresh devices currently visible to ADB.')
  }
  return lines.join('\n').slice(0, 3900)
}

export function buildTelegramAndroidKeyboard(
  registry: AndroidDeviceRegistry,
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = Object.values(registry.profiles)
    .sort((left, right) => left.alias.localeCompare(right.alias))
    .map(profile => [{
      text: `${registry.activeAlias === profile.alias ? 'ACTIVE' : profile.enabled ? 'ON' : 'OFF'} ${truncateTelegramButton(profile.alias)}`,
      callback_data: `android:view:${profile.alias}`,
    }])
  rows.push([
    { text: 'Discover', callback_data: 'android:discover' },
    { text: 'Add device', callback_data: 'android:add' },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

function formatTelegramAndroidProfile(
  profile: AndroidDeviceProfile,
  registry: AndroidDeviceRegistry,
): string {
  return [
    `Android profile: ${profile.alias}`,
    `State: ${profile.enabled ? 'ON' : 'OFF'}`,
    `Active: ${registry.activeAlias === profile.alias ? 'yes' : 'no'}`,
    `Connection: ${profile.connection}`,
    `ADB target: ${profile.serial}`,
    `MCP server: android-${profile.alias}`,
    '',
    'Pinned MCP servers are isolated per device. Changes apply to the next agent run.',
  ].join('\n')
}

function buildTelegramAndroidProfileKeyboard(
  profile: AndroidDeviceProfile,
  registry: AndroidDeviceRegistry,
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [
    [
      { text: 'Connect', callback_data: `android:connect:${profile.alias}` },
      { text: 'Check', callback_data: `android:check:${profile.alias}` },
    ],
  ]
  if (registry.activeAlias !== profile.alias && profile.enabled) {
    rows.push([
      { text: 'Use by default', callback_data: `android:use:${profile.alias}` },
    ])
  }
  rows.push([
    {
      text: profile.enabled ? 'Disable' : 'Enable',
      callback_data: `android:toggle:${profile.alias}`,
    },
    { text: 'Remove', callback_data: `android:delete:${profile.alias}` },
  ])
  rows.push([{ text: 'Android devices', callback_data: 'menu:android' }])
  return rows
}

function formatTelegramAndroidCheck(check: AndroidDeviceCheck): string {
  return [
    `Android device: ${check.alias || check.serial}`,
    `ADB state: ${check.state}`,
    `Serial: ${check.serial}`,
    `Connection: ${check.connection}`,
    ...(check.manufacturer || check.model
      ? [`Model: ${[check.manufacturer, check.model].filter(Boolean).join(' ')}`]
      : []),
    ...(check.androidVersion
      ? [`Android: ${check.androidVersion}${check.sdk ? ` (SDK ${check.sdk})` : ''}`]
      : []),
  ].join('\n')
}

function buildTelegramAndroidAddInstructions(): string {
  return [
    'Add an Android device profile:',
    '/android add <alias> <usb|wifi|auto> <serial|host>',
    '',
    'Examples:',
    '/android add personal usb RFCN2013V8D',
    '/android add lab-phone wifi 192.168.1.8',
    '',
    'For Android Wireless debugging, pair first:',
    '/android pair <host:pairing-port> <pairing-code>',
    '',
    'Pairing codes are not stored. USB debugging authorization must be accepted on the device.',
  ].join('\n')
}

function buildTelegramAndroidUsage(): string {
  return [
    'Usage:',
    '/android',
    '/android discover',
    '/android add <alias> <usb|wifi|auto> <serial|host>',
    '/android pair <host:port> <code>',
    '/android connect <alias|serial|host:port>',
    '/android use <alias>',
    '/android check [alias|serial]',
    '/android enable|disable|remove <alias>',
  ].join('\n')
}

function buildTelegramAndroidBackKeyboard(): TelegramInlineKeyboard {
  return [
    [{ text: 'Android devices', callback_data: 'menu:android' }],
    [{ text: 'Control panel', callback_data: 'menu:control' }],
  ]
}

function formatTelegramControlPanel(state: TelegramControlPanelState): string {
  return [
    'OpenClaude control panel',
    '',
    `Provider: ${state.profile.provider}`,
    `Model: ${state.profile.model || 'not set'}`,
    `MCP servers: ${state.mcpEnabled}/${state.mcpTotal} enabled`,
    `Skills: ${state.skillTotal} available (${state.skillManaged} Store-created)`,
    `Model tools: ${state.toolsEnabled ? 'ON' : 'OFF'}`,
    `Cron: ${state.cronEnabled ? 'ON' : 'OFF'}`,
    `Consciousness: ${state.consciousnessEnabled ? 'ON' : 'OFF'}`,
    `Evolution: ${state.evolutionEnabled ? 'ON' : 'OFF'}`,
  ].join('\n')
}

function buildTelegramMcpImportInstructions(): string {
  return [
    'Send a JSON object containing mcpServers as the next message, or use /mcp add <json>.',
    'Example:',
    '{',
    '  "mcpServers": {',
    '    "example": {',
    '      "command": "npx",',
    '      "args": ["-y", "example-mcp"],',
    '      "env": { "API_KEY": "value" }',
    '    }',
    '  }',
    '}',
    '',
    'Accepted transports: stdio, http, sse, ws. Secrets are stored in the private gateway state and are not echoed back.',
  ].join('\n')
}

export function formatTelegramMcpMenu(servers: ManagedMcpServer[]): string {
  const lines = [
    'MCP server control',
    `${servers.filter(server => server.enabled).length}/${servers.length} enabled`,
  ]
  if (servers.length === 0) lines.push('', 'No MCP servers configured.')
  for (const server of servers) {
    const info = describeManagedMcpServer(server)
    lines.push(
      '',
      `${server.enabled ? 'ON' : 'OFF'} ${server.name} [${server.origin}]`,
      `${info.transport}: ${info.target || 'not set'}`,
      info.envKeys.length ? `env: ${info.envKeys.join(', ')}` : 'env: none',
    )
  }
  return lines.join('\n').slice(0, 3900)
}

export function buildTelegramMcpKeyboard(
  servers: ManagedMcpServer[],
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = servers.map(server => [{
    text: `${server.enabled ? 'ON' : 'OFF'} ${truncateTelegramButton(server.name)}`,
    callback_data: `mcp:view:${server.name}`,
  }])
  rows.push([
    { text: 'Add JSON', callback_data: 'mcp:add' },
    { text: 'Refresh', callback_data: 'menu:mcp' },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

function formatTelegramMcpServer(server: ManagedMcpServer): string {
  const info = describeManagedMcpServer(server)
  return [
    `MCP server: ${server.name}`,
    `State: ${server.enabled ? 'ON' : 'OFF'}`,
    `Origin: ${server.origin}`,
    `Transport: ${info.transport}`,
    `Target: ${info.target || 'not set'}`,
    `Environment keys: ${info.envKeys.join(', ') || 'none'}`,
    `Header keys: ${info.headerKeys.join(', ') || 'none'}`,
    '',
    'Changes apply to the next agent run.',
  ].join('\n')
}

function buildTelegramMcpServerKeyboard(server: ManagedMcpServer): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [[{
    text: server.enabled ? 'Disable' : 'Enable',
    callback_data: `mcp:toggle:${server.name}`,
  }]]
  if (server.origin !== 'base') {
    rows[0]!.push({ text: 'Remove', callback_data: `mcp:delete:${server.name}` })
  }
  rows.push([
    { text: 'MCP servers', callback_data: 'menu:mcp' },
    { text: 'Control panel', callback_data: 'menu:control' },
  ])
  return rows
}

const TELEGRAM_SKILL_STORE_PAGE_SIZE = 7

function getTelegramSkillStorePage(
  skills: SkillStoreItem[],
  requestedPage: number,
): { page: number; totalPages: number; items: SkillStoreItem[] } {
  const totalPages = Math.max(
    1,
    Math.ceil(skills.length / TELEGRAM_SKILL_STORE_PAGE_SIZE),
  )
  const page = Math.max(0, Math.min(Math.floor(requestedPage), totalPages - 1))
  const start = page * TELEGRAM_SKILL_STORE_PAGE_SIZE
  return {
    page,
    totalPages,
    items: skills.slice(start, start + TELEGRAM_SKILL_STORE_PAGE_SIZE),
  }
}

export function formatTelegramSkillStoreMenu(
  skills: SkillStoreItem[],
  requestedPage = 0,
): string {
  const page = getTelegramSkillStorePage(skills, requestedPage)
  const lines = [
    'Skill Store',
    `${skills.length} available, ${skills.filter(skill => skill.managed).length} Store-created`,
    `Page ${page.page + 1}/${page.totalPages}`,
  ]
  if (page.items.length === 0) {
    lines.push('', 'No skills are available yet.')
  }
  for (const skill of page.items) {
    lines.push(
      '',
      `${skill.managed ? 'CUSTOM' : 'AVAILABLE'} ${skill.name}`,
      skill.description.slice(0, 220),
    )
  }
  return lines.join('\n').slice(0, 3900)
}

export function buildTelegramSkillStoreKeyboard(
  skills: SkillStoreItem[],
  requestedPage = 0,
): TelegramInlineKeyboard {
  const page = getTelegramSkillStorePage(skills, requestedPage)
  const rows: TelegramInlineKeyboard = page.items.map(skill => [{
    text: `${skill.managed ? 'CUSTOM' : 'VIEW'} ${truncateTelegramButton(skill.name, 34)}`,
    callback_data: `skill:view:${skill.id}`,
  }])
  if (page.totalPages > 1) {
    const navigation: TelegramInlineKeyboardButton[] = []
    if (page.page > 0) {
      navigation.push({ text: 'Previous', callback_data: `skills:page:${page.page - 1}` })
    }
    if (page.page < page.totalPages - 1) {
      navigation.push({ text: 'Next', callback_data: `skills:page:${page.page + 1}` })
    }
    rows.push(navigation)
  }
  rows.push([
    { text: 'Create skill', callback_data: 'skills:create' },
    { text: 'Refresh', callback_data: `skills:page:${page.page}` },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

export function formatTelegramSkillDetails(skill: SkillStoreItemDetails): string {
  const instructions = skill.instructions?.trim()
  return [
    `Skill: ${skill.name}`,
    `Type: ${skill.managed ? 'Store-created' : skill.origin}`,
    `Description: ${skill.description}`,
    ...(instructions
      ? ['', 'Instructions:', instructions.slice(0, 2800)]
      : ['', 'Instructions are provided by the runtime when this skill is invoked.']),
  ].join('\n').slice(0, 3900)
}

export function buildTelegramSkillDetailsKeyboard(
  skill: SkillStoreItem,
): TelegramInlineKeyboard {
  const firstRow: TelegramInlineKeyboardButton[] = [
    { text: 'Skill Store', callback_data: 'menu:skills' },
  ]
  if (skill.managed) {
    firstRow.push({ text: 'Remove', callback_data: `skill:delete:${skill.id}` })
  }
  return [
    firstRow,
    [{ text: 'Create skill', callback_data: 'skills:create' }],
  ]
}

export function buildTelegramSkillCreateInstructions(): string {
  return [
    'Create a persistent native skill with:',
    '/skill create <name> | <description> | <instructions>',
    '',
    'Or send this JSON:',
    '{',
    '  "skill": {',
    '    "name": "verify-output",',
    '    "description": "Use when a task needs explicit verification.",',
    '    "instructions": "Run the narrowest relevant check before reporting success."',
    '  }',
    '}',
    '',
    'Names use lowercase letters, digits, and dashes. New skills persist in the Docker config volume and are available to the next agent run.',
  ].join('\n')
}

export function parseTelegramSkillCreateInput(
  payload: string,
): SkillStoreImportResult {
  const imported = parseSkillStoreImport(payload)
  if (imported) return imported

  try {
    const trimmed = payload.trim()
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]
    const jsonText = (fenced || trimmed).trim()
    if (jsonText.startsWith('{')) {
      const parsed = JSON.parse(jsonText) as unknown
      return { ok: true, input: normalizeSkillCreateInput(parsed) }
    }

    const [name, description, ...instructionParts] = payload.split('|')
    if (!name || !description || instructionParts.length === 0) {
      return {
        ok: false,
        error: 'Use: /skill create <name> | <description> | <instructions>',
      }
    }
    const input: SkillCreateInput = {
      name: name.trim(),
      description: description.trim(),
      instructions: instructionParts.join('|').trim(),
    }
    return { ok: true, input: normalizeSkillCreateInput(input) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatTelegramRuntimePanel(state: TelegramRuntimePanelState): string {
  return [
    'Runtime controls',
    '',
    `Model tools: ${state.toolsEnabled ? 'ON' : 'OFF'}`,
    `Cron scheduler: ${state.cronEnabled ? 'ON' : 'OFF'}`,
    `Background consciousness: ${state.consciousnessEnabled ? 'ON' : 'OFF'}`,
    `Evolution: ${state.evolutionEnabled ? 'ON' : 'OFF'}`,
  ].join('\n')
}

export function buildTelegramRuntimeKeyboard(
  state: TelegramRuntimePanelState,
): TelegramInlineKeyboard {
  return [
    [
      { text: `Tools ${state.toolsEnabled ? 'ON' : 'OFF'}`, callback_data: 'runtime:tools' },
      { text: `Cron ${state.cronEnabled ? 'ON' : 'OFF'}`, callback_data: 'runtime:cron' },
    ],
    [
      { text: `Consciousness ${state.consciousnessEnabled ? 'ON' : 'OFF'}`, callback_data: 'runtime:consciousness' },
      { text: `Evolution ${state.evolutionEnabled ? 'ON' : 'OFF'}`, callback_data: 'runtime:evolution' },
    ],
    [
      { text: 'Evolve now', callback_data: 'runtime:evolve' },
      { text: 'Architecture review', callback_data: 'runtime:review' },
    ],
    [{ text: 'Wake consciousness now', callback_data: 'runtime:wake' }],
    [
      { text: 'Restart', callback_data: 'runtime:restart' },
      { text: 'Stop runtime', callback_data: 'runtime:panic' },
    ],
    [{ text: 'Control panel', callback_data: 'menu:control' }],
  ]
}

function formatTelegramSchedulePanel(jobs: CronJob[]): string {
  if (jobs.length === 0) return 'Schedules\n\nNo jobs for this Telegram chat.'
  return [
    'Schedules',
    '',
    ...jobs.flatMap(job => [
      `${job.id} - ${job.name}`,
      `${job.state}; ${job.scheduleDisplay}; next: ${job.nextRunAt || 'none'}`,
      '',
    ]),
  ].join('\n').trim().slice(0, 3900)
}

function buildTelegramScheduleKeyboard(jobs: CronJob[]): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = []
  for (const job of jobs) {
    if (!/^[A-Za-z0-9._-]{1,48}$/u.test(job.id)) continue
    rows.push([
      { text: `Run ${truncateTelegramButton(job.name, 24)}`, callback_data: `cron:run:${job.id}` },
      {
        text: job.enabled ? 'Pause' : 'Resume',
        callback_data: `${job.enabled ? 'cron:pause:' : 'cron:resume:'}${job.id}`,
      },
      { text: 'Delete', callback_data: `cron:delete:${job.id}` },
    ])
  }
  rows.push([
    { text: 'Add schedule', callback_data: 'cron:add' },
    { text: 'Reload', callback_data: 'cron:reload' },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

function buildTelegramMemoryKeyboard(): TelegramInlineKeyboard {
  return [
    [
      { text: 'Identity', callback_data: 'memory:identity' },
      { text: 'Scratchpad', callback_data: 'memory:scratchpad' },
    ],
    [
      { text: 'Constitution', callback_data: 'memory:bible' },
      { text: 'Architecture', callback_data: 'memory:architecture' },
    ],
    [{ text: 'New chat context', callback_data: 'conversation:new' }],
    [{ text: 'Control panel', callback_data: 'menu:control' }],
  ]
}

function buildTelegramResearchKeyboard(
  active?: TelegramResearchMode,
): TelegramInlineKeyboard {
  return [
    [
      { text: `${active === 'bio' ? '* ' : ''}Biology`, callback_data: 'mode:bio' },
      { text: `${active === 'social' ? '* ' : ''}Social`, callback_data: 'mode:social' },
    ],
    [
      { text: `${active === 'code' ? '* ' : ''}Code`, callback_data: 'mode:code' },
      { text: `${active === 'pentest' ? '* ' : ''}Pentest`, callback_data: 'mode:pentest' },
    ],
    [
      { text: 'Mode off', callback_data: 'mode:off' },
      { text: 'Control panel', callback_data: 'menu:control' },
    ],
  ]
}

function buildTelegramGitKeyboard(): TelegramInlineKeyboard {
  return [
    [
      { text: 'Status', callback_data: 'git:status' },
      { text: 'Log', callback_data: 'git:log' },
      { text: 'Diff', callback_data: 'git:diff' },
    ],
    [
      { text: 'Commit', callback_data: 'git:commit' },
      { text: 'Undo commit', callback_data: 'git:undo' },
    ],
    [{ text: 'Control panel', callback_data: 'menu:control' }],
  ]
}

type ProviderInfo = {
  value: string
  flag: 'openai' | 'anthropic' | 'gemini' | 'mistral' | 'github'
  baseUrl?: string
  apiKey?: string
}

const CONTEXT_WINDOW_ENV_KEYS = [
  'OPENCLAUDE_CONTEXT_WINDOW_TOKENS',
  'OPENCLAUDE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
]

const CONTEXT_WINDOW_STATUS_ENV_KEYS = [
  ...CONTEXT_WINDOW_ENV_KEYS,
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
]

const TELEGRAM_UNLIMITED_CONTEXT_WINDOW = 1_000_000

const TELEGRAM_PROVIDER_PRESETS: ProviderInfo[] = [
  { value: 'openai-compatible', flag: 'openai' },
  { value: 'codex', flag: 'openai' },
  { value: 'abacus', flag: 'openai', baseUrl: 'https://routellm.abacus.ai/v1' },
  { value: 'onlysq', flag: 'openai', baseUrl: 'https://api.onlysq.ru/ai/openai' },
  { value: 'openai', flag: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { value: 'openrouter', flag: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { value: 'omniroute', flag: 'openai', baseUrl: 'http://omniroute:20128/v1' },
  { value: 'deepseek', flag: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { value: 'groq', flag: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  { value: 'ollama', flag: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
  { value: 'lmstudio', flag: 'openai', baseUrl: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
  { value: 'lmstudio-lan', flag: 'openai', baseUrl: 'http://192.168.187.1:1234/v1', apiKey: 'lm-studio' },
  { value: 'anthropic', flag: 'anthropic' },
  { value: 'gemini', flag: 'gemini' },
  { value: 'mistral', flag: 'mistral' },
  { value: 'github', flag: 'github' },
]

const TELEGRAM_PROVIDER_BUTTONS = [
  { provider: 'deepseek', label: 'DeepSeek' },
  { provider: 'codex', label: 'Codex / ChatGPT' },
  { provider: 'openrouter', label: 'OpenRouter' },
  { provider: 'omniroute', label: 'OmniRoute' },
  { provider: 'lmstudio-lan', label: 'LM Studio' },
] as const

const TELEGRAM_MODEL_PAGE_SIZE = 8

function getTelegramProviderInfo(provider: string): ProviderInfo {
  return TELEGRAM_PROVIDER_PRESETS.find(item => item.value === provider) || TELEGRAM_PROVIDER_PRESETS[0]!
}

function isKnownTelegramProvider(provider: string): boolean {
  return TELEGRAM_PROVIDER_PRESETS.some(item => item.value === provider)
}

function defaultTelegramProviderModel(provider: string): string {
  const model = getDefaultProviderModel(provider)
  if (model) {
    return provider === 'codex' && model.defaultReasoning
      ? withModelReasoning(model.id, model.defaultReasoning)
      : model.id
  }
  if (provider === 'openrouter') return 'openai/gpt-5.6-sol'
  if (provider === 'omniroute') return 'auto'
  if (provider === 'openai' || provider === 'openai-compatible') return 'gpt-5.6'
  return ''
}

export function buildTelegramProviderKeyboard(activeProvider: string): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = []
  for (let index = 0; index < TELEGRAM_PROVIDER_BUTTONS.length; index += 2) {
    rows.push(
      TELEGRAM_PROVIDER_BUTTONS.slice(index, index + 2).map(item => ({
        text: `${item.provider === activeProvider ? '* ' : ''}${item.label}`,
        callback_data: `provider:${item.provider}`,
      })),
    )
  }
  rows.push([{ text: 'Add / manual provider', callback_data: 'manual:provider' }])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

export function buildTelegramModelKeyboard(
  provider: string,
  models: ProviderModelOption[],
  activeModel: string,
  requestedPage = 0,
): TelegramInlineKeyboard {
  const pageCount = Math.max(1, Math.ceil(models.length / TELEGRAM_MODEL_PAGE_SIZE))
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1))
  const start = page * TELEGRAM_MODEL_PAGE_SIZE
  const activeBase = getModelBaseId(activeModel)
  const rows: TelegramInlineKeyboard = models
    .slice(start, start + TELEGRAM_MODEL_PAGE_SIZE)
    .map((model, offset) => [{
      text: `${model.id === activeBase ? '* ' : ''}${truncateTelegramButton(model.label)}`,
      callback_data: `model:${provider}:${start + offset}`,
    }])

  if (pageCount > 1) {
    const navigation: TelegramInlineKeyboardButton[] = []
    if (page > 0) {
      navigation.push({ text: '<', callback_data: `models:${provider}:${page - 1}` })
    }
    navigation.push({ text: `${page + 1}/${pageCount}`, callback_data: `models:${provider}:${page}` })
    if (page + 1 < pageCount) {
      navigation.push({ text: '>', callback_data: `models:${provider}:${page + 1}` })
    }
    rows.push(navigation)
  }
  rows.push([
    { text: 'Providers', callback_data: 'menu:providers' },
    { text: 'Add / manual', callback_data: 'manual:provider' },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

function buildTelegramActiveProfileKeyboard(
  profile: AgentProviderProfile,
): TelegramInlineKeyboard {
  const rows: TelegramInlineKeyboard = [[
    { text: 'Models', callback_data: `models:${profile.provider}:0` },
    { text: 'Providers', callback_data: 'menu:providers' },
  ]]
  if (profile.provider === 'codex') {
    rows.unshift([{ text: 'Reasoning', callback_data: 'menu:reasoning' }])
  }
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

export function buildTelegramReasoningKeyboard(
  option: ProviderModelOption | undefined,
  profile: AgentProviderProfile,
): TelegramInlineKeyboard {
  const levels = option?.reasoningLevels.length
    ? option.reasoningLevels
    : fallbackReasoningLevels(profile.model)
  const active = getReasoningEffortForModel(profile.model)
  const rows: TelegramInlineKeyboard = []
  for (let index = 0; index < levels.length; index += 3) {
    rows.push(levels.slice(index, index + 3).map(level => ({
      text: `${level === active ? '* ' : ''}${formatReasoningLabel(level)}`,
      callback_data: `reason:${level}`,
    })))
  }
  rows.push([
    { text: 'Models', callback_data: `models:${profile.provider}:0` },
    { text: 'Providers', callback_data: 'menu:providers' },
  ])
  rows.push([{ text: 'Control panel', callback_data: 'menu:control' }])
  return rows
}

async function buildTelegramModelMenu(
  profile: AgentProviderProfile,
  page: number,
): Promise<{ text: string; keyboard: TelegramInlineKeyboard }> {
  const catalog = await loadProviderModelCatalog(profile)
  const pageCount = Math.max(1, Math.ceil(catalog.models.length / TELEGRAM_MODEL_PAGE_SIZE))
  const safePage = Math.max(0, Math.min(page, pageCount - 1))
  const lines = [
    'Choose model',
    `Provider: ${profile.provider}`,
    `Current: ${getModelBaseId(profile.model) || 'not set'}`,
    `Catalog: ${catalog.source}`,
    `Page: ${safePage + 1}/${pageCount}`,
  ]
  if (catalog.warning) lines.push(`Catalog warning: ${catalog.warning}`)
  if (catalog.models.length === 0) {
    lines.push('', 'No models loaded. Set the provider key/URL or use manual input.')
  }
  return {
    text: lines.join('\n'),
    keyboard: buildTelegramModelKeyboard(
      profile.provider,
      catalog.models,
      profile.model,
      safePage,
    ),
  }
}

function findCatalogModel(
  catalog: ProviderModelCatalog,
  model: string,
): ProviderModelOption | undefined {
  const base = getModelBaseId(model)
  return catalog.models.find(option => option.id === base)
}

function parseTelegramReasoningEffort(value: string): ReasoningEffort | undefined {
  const normalized = value.trim().toLowerCase()
  return normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh' ||
    normalized === 'max' ||
    normalized === 'ultra'
    ? normalized
    : undefined
}

function fallbackReasoningLevels(model: string): ReasoningEffort[] {
  const base = getModelBaseId(model)
  const standard: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']
  if (base === 'gpt-5.6-sol' || base === 'gpt-5.6-terra') {
    return [...standard, 'max', 'ultra']
  }
  if (base === 'gpt-5.6-luna') return [...standard, 'max']
  return standard
}

function formatReasoningLabel(level: ReasoningEffort): string {
  if (level === 'xhigh') return 'Extra high'
  return level.charAt(0).toUpperCase() + level.slice(1)
}

function truncateTelegramButton(value: string, maxLength = 42): string {
  const limit = Math.max(4, maxLength)
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

async function formatContextWindowStatus(): Promise<string> {
  const env = {
    ...(await readProjectEnvFile()),
    ...process.env,
  }
  const profile = await loadProviderProfile()
  const configured = getConfiguredContextWindowValue(env)
  const manualTokens = parseHumanLimit(configured, {
    unlimitedValue: TELEGRAM_UNLIMITED_CONTEXT_WINDOW,
  })
  const model = profile.model || env.OPENAI_MODEL || env.OPENCLAUDE_MODEL || ''
  const effectiveTokens = withTemporaryEnv(env, () => getContextWindowForModel(model || 'unknown-model'))

  return [
    'Context window',
    `Mode: ${manualTokens === undefined ? 'auto (model/provider)' : 'manual'}`,
    `Configured: ${configured || 'auto'}`,
    `Effective: ${formatTokenCount(effectiveTokens)} tokens`,
    `Provider: ${profile.provider}`,
    `Model: ${getModelBaseId(model) || 'not set'}`,
    '',
    'Use /context auto, /context 1m, /context unlimited, or /context <tokens>.',
  ].join('\n')
}

function getConfiguredContextWindowValue(
  env: Record<string, string | undefined>,
): string {
  for (const key of CONTEXT_WINDOW_ENV_KEYS) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return ''
}

function normalizeTelegramContextWindow(
  value: string,
): { value: string; tokens: number } | null {
  const trimmed = value.trim()
  const normalized = trimmed.toLowerCase()
  if (['auto', 'default', 'model', 'inherit', 'clear', 'off'].includes(normalized)) {
    return { value: '', tokens: 0 }
  }

  const tokens = parseHumanLimit(trimmed, {
    unlimitedValue: TELEGRAM_UNLIMITED_CONTEXT_WINDOW,
  })
  if (tokens === undefined) return null
  return { value: String(tokens), tokens }
}

function contextWindowEnv(value: string): Record<string, string> {
  return {
    OPENCLAUDE_CONTEXT_WINDOW_TOKENS: value,
    OPENCLAUDE_MAX_CONTEXT_TOKENS: value,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: value,
  }
}

function applyRuntimeEnvUpdates(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === '') delete process.env[key]
    else process.env[key] = value
  }
}

function withTemporaryEnv<T>(
  env: Record<string, string | undefined>,
  run: () => T,
): T {
  const previous = new Map<string, string | undefined>()
  for (const key of CONTEXT_WINDOW_STATUS_ENV_KEYS) {
    previous.set(key, process.env[key])
    const value = env[key]
    if (value === undefined || value === '') delete process.env[key]
    else process.env[key] = value
  }
  try {
    return run()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

async function loadProviderProfile(): Promise<AgentProviderProfile> {
  const env = {
    ...(await readProjectEnvFile()),
    ...process.env,
  }
  let provider = env.OPENCLAUDE_PROVIDER || ''
  if (!provider) {
    if (env.CLAUDE_CODE_USE_GEMINI) provider = 'gemini'
    else if (env.CLAUDE_CODE_USE_MISTRAL) provider = 'mistral'
    else if (env.CLAUDE_CODE_USE_GITHUB) provider = 'github'
    else if (env.ANTHROPIC_API_KEY) provider = 'anthropic'
    else if (
      (env.CODEX_API_KEY || env.CODEX_AUTH_JSON_PATH || env.CODEX_HOME) &&
      isCodexAlias(env.OPENCLAUDE_MODEL || env.OPENAI_MODEL || '') &&
      !(env.OPENCLAUDE_BASE_URL || env.OPENAI_BASE_URL)
    ) {
      provider = 'codex'
    }
    else provider = 'openai-compatible'
  }
  const info = getTelegramProviderInfo(provider)
  const isOpenAI = info.flag === 'openai'
  return normalizeProviderProfile({
    provider,
    baseUrl:
      provider === 'codex'
        ? env.OPENCLAUDE_BASE_URL || ''
        : env.OPENCLAUDE_BASE_URL ||
          (isOpenAI ? env.OPENAI_BASE_URL : env[`${info.flag.toUpperCase()}_BASE_URL`]) ||
          info.baseUrl ||
          '',
    model:
      env.OPENCLAUDE_MODEL ||
      (isOpenAI ? env.OPENAI_MODEL : env[`${info.flag.toUpperCase()}_MODEL`]) ||
      '',
    apiKey: provider === 'codex'
      ? providerSpecificApiKey(provider, env)
      : providerSpecificApiKey(provider, env) ||
        env.OPENCLAUDE_API_KEY ||
        (isOpenAI ? env.OPENAI_API_KEY : env[`${info.flag.toUpperCase()}_API_KEY`]) ||
        info.apiKey ||
        '',
  })
}

function normalizeProviderProfile(input: Partial<AgentProviderProfile>): AgentProviderProfile {
  const provider = String(input.provider || 'openai-compatible').trim().toLowerCase()
  const info = getTelegramProviderInfo(provider)
  return {
    provider,
    baseUrl: String(input.baseUrl || info.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(input.model || '').trim(),
    apiKey: String(input.apiKey || info.apiKey || '').trim(),
  }
}

async function saveProviderProfile(profile: AgentProviderProfile): Promise<void> {
  const updates = providerProfileEnv(profile)
  await updateProjectEnvFile(updates)
  applyRuntimeEnvUpdates(updates)
}

async function hydrateShortcutProviderProfile(profile: AgentProviderProfile): Promise<AgentProviderProfile> {
  if (profile.apiKey) return profile
  const env = {
    ...(await readProjectEnvFile()),
    ...process.env,
  }
  const apiKey = providerSpecificApiKey(profile.provider, env)
  return apiKey ? { ...profile, apiKey } : profile
}

async function resolveShortcutProviderProfile(
  profile: AgentProviderProfile,
): Promise<{ profile: AgentProviderProfile; warning?: string }> {
  if (!profile.model) return { profile }

  let catalog: ProviderModelCatalog
  try {
    catalog = await loadProviderModelCatalog(profile)
  } catch {
    return { profile }
  }

  if (catalog.source !== 'live' || catalog.models.length === 0) {
    return { profile }
  }

  const requestedBase = getModelBaseId(profile.model)
  if (catalog.models.some(model => model.id === requestedBase)) {
    return { profile }
  }

  const fallback = chooseLiveFallbackModel(profile.provider, requestedBase, catalog.models)
  if (!fallback) return { profile }

  const model = profile.provider === 'codex' && fallback.defaultReasoning
    ? withModelReasoning(fallback.id, fallback.defaultReasoning)
    : fallback.id
  return {
    profile: normalizeProviderProfile({ ...profile, model }),
    warning: [
      `Requested model "${requestedBase}" is not listed by the live ${profile.provider} endpoint.`,
      `Using "${fallback.id}" instead to avoid a model_not_found task failure.`,
    ].join('\n'),
  }
}

function chooseLiveFallbackModel(
  provider: string,
  requestedBase: string,
  models: ProviderModelOption[],
): ProviderModelOption | undefined {
  const requested = requestedBase.toLowerCase()
  const normalizedModels = models.map(model => ({
    model,
    id: model.id.toLowerCase(),
  }))

  const preferredNeedles =
    provider === 'deepseek' && requested.includes('pro')
      ? ['pro', 'reasoner', 'chat']
      : provider === 'deepseek' && requested.includes('flash')
        ? ['flash', 'chat']
        : requested.includes('coder')
          ? ['coder', 'code']
          : []

  for (const needle of preferredNeedles) {
    const match = normalizedModels.find(item => item.id.includes(needle))
    if (match) return match.model
  }

  return models[0]
}

function providerSpecificApiKey(provider: string, env: Record<string, string | undefined>): string {
  if (provider === 'codex') {
    if (env.CODEX_AUTH_JSON_PATH || env.CODEX_HOME) return ''
    return env.CODEX_API_KEY || ''
  }
  if (provider === 'deepseek') {
    return env.DEEPSEEK_API_KEY || env.OPENCLAUDE_DEEPSEEK_API_KEY || ''
  }
  if (provider === 'openrouter') {
    return env.OPENROUTER_API_KEY || ''
  }
  if (provider === 'omniroute') {
    return env.OMNIROUTE_API_KEY || ''
  }
  return ''
}

function providerProfileEnv(profile: AgentProviderProfile): Record<string, string> {
  const info = getTelegramProviderInfo(profile.provider)
  const updates: Record<string, string> = {
    OPENCLAUDE_RESPECT_PROVIDER_ENV: '1',
    OPENCLAUDE_PROVIDER: profile.provider,
    OPENCLAUDE_BASE_URL: profile.baseUrl,
    OPENCLAUDE_MODEL: profile.model,
    OPENCLAUDE_API_KEY: profile.apiKey,
    OPENCLAUDE_AGENT_RUNNER_DISABLE_TOOLS: profile.provider === 'lmstudio-lan' ? '1' : '0',
    CLAUDE_CODE_USE_OPENAI: '',
    CLAUDE_CODE_USE_GEMINI: '',
    CLAUDE_CODE_USE_MISTRAL: '',
    CLAUDE_CODE_USE_GITHUB: '',
    OPENAI_BASE_URL: '',
    OPENAI_MODEL: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_BASE_URL: '',
    ANTHROPIC_MODEL: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_BASE_URL: '',
    GEMINI_MODEL: '',
    GEMINI_API_KEY: '',
    MISTRAL_BASE_URL: '',
    MISTRAL_MODEL: '',
    MISTRAL_API_KEY: '',
    CODEX_API_KEY: '',
  }
  if (profile.provider === 'codex') {
    updates.CLAUDE_CODE_USE_OPENAI = '1'
    updates.OPENAI_BASE_URL = profile.baseUrl
    updates.OPENAI_MODEL = profile.model
    if (profile.apiKey) updates.CODEX_API_KEY = profile.apiKey
    return updates
  }
  if (info.flag === 'openai') {
    updates.CLAUDE_CODE_USE_OPENAI = '1'
    updates.OPENAI_BASE_URL = profile.baseUrl
    updates.OPENAI_MODEL = profile.model
    updates.OPENAI_API_KEY = profile.apiKey
    if (profile.provider === 'deepseek' && profile.apiKey) {
      updates.DEEPSEEK_API_KEY = profile.apiKey
      updates.OPENCLAUDE_DEEPSEEK_API_KEY = profile.apiKey
    }
    if (profile.provider === 'openrouter' && profile.apiKey) {
      updates.OPENROUTER_API_KEY = profile.apiKey
    }
    if (profile.provider === 'omniroute' && profile.apiKey) {
      updates.OMNIROUTE_API_KEY = profile.apiKey
    }
  } else if (info.flag === 'anthropic') {
    updates.ANTHROPIC_BASE_URL = profile.baseUrl
    updates.ANTHROPIC_MODEL = profile.model
    updates.ANTHROPIC_API_KEY = profile.apiKey
  } else if (info.flag === 'gemini') {
    updates.CLAUDE_CODE_USE_GEMINI = '1'
    updates.GEMINI_BASE_URL = profile.baseUrl
    updates.GEMINI_MODEL = profile.model
    updates.GEMINI_API_KEY = profile.apiKey
  } else if (info.flag === 'mistral') {
    updates.CLAUDE_CODE_USE_MISTRAL = '1'
    updates.MISTRAL_BASE_URL = profile.baseUrl
    updates.MISTRAL_MODEL = profile.model
    updates.MISTRAL_API_KEY = profile.apiKey
  } else if (info.flag === 'github') {
    updates.CLAUDE_CODE_USE_GITHUB = '1'
    updates.OPENAI_MODEL = profile.model
  }
  return updates
}

export function buildTelegramProviderProfileUpdate(
  previous: AgentProviderProfile,
  parsed: Partial<AgentProviderProfile>,
): AgentProviderProfile {
  const provider = String(parsed.provider || previous.provider || 'openai-compatible')
    .trim()
    .toLowerCase()
  const providerChanged = provider !== previous.provider
  const defaults = getTelegramProviderInfo(provider)

  return normalizeProviderProfile({
    provider,
    model: parsed.model || previous.model,
    baseUrl: parsed.baseUrl !== undefined
      ? parsed.baseUrl
      : (providerChanged ? defaults.baseUrl || '' : previous.baseUrl),
    apiKey: parsed.apiKey !== undefined
      ? parsed.apiKey
      : (providerChanged ? defaults.apiKey || '' : previous.apiKey),
  })
}

function parseProviderSetCommand(input: string): Partial<AgentProviderProfile> | null {
  const parts = splitCommandLike(input)
  if (parts.length < 2) return null
  return {
    provider: parts[0],
    model: parts[1],
    baseUrl: parts[2],
    apiKey: parts[3],
  }
}

function splitCommandLike(value: string): string[] {
  const parts: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g
  for (const match of value.matchAll(pattern)) {
    parts.push(match[1] ?? match[2] ?? match[0])
  }
  return parts
}

function formatProviderProfile(profile: AgentProviderProfile): string {
  const reasoning = profile.provider === 'codex'
    ? getReasoningEffortForModel(profile.model)
    : undefined
  const authentication = profile.provider === 'codex' && !profile.apiKey && (
    process.env.CODEX_AUTH_JSON_PATH || process.env.CODEX_HOME
  )
    ? 'Authentication: Codex subscription (auth.json)'
    : `API key: ${maskSecretForTelegram(profile.apiKey)}`
  return [
    'Active provider profile',
    `Provider: ${profile.provider}`,
    `Model: ${getModelBaseId(profile.model) || 'not set'}`,
    ...(reasoning ? [`Reasoning: ${reasoning}`] : []),
    `Base URL: ${profile.baseUrl || 'not set'}`,
    authentication,
  ].join('\n')
}

function formatTelegramSubagentStatus(config: AgentGatewayConfig): string {
  const status = describeGatewaySubagents(config)
  const lines = [
    'Gateway subagents',
    `Status: ${status.enabled ? 'ON' : 'OFF'}`,
    `Parallel read-only delegates: ${status.maxParallel}`,
    '',
  ]
  if (status.routes.length === 0) {
    lines.push('No routes configured.')
  } else {
    for (const route of status.routes) {
      lines.push(
        `${route.apiKeyConfigured ? 'READY' : 'AUTH NEEDED'} ${route.name}`,
        `${route.provider} / ${route.model}`,
        route.baseUrl,
      )
    }
  }
  lines.push(
    '',
    'Roles: gateway-explore, gateway-plan, gateway-implement, gateway-review, gateway-vision.',
    'Use /subagents set <role> <provider> <model> [base_url] [api_key] to change a route.',
    'Direct task: /delegate <plan|code|review|explore|vision> <task>.',
  )
  return lines.join('\n').slice(0, 3900)
}

function normalizeSubagentRole(value: string): string | undefined {
  const name = value.trim().toLowerCase()
  const aliases: Record<string, string> = {
    explore: 'gateway-explore',
    research: 'gateway-explore',
    plan: 'gateway-plan',
    planning: 'gateway-plan',
    code: 'gateway-implement',
    coding: 'gateway-implement',
    implement: 'gateway-implement',
    review: 'gateway-review',
    audit: 'gateway-review',
    vision: 'gateway-vision',
    image: 'gateway-vision',
  }
  if (aliases[name]) return aliases[name]
  return /^gateway-[a-z][a-z0-9-]{2,44}$/u.test(name) ? name : undefined
}

function defaultSubagentApiKeyEnv(provider: string): string | undefined {
  if (provider === 'deepseek') return 'DEEPSEEK_API_KEY'
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY'
  if (provider === 'omniroute') return 'OMNIROUTE_API_KEY'
  if (provider === 'codex') return 'CODEX_API_KEY'
  if (provider === 'lmstudio' || provider === 'lmstudio-lan' || provider === 'ollama') return undefined
  return 'OPENAI_API_KEY'
}

async function loadProviderModels(profile: AgentProviderProfile): Promise<string> {
  const catalog = await loadProviderModelCatalog(profile)
  return [
    `Models for ${profile.provider} (${catalog.source}):`,
    ...catalog.models.slice(0, 80).map(model => {
      const reasoning = model.reasoningLevels.length
        ? ` [${model.reasoningLevels.join(',')}]`
        : ''
      return `- ${model.id}${reasoning}`
    }),
    catalog.models.length > 80 ? `...and ${catalog.models.length - 80} more` : '',
    catalog.warning ? `Warning: ${catalog.warning}` : '',
    '',
    'Use /models for buttons or /model <model> for manual input.',
  ].filter(Boolean).join('\n')
}

async function readProjectEnvFile(): Promise<Record<string, string>> {
  try {
    return parseProjectEnv(await readFile(projectEnvPath(), 'utf8'))
  } catch {
    return {}
  }
}

async function updateProjectEnvFile(updates: Record<string, string>): Promise<void> {
  const file = projectEnvPath()
  let raw = ''
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    raw = ''
  }
  const lines = raw ? raw.split(/\r?\n/u) : []
  const seen = new Set<string>()
  const next = lines.map(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u)
    if (!match) return line
    const key = match[1]!
    if (!(key in updates)) return line
    seen.add(key)
    return `${key}=${quoteProjectEnv(updates[key])}`
  })
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${quoteProjectEnv(value)}`)
  }
  await writeFile(file, `${next.join('\n').replace(/\n+$/u, '')}\n`, 'utf8')
}

function projectEnvPath(): string {
  return join(process.cwd(), '.env')
}

function parseProjectEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function quoteProjectEnv(value: string | undefined): string {
  const text = String(value ?? '')
  if (!text) return ''
  if (/[\s#"'`$]/u.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}

function maskSecretForTelegram(value: string | undefined): string {
  if (!value) return 'not set'
  if (value.length <= 8) return 'set'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

type TelegramErrorLogEntry = {
  ts: string
  chatId: string
  source: string
  failureKind?: string
  exitCode?: number
  timedOut?: boolean
  message: string
  activity?: string[]
}

async function recordTelegramError(
  chatId: string,
  source: string,
  error: unknown,
): Promise<void> {
  try {
    const result = error as Partial<AgentRunResult>
    const entry: TelegramErrorLogEntry = {
      ts: new Date().toISOString(),
      chatId,
      source,
      failureKind: result.failureKind,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : undefined,
      timedOut: typeof result.timedOut === 'boolean' ? result.timedOut : undefined,
      message: summarizeTelegramError(error),
      activity: Array.isArray(result.activity) ? result.activity.slice(-10) : undefined,
    }
    const dir = join(getAgentGatewayStateDir(), 'logs')
    await mkdir(dir, { recursive: true })
    await appendFile(
      join(dir, 'telegram-errors.jsonl'),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    )
  } catch {
    // Error logging must never mask the original Telegram failure.
  }
}

async function loadTelegramErrorLog(
  chatId: string,
  limit: number,
): Promise<TelegramErrorLogEntry[]> {
  try {
    const raw = await readFile(
      join(getAgentGatewayStateDir(), 'logs', 'telegram-errors.jsonl'),
      'utf8',
    )
    return raw
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(line => JSON.parse(line) as TelegramErrorLogEntry)
      .filter(entry => entry.chatId === chatId)
      .slice(-limit)
      .reverse()
  } catch {
    return []
  }
}

function summarizeTelegramError(error: unknown): string {
  const result = error as Partial<AgentRunResult>
  const parts = [
    result.diagnostic,
    result.stderr,
    result.text,
    error instanceof Error ? error.stack || error.message : undefined,
    typeof error === 'string' ? error : undefined,
  ].filter(Boolean)
  const text = redactAgentText(parts.join('\n') || String(error || 'unknown error'))
  return text.replace(/\s+/g, ' ').trim().slice(0, 2000)
}

function formatTelegramErrorLogEntry(entry: TelegramErrorLogEntry): string {
  const lines = [
    `${entry.ts} - ${entry.source}`,
    entry.failureKind ? `kind: ${entry.failureKind}` : undefined,
    typeof entry.exitCode === 'number' ? `exit: ${entry.exitCode}` : undefined,
    entry.timedOut ? 'timed out: yes' : undefined,
    entry.message,
  ].filter(Boolean) as string[]
  if (entry.activity?.length) {
    lines.push('activity:')
    for (const event of entry.activity.slice(-5)) {
      lines.push(`- ${event}`)
    }
  }
  return lines.join('\n').slice(0, 1800)
}

type TelegramProgressEvent = {
  label: string
  count: number
}

type TelegramProgressSnapshot = {
  status: TelegramProgressStatus
  phase: string
  startedAt: number
  events: TelegramProgressEvent[]
  providerProfile?: TelegramProgressProviderProfile
}

class TelegramTaskProgress {
  readonly messageId: number
  private readonly startedAt: number
  private readonly providerProfile?: TelegramProgressProviderProfile
  private readonly events: TelegramProgressEvent[] = []
  private readonly edit: (text: string) => Promise<void>
  private readonly stopTyping: () => void
  private phase: string
  private status: TelegramProgressStatus = 'running'
  private disposed = false
  private lastEditAt = 0
  private editTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval>

  constructor(input: {
    messageId: number
    phase: string
    startedAt?: number
    providerProfile?: TelegramProgressProviderProfile
    edit: (text: string) => Promise<void>
    stopTyping: () => void
  }) {
    this.messageId = input.messageId
    this.phase = input.phase
    this.startedAt = input.startedAt ?? Date.now()
    this.providerProfile = input.providerProfile
    this.edit = input.edit
    this.stopTyping = input.stopTyping
    this.heartbeatTimer = setInterval(() => this.scheduleEdit(), 15_000)
  }

  setPhase(phase: string): void {
    if (!phase || this.disposed) return
    this.phase = phase
    this.scheduleEdit()
  }

  observeStdout(chunk: string): void {
    const events = summarizeAgentProgressChunk(chunk)
    for (const event of events) {
      this.addEvent(event)
    }
  }

  addEvent(label: string): void {
    if (this.disposed) return
    const normalized = truncateProgressLabel(redactAgentText(label))
    if (!normalized) return
    const existing = this.events.find(event => event.label === normalized)
    if (existing) {
      existing.count += 1
    } else {
      this.events.push({ label: normalized, count: 1 })
      while (this.events.length > 18) {
        this.events.shift()
      }
    }
    this.scheduleEdit()
  }

  async finish(status: Exclude<TelegramProgressStatus, 'running'>, phase: string): Promise<void> {
    if (this.disposed) return
    this.status = status
    this.phase = phase
    await this.flush()
    this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopTyping()
    clearInterval(this.heartbeatTimer)
    if (this.editTimer) clearTimeout(this.editTimer)
  }

  private scheduleEdit(): void {
    if (this.disposed) return
    const waitMs = Math.max(0, 1_500 - (Date.now() - this.lastEditAt))
    if (waitMs === 0) {
      void this.flush().catch(() => {})
      return
    }
    if (!this.editTimer) {
      this.editTimer = setTimeout(() => {
        this.editTimer = undefined
        void this.flush().catch(() => {})
      }, waitMs)
    }
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.messageId) return
    this.lastEditAt = Date.now()
    try {
      await this.edit(formatTelegramProgressText({
        status: this.status,
        phase: this.phase,
        startedAt: this.startedAt,
        events: this.events,
        providerProfile: this.providerProfile,
      }))
    } catch {
      // Telegram rejects unchanged/rate-limited edits; progress is best-effort.
    }
  }
}

export function summarizeAgentProgressChunk(chunk: string): string[] {
  const seen = new Set<string>()
  const events: string[] = []
  const lines = chunk
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const normalized = redactAgentText(line.replace(/\s+/g, ' '))
    const tool = normalized.match(
      /\b(mcp_[A-Za-z0-9_.:-]+|PowerShell|FileSystem|Screenshot|App|Wait|Notification|Clipboard|search_files|read_file|write_file|execute_code|skill_view|shell_command|apply_patch|Bash|Read|Write|Edit|Glob|Grep|LS|TodoWrite)\b/,
    )?.[1]
    if (tool) {
      const quoted = normalized.match(/["'`]([^"'`]{1,140})["'`]/)?.[1]
      const label = quoted ? `${tool}: "${quoted}"` : normalized
      const truncated = truncateProgressLabel(label)
      if (!seen.has(truncated)) {
        seen.add(truncated)
        events.push(truncated)
      }
      continue
    }

    if (/^(running|reading|writing|searching|executing|created|updated|edited|calling)\b/i.test(normalized)) {
      const truncated = truncateProgressLabel(normalized)
      if (!seen.has(truncated)) {
        seen.add(truncated)
        events.push(truncated)
      }
    }
  }

  return events.slice(0, 8)
}

function isRecoveredEditValidationError(label: string): boolean {
  if (!/^tool result error \((?:Edit|Write)(?::[^)]*)?\):/iu.test(label)) return false
  return /(string to replace not found|found \d+ matches of the string to replace|read the file first)/iu.test(label)
}

export function formatTelegramProgressText(snapshot: TelegramProgressSnapshot): string {
  const model = snapshot.providerProfile?.model || ''
  const reasoning = snapshot.providerProfile?.provider === 'codex'
    ? getReasoningEffortForModel(model)
    : undefined
  const lines = [
    `OpenClaude task: ${snapshot.status}`,
    `Phase: ${snapshot.phase}`,
    `Provider: ${snapshot.providerProfile?.provider || 'not set'}`,
    `Model: ${getModelBaseId(model) || 'not set'}`,
    ...(reasoning ? [`Reasoning: ${reasoning}`] : []),
    `Elapsed: ${formatDuration(Date.now() - snapshot.startedAt)}`,
    '',
    'Activity:',
  ]

  const displayEvents = snapshot.status === 'completed'
    ? snapshot.events.filter(event => !isRecoveredEditValidationError(event.label))
    : snapshot.events

  if (displayEvents.length === 0) {
    lines.push(
      snapshot.status === 'running'
        ? '- waiting for model/tool output'
        : '- no streamed model/tool activity captured',
    )
  } else {
    for (const event of displayEvents.slice(-14)) {
      const redactedLabel = redactAgentText(event.label)
      const label = snapshot.status === 'completed'
        ? redactedLabel.replace(/^tool result error\b/iu, 'recovered tool warning')
        : redactedLabel
      lines.push(`- ${label}${event.count > 1 ? ` (x${event.count})` : ''}`)
    }
  }

  return lines.join('\n').slice(0, 3900)
}

function normalizeTelegramCommand(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return trimmed
  const [command = '', ...rest] = trimmed.split(/\s+/)
  const normalizedCommand = command.replace(/@[A-Za-z0-9_]+$/, '').toLowerCase()
  return [normalizedCommand, ...rest].join(' ').trim()
}

function getTelegramCommandBody(text: string, command: string): string {
  return text
    .replace(new RegExp(`^/${command}(?:@[A-Za-z0-9_]+)?(?:\\s+|$)`, 'iu'), '')
    .trim()
}

export function hasTelegramMemoryIntent(text: string): boolean {
  return /(?:\b(?:remember|memorize|save(?:\s+this)?|save\s+to\s+memory|store(?:\s+this)?|memory|forget)\b|\u0437\u0430\u043f\u043e\u043c\u043d|\u043f\u0430\u043c\u044f\u0442|\u0441\u043e\u0445\u0440\u0430\u043d|\u0437\u0430\u0444\u0438\u043a\u0441|\u0437\u0430\u043f\u0438\u0448|\u0437\u0430\u0431\u0443\u0434|\u0443\u0434\u0430\u043b[^\n]{0,40}\u043f\u0430\u043c\u044f\u0442)/iu.test(text)
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function truncateProgressLabel(label: string): string {
  const normalized = label.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 160) return normalized
  return `${normalized.slice(0, 157)}...`
}

export function buildTelegramAgentPrompt(input: {
  chatId: string
  messageId: number
  from?: TelegramMessage['from']
  text: string
  attachments: TelegramAttachment[]
  conversationTranscript?: string
  replyContext?: TelegramReplyContext
  memoryContext?: string
  memoryWriteProtocol?: string
  reflectionContext?: string
  cronContext?: string
}): string {
  const lines = [
    'Telegram request received by the OpenClaude agent bridge.',
    `Chat ID: ${input.chatId}`,
    `Message ID: ${input.messageId}`,
  ]

  if (input.from) {
    lines.push(
      `From: ${input.from.username ? `@${input.from.username}` : input.from.first_name || input.from.id}`,
    )
  }

  lines.push(
    '',
    '## Personal record integrity',
    'Personal history is factual data, not a place for inference. Never create, update, or summarize a personal event, date, streak, counter, cause, trigger, achievement, score, diagnosis, or emotional state unless the user stated that exact fact in the current message, its explicit Telegram reply context, or the injected conversation transcript.',
    'Do not turn a plan, reminder, concern, missing detail, or earlier assistant statement into a past event. If the source is absent or ambiguous, ask a concise clarifying question instead of writing to personal markdown files, persistent memory, or derived RPG statistics.',
    'Keep proposals and templates clearly separate from historical records. A user request to correct or delete a record is authoritative; do not preserve an inferred claim merely because it appears in another agent-generated file.',
  )

  // Inject memory context (scratchpad, identity, patterns) if available
  if (input.memoryContext) {
    lines.push('', '## Your persistent memory (Ouroboros consciousness system)', input.memoryContext)
  }

  if (input.memoryWriteProtocol) {
    lines.push(
      '',
      input.memoryWriteProtocol,
      '',
      'For Telegram requests that ask to remember durable facts, use the [MEMORY ...] protocol above. Do not read, edit, write, cat, tee, sed, or redirect into memory files such as identity.md, scratchpad.md, USER.md, MEMORY.md, curated_memory.json, or any /agent-gateway/memory/ path. Never say you need direct access to identity.md. Never claim a memory write succeeded unless the [MEMORY ...] directive was emitted for the gateway to apply.',
    )
  }

  if (input.memoryWriteProtocol && hasTelegramMemoryIntent(input.text)) {
    lines.push(
      '',
      'Explicit memory intent detected in the current Telegram message.',
      '- A [MEMORY ...] control line is mandatory unless the user explicitly says not to use memory.',
      '- Also call hindsight_retain when Hindsight MCP tools are available; the [MEMORY ...] line is still required for gateway MD/curated memory.',
      '- If you create or update user-visible markdown files, do that as a separate filesystem action and still emit [MEMORY ...] for durable recall.',
      '- Do not answer that something was remembered unless the memory directive or a real memory/tool write succeeded.',
    )
  }

  // Inject reflection context (recent task reflections) if available
  if (input.reflectionContext) {
    lines.push('', input.reflectionContext)
  }

  if (input.conversationTranscript) {
    lines.push(
      '',
      input.conversationTranscript,
      '',
      'Use the Telegram conversation transcript above as the immediate dialogue context. If the user asks about earlier messages in this chat, answer from that transcript instead of saying history is unavailable.',
    )
  }

  if (input.replyContext) {
    lines.push(
      '',
      formatTelegramReplyContext(input.replyContext),
      '',
      'The current Telegram message is an explicit reply to the message above. Treat that replied-to message as the primary target of the user request, especially when it is a cron/job/progress message with context separate from the normal dialogue. Still use the broader Telegram conversation transcript for surrounding context.',
    )
  }

  if (input.cronContext) {
    lines.push(
      '',
      input.cronContext,
      '',
      'Use the Telegram gateway cron jobs list above for existing reminder updates. Do not inspect cron storage files to discover jobs.',
    )
  }

  const telegramCronTimezone = getTelegramCronTimezone()
  lines.push(
    '',
    'If the Telegram user asks to create, update, or remember a reminder, alarm, cron job, recurring task, or scheduled notification for this Telegram chat, emit a standalone bridge control line.',
    `Create static reminder example: [TELEGRAM_CRON_CREATE name="short-stable-name" schedule="0 22 * * *" timezone="${telegramCronTimezone}" mode="message" prompt="22:00 - reminder text without emojis unless requested."]`,
    'Update existing reminder example: [TELEGRAM_CRON_UPDATE name="existing-job-name" mode="message" prompt="Updated reminder text without emojis unless requested."]',
    'TELEGRAM_CRON_CREATE is idempotent for this chat: if a live job with the same name exists, the gateway updates it; if it does not exist, the gateway creates it. Prefer CREATE with the full schedule when creating, rescheduling, repairing, or recreating a reminder.',
    'Use mode="message" for normal reminders so the gateway sends the text directly without running an LLM or tools. Use mode="agent" only for genuinely dynamic scheduled research/status tasks.',
    'Use standard 5-field cron in the timezone attribute. Use the exact minute/hour the user requested; do not invent offsets such as :07 unless the user asked for them. Recurring Telegram cron jobs are persistent and do not have a 7-day limit.',
    'If the user reacts to a Cronjob Response and asks to change wording, style, emojis, time, or content, update the matching existing job by name with [TELEGRAM_CRON_UPDATE ...] only when that job name is visible in the replied-to message or cron jobs list. If you are unsure the job exists, emit TELEGRAM_CRON_CREATE with the full schedule instead of UPDATE.',
    'Do not call the built-in CronCreate tool for Telegram reminders. Do not read, edit, write, cat, tee, sed, or redirect into /agent-gateway/cron-jobs.json or any cron-jobs.json file. Never claim a Telegram reminder was created or updated unless a TELEGRAM_CRON_CREATE or TELEGRAM_CRON_UPDATE directive was emitted for the bridge to apply.',
  )

  lines.push(
    '',
    'If you need Telegram to upload an output screenshot, image, or document back to the chat, include a standalone control line:',
    '[TELEGRAM_SEND_FILE path="C:\\path\\to\\file.png" caption="optional caption"]',
    'You can also use [[image:C:\\path\\to\\image.png]] or [[document:C:\\path\\to\\file.pdf]].',
    'The bridge will remove those control tokens from visible text and upload the local file.',
    'A successful camofox_screenshot tool result is uploaded automatically; do not add a duplicate TELEGRAM_SEND_FILE line for that same PNG.',
    '',
    'User message:',
    input.text || '(no text; user sent attachments)',
  )

  if (input.attachments.length > 0) {
    lines.push('', 'Telegram attachments saved for this request:')
    for (const attachment of input.attachments) {
      lines.push(formatAttachmentForPrompt(attachment))
    }
    lines.push(
      '',
      'Use the local_path values above when you need to inspect attached files.',
    )
    if (input.attachments.some(isVisualTelegramAttachment)) {
      lines.push(
        'At least one attachment is visual. Inspect the actual local image through gateway-vision when that route is available; do not infer its contents from the filename or caption.',
      )
    }
  }

  return lines.join('\n')
}

/**
 * Async wrapper that builds the prompt with memory context injected.
 */
export async function buildTelegramAgentPromptWithMemory(input: {
  chatId: string
  messageId: number
  from?: TelegramMessage['from']
  text: string
  attachments: TelegramAttachment[]
  config?: AgentGatewayConfig
  model?: string
  conversationTranscript?: string
  replyContext?: TelegramReplyContext
}): Promise<string> {
  const memoryOptions = input.config
    ? {
        memoryEnabled: input.config.memory.enabled,
        userProfileEnabled: input.config.memory.userProfileEnabled,
        writeApproval: input.config.memory.writeApproval,
      }
    : undefined
  const [memoryContext, reflectionContext, cronContext] = await Promise.all([
    buildMemoryContextSection({
      ...memoryOptions,
      maxChars: getMemoryContextMaxChars(input.model),
      // Static repository references are available through the agent's file
      // tools. Injecting them into every Telegram turn duplicates the CLI
      // system context and causes premature compaction on short requests.
      referenceDocs: false,
    }).catch(() => ''),
    buildReflectionContextSection().catch(() => ''),
    buildTelegramCronContext(input.chatId).catch(() => ''),
  ])
  const memoryWriteProtocol = buildCuratedMemorySystemInstructions(memoryOptions)

  return buildTelegramAgentPrompt({
    ...input,
    memoryContext: memoryContext || undefined,
    memoryWriteProtocol: memoryWriteProtocol || undefined,
    reflectionContext: reflectionContext || undefined,
    cronContext: cronContext || undefined,
  })
}

export function buildTelegramReplyContext(
  message: TelegramMessage,
): TelegramReplyContext | undefined {
  const replied = message.reply_to_message
  if (!replied) return undefined

  const text = getTelegramMessageText(replied)
  const attachmentSummary = summarizeTelegramMessageAttachments(replied)
  if (!text && !attachmentSummary) {
    return {
      messageId: replied.message_id,
      chatId: replied.chat?.id === undefined ? undefined : String(replied.chat.id),
      from: replied.from,
      date: replied.date,
    }
  }

  return {
    messageId: replied.message_id,
    chatId: replied.chat?.id === undefined ? undefined : String(replied.chat.id),
    from: replied.from,
    ...(text ? { text } : {}),
    ...(attachmentSummary ? { attachmentSummary } : {}),
    date: replied.date,
  }
}

export function formatTelegramReplyContext(context: TelegramReplyContext): string {
  const lines = ['## Telegram replied-to message context']
  lines.push(`Replied-to message ID: ${context.messageId}`)
  if (context.chatId) lines.push(`Replied-to chat ID: ${context.chatId}`)
  if (context.from) lines.push(`Replied-to from: ${formatTelegramSender(context.from)}`)
  if (context.date) {
    lines.push(`Replied-to date: ${new Date(context.date * 1000).toISOString()}`)
  }
  if (context.attachmentSummary) {
    lines.push(`Replied-to attachments: ${context.attachmentSummary}`)
  }
  lines.push('Replied-to text:')
  lines.push(context.text || '(no text)')
  return lines.join('\n')
}

async function buildTelegramConversationTranscript(
  chatId: string,
  options: { excludeMessageId?: number | string; model?: string; sessionId?: string } = {},
): Promise<string> {
  const maxChars = getTelegramConversationMaxChars(options.model)
  const entries = await loadChatLogTranscript({
    chatId,
    limit: getTelegramConversationTurnLimit(),
    maxChars,
    excludeMessageId: options.excludeMessageId,
    sessionId: options.sessionId,
  })
  return formatTelegramConversationTranscript(entries, { maxChars })
}

export function formatTelegramConversationTranscript(
  entries: RecentChatLogEntry[],
  options: { maxChars?: number } = {},
): string {
  const maxChars = Math.max(1_000, options.maxChars ?? Number.MAX_SAFE_INTEGER)
  const lines = entries
    .map(formatTelegramConversationTranscriptEntry)
    .filter(Boolean)
  if (lines.length === 0) return ''

  const selected = selectTextBlocksWithinCharBudget(lines, maxChars)

  return [
    '## Telegram conversation transcript',
    'The transcript below is from this same Telegram chat before the current message, oldest to newest.',
    ...selected,
  ].join('\n')
}

function formatTelegramConversationTranscriptEntry(entry: RecentChatLogEntry): string {
  const text = String(entry.text ?? '').trim()
  if (!text) return ''
  const direction = String(entry.direction ?? '')
  const role = direction === 'out' ? 'Assistant' : 'User'
  const messageId = entry.messageId === undefined ? '' : ` #${String(entry.messageId)}`
  const username = typeof entry.username === 'string' && entry.username
    ? ` @${entry.username}`
    : ''
  const status = direction === 'out' && Number(entry.exitCode ?? 0) !== 0
    ? ' failed'
    : ''
  return `${role}${messageId}${username}${status}:\n${text}`
}

function formatTelegramSender(from: TelegramMessage['from']): string {
  if (!from) return 'unknown'
  if (from.username) return `@${from.username}`
  return String(from.first_name || from.id || 'unknown')
}

function getTelegramConversationTurnLimit(): number {
  return getConversationContextTurnLimit([
    'OPENCLAUDE_TELEGRAM_CONTEXT_TURNS',
    'OPENCLAUDE_TELEGRAM_RECENT_HISTORY_LIMIT',
  ])
}

function getTelegramConversationMaxChars(model?: string): number {
  return getConversationContextMaxChars({
    model,
    envNames: [
      'OPENCLAUDE_TELEGRAM_CONTEXT_CHARS',
      'OPENCLAUDE_TELEGRAM_RECENT_HISTORY_MAX_CHARS',
    ],
  })
}

async function buildTelegramCronContext(chatId: string): Promise<string> {
  const jobs = (await listCronJobs(true))
    .filter(job =>
      job.origin?.platform === 'telegram'
      && job.origin.chatId === chatId
      && job.state !== 'completed'
    )
    .slice(0, 20)
  if (jobs.length === 0) return ''

  return [
    '## Telegram gateway cron jobs for this chat',
    'These jobs are managed by the gateway. Use TELEGRAM_CRON_UPDATE only for listed jobs; use TELEGRAM_CRON_CREATE with a full schedule to repair or recreate missing jobs.',
    ...jobs.map(formatTelegramCronContextJob),
  ].join('\n')
}

function formatTelegramCronContextJob(job: CronJob): string {
  return [
    `- id: ${job.id}`,
    `  name: ${job.name}`,
    `  state: ${job.state}`,
    `  schedule: ${job.scheduleDisplay}`,
    `  timezone: ${job.timezone || 'default'}`,
    `  mode: ${job.mode ?? 'agent'}`,
    `  next: ${job.nextRunAt ?? 'none'}`,
    `  prompt: ${job.prompt.replace(/\s+/g, ' ').slice(0, 500)}`,
  ].join('\n')
}

function isEmojiRemovalFeedback(text: string): boolean {
  const normalized = text.toLowerCase()
  return /(смайл|эмодз|emoji)/i.test(normalized)
    && /(убер|удал|без|заеб|достал|надоел|не\s+надо|не\s+нужн)/i.test(normalized)
}

function extractLastCronJobName(text: string): string | undefined {
  let result: string | undefined
  const pattern = /Cronjob Response:\s*([^\r\n]+)/gi
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.trim()
    if (name) result = name
  }
  return result
}

function reminderMessageWithoutEmoji(job: CronJob): string {
  const name = job.name.toLowerCase()
  const prompt = job.prompt
  if (name.includes('workout') || /трениров/i.test(prompt)) {
    return '22:00 - время ежедневной тренировки. Не пропускай.'
  }

  let text = prompt
  const reminderMatch = text.match(/(?:напоминание|reminder)[^:]*:\s*(.+)$/i)
  if (reminderMatch?.[1]) text = reminderMatch[1]
  text = text.replace(/Ответь только.*$/i, '')
  return stripEmoji(text)
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,:;!?])/g, '$1')
    .trim()
}

function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
}

export function getTelegramCronTimezone(): string {
  return (
    process.env.OPENCLAUDE_TELEGRAM_CRON_TIMEZONE?.trim()
    || process.env.TZ?.trim()
    || 'Europe/Simferopol'
  )
}

export async function applyTelegramCronDirectivesForChat(
  chatId: string,
  text: string,
): Promise<{ text: string; messages: string[] }> {
  const processed = extractTelegramCronDirectives(text)
  if (processed.directives.length === 0) {
    return { text: processed.text, messages: [] }
  }

  const messages: string[] = []
  for (const directive of processed.directives) {
    try {
      const existing = await findActiveTelegramCronJob(chatId, directive.name)
      const timezone = directive.timezone || (existing ? undefined : getTelegramCronTimezone())

      if (!existing && directive.action === 'update' && !directive.schedule) {
        messages.push([
          'Telegram cron update skipped:',
          `${directive.name} was not found for this Telegram chat.`,
          'Emit TELEGRAM_CRON_CREATE with a schedule to recreate missing reminders.',
        ].join('\n'))
        continue
      }

      const input: Record<string, unknown> = {
        mode: directive.mode ?? 'message',
        deliver: 'origin',
        origin: { platform: 'telegram', chatId },
      }
      if (!existing || existing.name === directive.name) input.name = directive.name
      if (timezone !== undefined) input.timezone = timezone
      if (directive.prompt !== undefined) input.prompt = directive.prompt
      if (directive.schedule !== undefined) input.schedule = directive.schedule

      const job = existing
        ? await updateCronJob(existing.id, { ...input, enabled: true })
        : await createCronJob(input)

      if (!job) {
        throw new Error(`cron job ${directive.name} was not saved`)
      }

      messages.push([
        existing ? 'Telegram cron updated:' : 'Telegram cron scheduled:',
        `${job.name} (${job.id})`,
        `schedule: ${job.scheduleDisplay}`,
        `mode: ${job.mode ?? 'agent'}`,
        ...(job.timezone ? [`timezone: ${job.timezone}`] : []),
        `next: ${job.nextRunAt ?? 'none'}`,
      ].join('\n'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordTelegramError(chatId, 'cron-directive', message)
      messages.push(`Telegram cron directive failed: ${message}`)
    }
  }

  return { text: processed.text, messages }
}

async function findActiveTelegramCronJob(chatId: string, name: string): Promise<CronJob | undefined> {
  return (await listCronJobs(true)).find(job =>
    (job.name === name || job.id === name)
    && job.origin?.platform === 'telegram'
    && job.origin.chatId === chatId
    && job.state !== 'completed'
  )
}

export function extractTelegramCronDirectives(text: string): {
  text: string
  directives: TelegramCronCreateDirective[]
} {
  const directives: TelegramCronCreateDirective[] = []
  const cleanedLines: string[] = []
  const controlPattern = /^\s*\[TELEGRAM_CRON_(CREATE|UPDATE)\s+(.+)\]\s*$/i

  for (const line of text.split(/\r?\n/)) {
    const controlMatch = line.match(controlPattern)
    if (!controlMatch) {
      cleanedLines.push(line)
      continue
    }

    const action = String(controlMatch[1] || '').toLowerCase() === 'update'
      ? 'update'
      : 'create'
    const attrs = parseTelegramControlAttributes(controlMatch[2] || '')
    const schedule = (attrs.schedule || attrs.cron || '').trim()
    const prompt = (attrs.prompt || attrs.text || '').trim()
    const name = (attrs.name || prompt.slice(0, 50) || 'telegram reminder').trim()
    const timezone = (attrs.timezone || attrs.tz || '').trim()
    const mode = normalizeTelegramCronDirectiveMode(attrs.mode || attrs.kind || attrs.direct)
    if (name && (schedule || prompt || timezone || mode)) {
      directives.push({
        action,
        name,
        ...(schedule ? { schedule } : {}),
        ...(prompt ? { prompt } : {}),
        ...(timezone ? { timezone } : {}),
        ...(mode ? { mode } : {}),
      })
    }
  }

  return {
    text: cleanedLines.join('\n').trim(),
    directives,
  }
}

function normalizeTelegramCronDirectiveMode(value: string | undefined): CronJobMode | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (['message', 'text', 'static', 'direct', 'reminder'].includes(normalized)) {
    return 'message'
  }
  if (['agent', 'model', 'llm', 'dynamic'].includes(normalized)) {
    return 'agent'
  }
  return undefined
}

function parseTelegramControlAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern =
    /([A-Za-z_][A-Za-z0-9_-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s\]]+))/g
  for (const match of input.matchAll(pattern)) {
    const key = match[1]?.trim()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    if (key) attrs[key] = unescapeTelegramControlAttribute(value)
  }
  return attrs
}

function unescapeTelegramControlAttribute(value: string): string {
  return value.replace(/\\(["'\\])/g, '$1')
}

export function extractTelegramSendDirectives(text: string): {
  text: string
  directives: TelegramSendDirective[]
} {
  const directives: TelegramSendDirective[] = []
  const cleanedLines: string[] = []
  const controlPattern =
    /^\s*\[TELEGRAM_SEND_FILE\s+path=(?:"([^"]+)"|'([^']+)'|([^\]\s]+))(?:\s+caption=(?:"([^"]*)"|'([^']*)'))?(?:\s+(?:kind|as)=(?:"([^"]+)"|'([^']+)'|([^\]\s]+)))?\s*\]\s*$/i
  const tokenPattern = /\[\[(image|document|file):([^\]\r\n]+)\]\]/gi

  for (const line of text.split(/\r?\n/)) {
    const controlMatch = line.match(controlPattern)
    if (controlMatch) {
      directives.push(
        buildTelegramDirective(
          controlMatch[1] || controlMatch[2] || controlMatch[3] || '',
          controlMatch[4] || controlMatch[5] || undefined,
          controlMatch[6] || controlMatch[7] || controlMatch[8],
        ),
      )
      continue
    }

    const cleaned = line.replace(tokenPattern, (_full, rawKind, rawPath) => {
      directives.push(
        buildTelegramDirective(
          String(rawPath).trim(),
          undefined,
          rawKind === 'file' ? 'auto' : String(rawKind),
        ),
      )
      return ''
    })
    cleanedLines.push(cleaned)
  }

  return {
    text: cleanedLines.join('\n').trim(),
    directives: directives.filter(directive => directive.path),
  }
}

export function mergeAgentArtifactsWithTelegramDirectives(
  directives: TelegramSendDirective[],
  artifacts: AgentRunArtifact[],
): TelegramSendDirective[] {
  const merged = [...directives]
  const seen = new Set(
    directives.map(directive => normalizeTelegramArtifactPath(directive.path)),
  )
  for (const artifact of artifacts) {
    const key = normalizeTelegramArtifactPath(artifact.path)
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push({
      path: artifact.path,
      kind: artifact.kind,
      ...(artifact.source.toLowerCase().includes('camofox')
        ? { caption: 'Camofox browser result' }
        : {}),
    })
  }
  return merged
}

function normalizeTelegramArtifactPath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

function buildTelegramDirective(
  path: string,
  caption?: string,
  rawKind?: string,
): TelegramSendDirective {
  const kind = normalizeTelegramDirectiveKind(rawKind)
  return {
    path,
    ...(caption ? { caption } : {}),
    ...(kind ? { kind } : {}),
  }
}

function normalizeTelegramDirectiveKind(
  value: string | undefined,
): TelegramSendDirective['kind'] | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'image' || normalized === 'photo') return 'image'
  if (normalized === 'document' || normalized === 'doc') return 'document'
  if (normalized === 'file' || normalized === 'auto') return 'auto'
  return undefined
}

export function getAttachmentCandidates(
  message: TelegramMessage,
): IncomingAttachmentCandidate[] {
  const candidates: IncomingAttachmentCandidate[] = []
  const photo = selectLargestPhoto(message.photo)
  if (photo) {
    candidates.push({
      type: 'photo',
      file: {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
        file_size: photo.file_size,
        file_name: `photo-${photo.file_unique_id || photo.file_id}.jpg`,
      },
      width: photo.width,
      height: photo.height,
    })
  }

  for (const [type, file] of [
    ['document', message.document],
    ['video', message.video],
    ['audio', message.audio],
    ['voice', message.voice],
    ['video_note', message.video_note],
    ['animation', message.animation],
    ['sticker', message.sticker],
  ] as const) {
    if (file) {
      candidates.push({
        type,
        file,
        width: file.width,
        height: file.height,
        duration: file.duration,
      })
    }
  }

  return candidates
}

function summarizeTelegramMessageAttachments(message: TelegramMessage): string {
  const candidates = getAttachmentCandidates(message)
  if (candidates.length === 0) return ''
  return candidates
    .map(candidate => {
      const name = candidate.file.file_name ? `:${candidate.file.file_name}` : ''
      return `${candidate.type}${name}`
    })
    .join(', ')
}

export function getAudioTranscriptionCandidate(
  message: TelegramMessage,
): IncomingAttachmentCandidate | undefined {
  if (message.voice) {
    return {
      type: 'voice',
      file: {
        ...message.voice,
        file_name:
          message.voice.file_name ||
          `voice-${message.voice.file_unique_id || message.voice.file_id}.ogg`,
        mime_type: message.voice.mime_type || 'audio/ogg',
      },
      duration: message.voice.duration,
    }
  }

  if (message.audio) {
    return {
      type: 'audio',
      file: message.audio,
      duration: message.audio.duration,
    }
  }

  if (message.document && isAudioMime(message.document.mime_type)) {
    return {
      type: 'audio_document',
      file: message.document,
      duration: message.document.duration,
    }
  }

  if (message.video_note) {
    return {
      type: 'video_note',
      file: message.video_note,
      width: message.video_note.width,
      height: message.video_note.height,
      duration: message.video_note.duration,
    }
  }

  return undefined
}

export function selectLargestPhoto(
  photos: TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | undefined {
  if (!photos?.length) return undefined
  return [...photos].sort((a, b) => {
    const aPixels = a.width * a.height
    const bPixels = b.width * b.height
    if (aPixels !== bPixels) return bPixels - aPixels
    return (b.file_size ?? 0) - (a.file_size ?? 0)
  })[0]
}

export function safeTelegramFileName(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'telegram-file'
}

export function buildTelegramDownloadFileName(
  candidate: IncomingAttachmentCandidate,
  fileInfo: TelegramGetFileResult,
): string {
  const telegramPathName = fileInfo.file_path ? basename(fileInfo.file_path) : ''
  const preferredName = candidate.file.file_name || telegramPathName
  if (preferredName && extname(preferredName)) {
    return safeTelegramFileName(preferredName)
  }

  const extension =
    extensionFromTelegramPath(fileInfo.file_path) ||
    extensionFromMime(candidate.file.mime_type) ||
    defaultExtensionForAttachmentType(candidate.type)
  const fileStem = `${candidate.type}-${candidate.file.file_unique_id || candidate.file.file_id}`
  return safeTelegramFileName(`${fileStem}${extension}`)
}

export async function listTelegramStoredFiles(
  chatId?: string,
  limit = 20,
): Promise<TelegramStoredFile[]> {
  const files = await loadTelegramStoredFiles()
  return files
    .filter(file => !chatId || file.chatId === chatId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
}

function getTelegramMessageText(message: TelegramMessage | undefined): string {
  return repairLikelyMojibakeText(message?.text || message?.caption || '').trim()
}

let windows1251EncodeMap: Map<string, number> | undefined
const WINDOWS_1251_EXTENDED_CHARS = [
  '\u0402', '\u0403', '\u201A', '\u0453', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u20AC', '\u2030', '\u0409', '\u2039', '\u040A', '\u040C', '\u040B', '\u040F',
  '\u0452', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u0098', '\u2122', '\u0459', '\u203A', '\u045A', '\u045C', '\u045B', '\u045F',
  '\u00A0', '\u040E', '\u045E', '\u0408', '\u00A4', '\u0490', '\u00A6', '\u00A7',
  '\u0401', '\u00A9', '\u0404', '\u00AB', '\u00AC', '\u00AD', '\u00AE', '\u0407',
  '\u00B0', '\u00B1', '\u0406', '\u0456', '\u0491', '\u00B5', '\u00B6', '\u00B7',
  '\u0451', '\u2116', '\u0454', '\u00BB', '\u0458', '\u0405', '\u0455', '\u0457',
]

function getWindows1251EncodeMap(): Map<string, number> {
  if (windows1251EncodeMap) return windows1251EncodeMap
  const map = new Map<string, number>()
  for (let byte = 0; byte <= 0x7F; byte += 1) {
    map.set(String.fromCharCode(byte), byte)
  }
  WINDOWS_1251_EXTENDED_CHARS.forEach((char, index) => {
    if (!map.has(char)) map.set(char, 0x80 + index)
  })
  for (let byte = 0xC0; byte <= 0xFF; byte += 1) {
    map.set(String.fromCharCode(0x0410 + byte - 0xC0), byte)
  }
  windows1251EncodeMap = map
  return map
}

export function repairLikelyMojibakeText(text: string): string {
  if (!text) return text
  const originalScore = scoreUtf8AsWindows1251Mojibake(text)
  if (originalScore < 3) return text

  const encoded = encodeWindows1251(text)
  if (!encoded) return text

  let repaired: string
  try {
    repaired = new TextDecoder('utf-8', { fatal: true }).decode(encoded)
  } catch {
    return text
  }

  if (!repaired || repaired === text) return text
  if (scoreUtf8AsWindows1251Mojibake(repaired) >= originalScore) return text
  return repaired
}

function encodeWindows1251(text: string): Uint8Array | undefined {
  const map = getWindows1251EncodeMap()
  const bytes: number[] = []
  for (const char of text) {
    const byte = map.get(char)
    if (byte === undefined) return undefined
    bytes.push(byte)
  }
  return Uint8Array.from(bytes)
}

function scoreUtf8AsWindows1251Mojibake(text: string): number {
  return [
    ...text.matchAll(/[РС][\u0080-\u00BF\u0400-\u045F]/gu),
    ...text.matchAll(/в[€Ђ„…†‡‰‹ЊЋЏ™њћџ]/gu),
    ...text.matchAll(/[Вв]Â?[«»]|Â|Ð|Ñ|Ã|â|ðŸ|рџ/gu),
    ...text.matchAll(/\uFFFD/gu),
  ].length
}

async function maybeRepairDownloadedTextAttachment(
  attachment: TelegramAttachment,
): Promise<void> {
  if (!attachment.localPath || !isLikelyTextAttachment(attachment)) return
  const fileStat = await stat(attachment.localPath)
  if (!fileStat.isFile() || fileStat.size > 1_000_000) return

  const raw = await readFile(attachment.localPath, 'utf8')
  const repaired = repairLikelyMojibakeText(raw)
  if (repaired === raw) return

  await writeFile(attachment.localPath, repaired, 'utf8')
  attachment.encodingRepair = 'utf8-as-windows1251-mojibake'
}

function isLikelyTextAttachment(attachment: TelegramAttachment): boolean {
  const mime = attachment.mimeType?.toLowerCase() || ''
  if (mime.startsWith('text/')) return true
  if (['application/json', 'application/xml', 'application/yaml'].includes(mime)) {
    return true
  }
  const extension = extname(attachment.fileName || attachment.localPath || '').toLowerCase()
  return ['.txt', '.md', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.yaml', '.yml'].includes(extension)
}

function telegramFilesIndexPath(): string {
  return join(getAgentGatewayStateDir(), 'telegram-files', 'index.json')
}

async function loadTelegramStoredFiles(): Promise<TelegramStoredFile[]> {
  try {
    const raw = await readFile(telegramFilesIndexPath(), 'utf8')
    const parsed = JSON.parse(raw) as { files?: TelegramStoredFile[] }
    return Array.isArray(parsed.files) ? parsed.files : []
  } catch {
    return []
  }
}

async function recordTelegramAttachment(
  chatId: string,
  messageId: number,
  attachment: TelegramAttachment,
): Promise<void> {
  if (!attachment.localPath) return
  const dir = join(getAgentGatewayStateDir(), 'telegram-files')
  await mkdir(dir, { recursive: true })

  const files = await loadTelegramStoredFiles()
  files.push({
    chatId,
    messageId,
    type: attachment.type,
    fileId: attachment.fileId,
    fileName: attachment.fileName || basename(attachment.localPath),
    mimeType: attachment.mimeType,
    size: attachment.size,
    localPath: attachment.localPath,
    createdAt: new Date().toISOString(),
  })

  const deduped = dedupeTelegramStoredFiles(files).slice(-500)
  await writeFile(
    telegramFilesIndexPath(),
    `${JSON.stringify({ files: deduped, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
}

function dedupeTelegramStoredFiles(
  files: TelegramStoredFile[],
): TelegramStoredFile[] {
  const byPath = new Map<string, TelegramStoredFile>()
  for (const file of files) byPath.set(file.localPath, file)
  return [...byPath.values()]
}

function formatAttachmentForPrompt(attachment: TelegramAttachment): string {
  const lines = [
    `- type: ${attachment.type}`,
    `  file_id: ${attachment.fileId}`,
  ]
  if (attachment.fileName) lines.push(`  file_name: ${attachment.fileName}`)
  if (attachment.mimeType) lines.push(`  mime_type: ${attachment.mimeType}`)
  if (attachment.size) lines.push(`  size_bytes: ${attachment.size}`)
  if (attachment.width && attachment.height) {
    lines.push(`  dimensions: ${attachment.width}x${attachment.height}`)
  }
  if (attachment.duration) lines.push(`  duration_seconds: ${attachment.duration}`)
  if (attachment.localPath) {
    lines.push(`  local_path: ${attachment.localPath}`)
    lines.push(`  prompt_reference: @${attachment.localPath}`)
  }
  if (attachment.transcriptPath) lines.push(`  transcript_path: ${attachment.transcriptPath}`)
  if (attachment.encodingRepair) {
    lines.push(`  encoding_repair: ${attachment.encodingRepair}`)
  }
  if (attachment.transcript) {
    lines.push('  transcript:')
    for (const line of attachment.transcript.split(/\r?\n/)) {
      lines.push(`    ${line}`)
    }
  }
  if (attachment.transcriptionError) {
    lines.push(`  transcription_error: ${attachment.transcriptionError}`)
  }
  if (attachment.downloadError) {
    lines.push(`  download_error: ${attachment.downloadError}`)
  }
  return lines.join('\n')
}

function splitTelegramText(text: string): string[] {
  const maxLength = 3900
  if (!text) return ['']
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength))
  }
  return chunks
}

function isTelegramPhotoFile(filePath: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(
    extname(filePath).toLowerCase(),
  )
}

function isVisualTelegramAttachment(attachment: TelegramAttachment): boolean {
  return attachment.type === 'photo'
    || Boolean(attachment.mimeType?.toLowerCase().startsWith('image/'))
    || Boolean(attachment.localPath && isTelegramPhotoFile(attachment.localPath))
}

function isAudioMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('audio/'))
}

function extensionFromTelegramPath(filePath: string | undefined): string {
  if (!filePath) return ''
  return extname(filePath).toLowerCase()
}

function extensionFromMime(mimeType: string | undefined): string {
  switch (mimeType?.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/png':
      return '.png'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'audio/ogg':
    case 'audio/opus':
      return '.ogg'
    case 'audio/mpeg':
      return '.mp3'
    case 'audio/mp4':
    case 'audio/x-m4a':
      return '.m4a'
    case 'video/mp4':
      return '.mp4'
    case 'application/pdf':
      return '.pdf'
    case 'text/plain':
      return '.txt'
    default:
      return ''
  }
}

function defaultExtensionForAttachmentType(type: string): string {
  switch (type) {
    case 'photo':
      return '.jpg'
    case 'voice':
      return '.ogg'
    case 'audio':
    case 'audio_document':
      return '.mp3'
    case 'video':
    case 'video_note':
      return '.mp4'
    case 'animation':
      return '.gif'
    case 'sticker':
      return '.webp'
    default:
      return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
