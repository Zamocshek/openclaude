import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  abortAtomicOutput,
  bundlePath,
  commitAtomicOutput,
  copyBundleSubtree,
  copyTreeRaw,
  loadRecentCanonicalMessages,
  prepareAtomicOutput,
  readBundleText,
  readJson,
  stableId,
  verifyBundle,
  writeJson,
} from './core.mjs'

export const TARGETS = ['openclaude', 'hermes', 'opencode', 'openclaw', 'codex']

function copyIfExists(source, destination) {
  if (!existsSync(source)) return false
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  return true
}

function copyBundleArchive(bundleRoot, output) {
  copyTreeRaw(bundleRoot, join(output, 'imports', 'nova-agent-bundle'))
}

function loadMcpServers(bundleRoot) {
  return readJson(bundlePath(bundleRoot, 'capabilities/mcp.json'), { servers: [] }).servers || []
}

function loadSkills(bundleRoot) {
  return readJson(bundlePath(bundleRoot, 'capabilities/skills.json'), { skills: [] }).skills || []
}

function loadComponents(bundleRoot) {
  return readJson(bundlePath(bundleRoot, 'capabilities/components.json'), { components: [] }).components || []
}

function copySkills(bundleRoot, destination) {
  const source = bundlePath(bundleRoot, 'capabilities/skills')
  if (existsSync(source)) copyTreeRaw(source, destination)
}

function runtimeBundleRoot(runtimeRoot) {
  return join(runtimeRoot, 'imports', 'nova-agent-bundle')
}

function directServerForTarget(server, runtimeRoot) {
  if (server.transport !== 'stdio') return { ...server }
  return {
    ...server,
    cwd: join(runtimeBundleRoot(runtimeRoot), 'workspace'),
  }
}

function standardMcpConfig(servers, runtimeRoot) {
  return {
    mcpServers: Object.fromEntries(servers
      .filter(server => server.name !== 'capability-router')
      .map(server => {
        const portable = directServerForTarget(server, runtimeRoot)
        return [portable.name, portable.transport === 'stdio'
          ? {
              command: portable.command,
              args: portable.args || [],
              cwd: portable.cwd,
              ...(portable.env ? { env: portable.env } : {}),
              ...(portable.allowedTools ? { allowedTools: portable.allowedTools } : {}),
              ...(portable.blockedTools ? { blockedTools: portable.blockedTools } : {}),
            }
          : {
              type: 'http',
              url: portable.url,
              ...(portable.headers ? { headers: portable.headers } : {}),
              ...(portable.allowedTools ? { allowedTools: portable.allowedTools } : {}),
              ...(portable.blockedTools ? { blockedTools: portable.blockedTools } : {}),
            }]
      })),
  }
}

function prepareCapabilityRuntime(bundleRoot, output, runtimeRoot, servers, exposure) {
  const components = loadComponents(bundleRoot)
  const routerComponent = components.find(component => component.id === 'capability-router' && !component.external)
  const directServers = servers
    .filter(server => server.name !== 'capability-router')
    .map(server => directServerForTarget(server, runtimeRoot))
  if (exposure === 'direct' || !routerComponent) {
    return {
      exposure: routerComponent ? 'direct' : 'direct-fallback',
      exposedServers: directServers,
      downstreamServers: directServers,
    }
  }

  const routerDirectory = join(output, 'capability-router')
  const runtimeRouterDirectory = join(runtimeRoot, 'capability-router')
  mkdirSync(routerDirectory, { recursive: true })
  writeJson(join(routerDirectory, 'mcp.json'), standardMcpConfig(servers, runtimeRoot))
  writeJson(join(routerDirectory, 'mcp.container.json'), standardMcpConfig(servers, '/workspace'))
  if (!copyIfExists(bundlePath(bundleRoot, 'state/capability-router/state.json'), join(routerDirectory, 'state.json'))) {
    writeJson(join(routerDirectory, 'state.json'), {
      schemaVersion: 1,
      disabledServers: [],
      disabledSkills: [],
      customServers: {},
    })
  }
  const savedSkills = bundlePath(bundleRoot, 'state/capability-router/skills')
  if (existsSync(savedSkills)) copyTreeRaw(savedSkills, join(routerDirectory, 'skills'))
  writeFileSync(join(output, 'install-capabilities.mjs'), [
    "import { spawnSync } from 'node:child_process'",
    "import { existsSync } from 'node:fs'",
    "import { dirname, join } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    "const root = dirname(fileURLToPath(import.meta.url))",
    "const component = join(root, 'imports', 'nova-agent-bundle', 'capabilities', 'components', 'capability-router')",
    "const workspace = join(root, 'imports', 'nova-agent-bundle', 'workspace')",
    "const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'",
    "for (const directory of [component, workspace]) {",
    "  if (!existsSync(join(directory, 'package.json'))) continue",
    "  const result = spawnSync(command, ['install', '--omit=dev', '--ignore-scripts'], { cwd: directory, stdio: 'inherit' })",
    "  if (result.status !== 0) process.exit(result.status ?? 1)",
    "}",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(output, 'portable-services.compose.yml'), [
    'services:',
    '  capability-router:',
    '    build:',
    '      context: ./imports/nova-agent-bundle/capabilities/components/capability-router',
    '    restart: unless-stopped',
    '    environment:',
    '      CAPABILITY_ROUTER_HOST: "0.0.0.0"',
    '      CAPABILITY_ROUTER_PORT: "8768"',
    '      CAPABILITY_ROUTER_API_KEY: "${CAPABILITY_ROUTER_API_KEY:?set CAPABILITY_ROUTER_API_KEY}"',
    '      CAPABILITY_ROUTER_WORKSPACE_ROOT: "/workspace"',
    '      CAPABILITY_ROUTER_MCP_CONFIG: "/workspace/capability-router/mcp.container.json"',
    '      CAPABILITY_ROUTER_REGISTRY: "/workspace/imports/nova-agent-bundle/capabilities/registry.json"',
    '      CAPABILITY_ROUTER_STATE: "/workspace/capability-router/state.json"',
    '      CAPABILITY_ROUTER_SKILL_STORE: "/workspace/capability-router/skills"',
    '      CAPABILITY_ROUTER_SKILL_ROOTS: "/workspace/imports/nova-agent-bundle/capabilities/skills"',
    '      CAPABILITY_ROUTER_LLM_BASE_URL: "http://omniroute:20128/v1"',
    '      CAPABILITY_ROUTER_LLM_MODEL: "${CAPABILITY_ROUTER_LLM_MODEL:-auto/best-fast}"',
    '      CAPABILITY_ROUTER_LLM_API_KEY: "${OMNIROUTE_API_KEY:-}"',
    '      OPENRAG_URL: "${OPENRAG_URL:-}"',
    '      OPENRAG_API_KEY: "${OPENRAG_API_KEY:-}"',
    '      CAMOFOX_URL: "${CAMOFOX_URL:-}"',
    '      CAMOFOX_ACCESS_KEY: "${CAMOFOX_ACCESS_KEY:-}"',
    '      CAMOFOX_API_KEY: "${CAMOFOX_API_KEY:-}"',
    '      HINDSIGHT_URL: "${HINDSIGHT_URL:-}"',
    '      HINDSIGHT_API_KEY: "${HINDSIGHT_API_KEY:-}"',
    '      CONTEXT7_API_KEY: "${CONTEXT7_API_KEY:-}"',
    '      GITHUB_MCP_PAT: "${GITHUB_MCP_PAT:-}"',
    '      SEARXNG_URL: "${SEARXNG_URL:-}"',
    '    ports:',
    '      - "127.0.0.1:${CAPABILITY_ROUTER_HOST_PORT:-19868}:8768"',
    '    volumes:',
    '      - ./:/workspace',
    '  omniroute:',
    '    image: diegosouzapw/omniroute:latest',
    '    restart: unless-stopped',
    '    environment:',
    '      PORT: "20128"',
    '      HOSTNAME: "0.0.0.0"',
    '      DATA_DIR: "/app/data"',
    '      REQUIRE_API_KEY: "true"',
    '      INITIAL_PASSWORD: "${OMNIROUTE_INITIAL_PASSWORD:-}"',
    '      STORAGE_ENCRYPTION_KEY: "${OMNIROUTE_STORAGE_ENCRYPTION_KEY:?set OMNIROUTE_STORAGE_ENCRYPTION_KEY}"',
    '      JWT_SECRET: "${OMNIROUTE_JWT_SECRET:?set OMNIROUTE_JWT_SECRET}"',
    '      API_KEY_SECRET: "${OMNIROUTE_API_KEY_SECRET:?set OMNIROUTE_API_KEY_SECRET}"',
    '    ports:',
    '      - "127.0.0.1:${OMNIROUTE_HOST_PORT:-20128}:20128"',
    '    volumes:',
    '      - omniroute-data:/app/data',
    'volumes:',
    '  omniroute-data:',
    '',
  ].join('\n'), 'utf8')

  const routerServer = {
    name: 'capability-router',
    transport: 'stdio',
    enabled: true,
    command: 'node',
    args: [join(runtimeBundleRoot(runtimeRoot), 'capabilities', 'components', 'capability-router', 'src', 'mcp.mjs')],
    cwd: runtimeRoot,
    env: {
      CAPABILITY_ROUTER_WORKSPACE_ROOT: runtimeRoot,
      CAPABILITY_ROUTER_MCP_CONFIG: join(runtimeRouterDirectory, 'mcp.json'),
      CAPABILITY_ROUTER_REGISTRY: join(runtimeBundleRoot(runtimeRoot), 'capabilities', 'registry.json'),
      CAPABILITY_ROUTER_STATE: join(runtimeRouterDirectory, 'state.json'),
      CAPABILITY_ROUTER_SKILL_STORE: join(runtimeRouterDirectory, 'skills'),
      CAPABILITY_ROUTER_SKILL_ROOTS: join(runtimeBundleRoot(runtimeRoot), 'capabilities', 'skills'),
    },
    description: 'Portable lazy capability router, Skill Store, and workspace file manager.',
  }
  return {
    exposure,
    exposedServers: exposure === 'both' ? [routerServer, ...directServers] : [routerServer],
    downstreamServers: directServers,
  }
}

function quoteYaml(value) {
  return JSON.stringify(String(value))
}

function renderYamlMap(map, indent) {
  const prefix = ' '.repeat(indent)
  const entries = Object.entries(map || {})
  if (!entries.length) return `${prefix}{}`
  return entries.map(([key, value]) => `${prefix}${JSON.stringify(key)}: ${quoteYaml(value)}`).join('\n')
}

function renderHermesConfig(servers) {
  const lines = [
    '# Generated by OpenClaude Agent Migration. Credential values stay in .env.',
    'mcp_servers:',
  ]
  if (!servers.length) lines.push('  {}')
  for (const server of servers) {
    lines.push(`  ${JSON.stringify(server.name)}:`)
    if (server.transport === 'stdio') {
      lines.push(`    command: ${quoteYaml(server.command)}`)
      lines.push(`    args: ${JSON.stringify(server.args || [])}`)
      if (server.cwd) lines.push(`    cwd: ${quoteYaml(server.cwd)}`)
      if (server.env && Object.keys(server.env).length) {
        lines.push('    env:')
        lines.push(renderYamlMap(server.env, 6))
      }
    } else {
      lines.push(`    url: ${quoteYaml(server.url)}`)
      if (server.headers && Object.keys(server.headers).length) {
        lines.push('    headers:')
        lines.push(renderYamlMap(server.headers, 6))
      }
    }
    if (!server.enabled) lines.push('    disabled: true')
  }
  lines.push('')
  return lines.join('\n')
}

function openCodeMcpV2(servers) {
  return {
    servers: Object.fromEntries(servers.map(server => [server.name, server.transport === 'stdio'
      ? {
          type: 'local',
          command: [server.command, ...(server.args || [])],
          disabled: !server.enabled,
          ...(server.cwd ? { cwd: server.cwd } : {}),
          ...(server.env ? { environment: server.env } : {}),
        }
      : {
          type: 'remote',
          url: server.url,
          disabled: !server.enabled,
          ...(server.headers ? { headers: server.headers } : {}),
        }]))
  }
}

function openClawMcp(servers) {
  return Object.fromEntries(servers.map(server => [server.name, server.transport === 'stdio'
    ? {
        command: server.command,
        args: server.args || [],
        enabled: server.enabled,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        ...(server.env ? { env: server.env } : {}),
      }
    : {
        url: server.url,
        enabled: server.enabled,
        ...(server.headers ? { headers: server.headers } : {}),
      }]))
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function tomlInlineTable(value) {
  return `{ ${Object.entries(value || {}).map(([key, item]) => `${tomlString(key)} = ${tomlString(item)}`).join(', ')} }`
}

function renderCodexConfig(servers) {
  const lines = [
    '# Generated migration config. Merge into an existing config.toml only after review.',
    '',
  ]
  for (const server of servers) {
    lines.push(`[mcp_servers.${tomlString(server.name)}]`)
    if (server.transport === 'stdio') {
      lines.push(`command = ${tomlString(server.command)}`)
      lines.push(`args = ${JSON.stringify(server.args || [])}`)
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`)
      if (server.env && Object.keys(server.env).length) lines.push(`env = ${tomlInlineTable(server.env)}`)
    } else {
      lines.push(`url = ${tomlString(server.url)}`)
      if (server.headers && Object.keys(server.headers).length) {
        lines.push(`http_headers = ${tomlInlineTable(server.headers)}`)
      }
    }
    lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`, '')
  }
  return lines.join('\n')
}

function partToText(part) {
  if (!part || typeof part !== 'object') return ''
  if (part.type === 'text' || part.type === 'reasoning') return String(part.text || '')
  if (part.type === 'tool_call') return `[tool call: ${part.name || 'unknown'} ${JSON.stringify(part.input || {})}]`
  if (part.type === 'tool_result') return `[tool result: ${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}]`
  return ''
}

function messageText(message) {
  return (message.parts || []).map(partToText).filter(Boolean).join('\n')
}

function renderRecentHistory(messages, maxChars = 250_000) {
  const chunks = []
  let used = 0
  for (const message of messages) {
    const text = messageText(message).trim()
    if (!text) continue
    const chunk = `## ${String(message.role || 'event').toUpperCase()} · ${message.timestamp || ''}\n\n${text}\n\n`
    chunks.push(chunk)
    used += chunk.length
    while (used > maxChars && chunks.length > 1) used -= chunks.shift().length
  }
  return chunks.join('')
}

function renderHandoff(bundleRoot, messages, target) {
  const manifest = readJson(bundlePath(bundleRoot, 'manifest.json'), {})
  const soul = readBundleText(bundleRoot, 'identity/SOUL.md')
  const user = readBundleText(bundleRoot, 'identity/USER.md')
  const memory = readBundleText(bundleRoot, 'identity/MEMORY.md')
  return [
    `# ${manifest.agent?.name || 'NOVA'} migration handoff`,
    '',
    `Target runtime: ${target}`,
    '',
    'This file is a generated continuation context. The canonical, checksum-verified',
    'history and every imported artifact remain under `imports/nova-agent-bundle/`.',
    'Do not treat this summary as a replacement for the archive when exact history matters.',
    '',
    '## Identity',
    '',
    soul || '(No identity file was exported.)',
    '',
    '## User',
    '',
    user || '(No user profile was exported.)',
    '',
    '## Durable memory',
    '',
    memory || '(No durable memory file was exported.)',
    '',
    '## Recent conversation continuation',
    '',
    renderRecentHistory(messages),
  ].join('\n')
}

function writeMigrationReadme(output, target, extra = []) {
  writeFileSync(join(output, 'MIGRATION.md'), [
    `# ${target} migration pack`,
    '',
    'The source bundle passed SHA-256 verification before this pack was created.',
    'No API keys, OAuth tokens, passwords, cookies, or private keys are included.',
    'Fill `secrets.required.env` from the target machine secret manager.',
    '',
    ...extra,
    '',
  ].join('\n'), 'utf8')
}

function openCodeSession(messages, runtimeRoot) {
  const now = Date.now()
  const sessionId = `ses_${stableId('', `nova:${now}`).replace(/^_/, '').slice(0, 26)}`
  const projectId = stableId('', resolve(runtimeRoot)).replace(/^_/, '').slice(0, 40)
  const normalized = messages.filter(message => message.role === 'user' || message.role === 'assistant')
  const created = normalized.length ? Date.parse(normalized[0].timestamp) || now : now
  const updated = normalized.length ? Date.parse(normalized.at(-1).timestamp) || now : now
  let parentId
  const exportedMessages = normalized.map((message, index) => {
    const messageId = `msg_${stableId('', `${sessionId}:${message.id}:${index}`).replace(/^_/, '').slice(0, 26)}`
    const timestamp = Date.parse(message.timestamp) || now
    const info = message.role === 'user'
      ? {
          role: 'user',
          time: { created: timestamp },
          agent: 'build',
          model: { providerID: 'openclaude-migration', modelID: 'nova-history' },
          summary: { diffs: [] },
          id: messageId,
          sessionID: sessionId,
        }
      : {
          parentID: parentId,
          role: 'assistant',
          mode: 'build',
          agent: 'build',
          path: { cwd: resolve(runtimeRoot), root: resolve(runtimeRoot) },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
          modelID: 'nova-history',
          providerID: 'openclaude-migration',
          time: { created: timestamp, completed: timestamp },
          finish: 'stop',
          id: messageId,
          sessionID: sessionId,
        }
    parentId = messageId
    const text = messageText(message)
    return {
      info,
      parts: [{
        type: 'text',
        text,
        id: `prt_${stableId('', `${messageId}:text`).replace(/^_/, '').slice(0, 26)}`,
        sessionID: sessionId,
        messageID: messageId,
      }],
    }
  })
  return {
    info: {
      id: sessionId,
      slug: 'nova-migration',
      projectID: projectId,
      directory: resolve(runtimeRoot),
      title: 'NOVA imported conversation',
      version: 'migration-v1',
      summary: { additions: 0, deletions: 0, files: 0 },
      time: { created, updated },
    },
    messages: exportedMessages,
  }
}

function writeOpenClawSession(messages, output, runtimeRoot) {
  const sessionId = stableId('nova', `${Date.now()}:${messages.length}`)
  const sessionDirectory = join(output, 'agents', 'nova', 'sessions')
  const runtimeSessionDirectory = join(runtimeRoot, 'agents', 'nova', 'sessions')
  mkdirSync(sessionDirectory, { recursive: true })
  const transcriptPath = join(sessionDirectory, `${sessionId}.jsonl`)
  const now = new Date().toISOString()
  const lines = [JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: now, cwd: join(runtimeRoot, 'workspace') })]
  let parentId
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') continue
    const id = stableId('entry', `${sessionId}:${message.id}:${index}`)
    lines.push(JSON.stringify({
      type: 'message',
      id,
      ...(parentId ? { parentId } : {}),
      timestamp: message.timestamp || now,
      message: {
        role: message.role,
        content: [{ type: 'text', text: messageText(message) }],
        timestamp: Date.parse(message.timestamp) || Date.now(),
      },
    }))
    parentId = id
  }
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8')
  const updatedAt = messages.length ? Date.parse(messages.at(-1).timestamp) || Date.now() : Date.now()
  writeJson(join(sessionDirectory, 'sessions.json'), {
    'agent:nova:main': {
      sessionId,
      sessionStartedAt: messages.length ? Date.parse(messages[0].timestamp) || updatedAt : updatedAt,
      lastInteractionAt: updatedAt,
      updatedAt,
      sessionFile: join(runtimeSessionDirectory, `${sessionId}.jsonl`),
      displayName: 'NOVA imported history',
    },
  })
}

async function adaptOpenClaude(bundleRoot, output, servers) {
  copyIfExists(bundlePath(bundleRoot, 'state/agent-gateway.json'), join(output, 'agent-gateway.json'))
  copyBundleSubtree(bundleRoot, 'state/memory', join(output, 'agent-gateway', 'memory'))
  for (const name of ['cron-jobs.json', 'telegram-conversation-sessions.json', 'tool-router-audit.json']) {
    copyIfExists(bundlePath(bundleRoot, `state/${name}`), join(output, 'agent-gateway', name))
  }
  copyIfExists(bundlePath(bundleRoot, 'conversations/raw/gateway/chat.jsonl'), join(output, 'agent-gateway', 'logs', 'chat.jsonl'))
  const projects = bundlePath(bundleRoot, 'conversations/raw/projects')
  if (existsSync(projects)) copyTreeRaw(projects, join(output, 'projects'))
  copySkills(bundleRoot, join(output, 'skills'))
  copyIfExists(bundlePath(bundleRoot, 'capabilities/mcp.json'), join(output, 'agent-gateway', 'mcp', 'portable-registry.json'))
  writeJson(join(output, 'agent-gateway', 'mcp', 'capability-router.json'), {
    mcpServers: Object.fromEntries(servers.map(server => [server.name, server.transport === 'stdio'
      ? { command: server.command, args: server.args || [], cwd: server.cwd, env: server.env || {} }
      : { type: 'http', url: server.url, headers: server.headers || {} }])),
  })
  const workspace = bundlePath(bundleRoot, 'workspace')
  if (existsSync(workspace)) copyTreeRaw(workspace, join(output, 'imported-workspace'))
  copyBundleArchive(bundleRoot, output)
  copyIfExists(bundlePath(bundleRoot, 'secrets.required.env'), join(output, 'secrets.required.env'))
  writeMigrationReadme(output, 'OpenClaude', [
    'Use this directory as `OPENCLAUDE_HOME` or mount it at `/home/node/.openclaude`.',
    'Provider and account authentication must be restored separately.',
  ])
}

async function adaptHermes(bundleRoot, output, messages, servers) {
  copyIfExists(bundlePath(bundleRoot, 'identity/SOUL.md'), join(output, 'SOUL.md'))
  copyIfExists(bundlePath(bundleRoot, 'identity/MEMORY.md'), join(output, 'memories', 'MEMORY.md'))
  copyIfExists(bundlePath(bundleRoot, 'identity/USER.md'), join(output, 'memories', 'USER.md'))
  copyBundleSubtree(bundleRoot, 'state/memory', join(output, 'memories', 'openclaude-state'))
  copySkills(bundleRoot, join(output, 'skills'))
  writeFileSync(join(output, 'config.yaml'), renderHermesConfig(servers), 'utf8')
  writeFileSync(join(output, 'AGENTS.md'), renderHandoff(bundleRoot, messages, 'Hermes'), 'utf8')
  copyIfExists(bundlePath(bundleRoot, 'state/cron-jobs.json'), join(output, 'cron', 'openclaude-jobs.json'))
  copyBundleArchive(bundleRoot, output)
  copyIfExists(bundlePath(bundleRoot, 'secrets.required.env'), join(output, '.env.example'))
  writeMigrationReadme(output, 'Hermes', [
    'Run Hermes with this directory as `HERMES_HOME`.',
    'The generated `config.yaml` contains MCP definitions and no credentials.',
    'OpenClaude cron jobs are archived for semantic migration; their schedules are not activated blindly.',
  ])
}

async function adaptOpenCode(bundleRoot, output, messages, servers, runtimeRoot) {
  copySkills(bundleRoot, join(output, '.opencode', 'skills'))
  const handoff = renderHandoff(bundleRoot, messages, 'OpenCode')
  mkdirSync(join(output, '.opencode', 'agents'), { recursive: true })
  writeFileSync(join(output, '.opencode', 'agents', 'nova.md'), [
    '---',
    'description: Continue the migrated NOVA agent with its durable memory and tools',
    'mode: primary',
    '---',
    '',
    handoff,
  ].join('\n'), 'utf8')
  writeJson(join(output, 'opencode.json'), {
    $schema: 'https://opencode.ai/config.json',
    mcp: openCodeMcpV2(servers),
  })
  const session = openCodeSession(messages, runtimeRoot)
  writeJson(join(output, 'imports', 'opencode-sessions', 'nova.json'), session)
  copyBundleArchive(bundleRoot, output)
  copyIfExists(bundlePath(bundleRoot, 'secrets.required.env'), join(output, 'secrets.required.env'))
  writeMigrationReadme(output, 'OpenCode', [
    'Use this directory as the OpenCode config directory, or merge `opencode.json` into yours.',
    'Import the native continuation session with:',
    '`opencode import imports/opencode-sessions/nova.json`',
    'Skills use the native `.opencode/skills/<name>/SKILL.md` layout.',
  ])
}

async function adaptOpenClaw(bundleRoot, output, messages, servers, runtimeRoot) {
  const workspace = join(output, 'workspace')
  const runtimeWorkspace = join(runtimeRoot, 'workspace')
  mkdirSync(workspace, { recursive: true })
  copyIfExists(bundlePath(bundleRoot, 'identity/SOUL.md'), join(workspace, 'SOUL.md'))
  copyIfExists(bundlePath(bundleRoot, 'identity/USER.md'), join(workspace, 'USER.md'))
  copyIfExists(bundlePath(bundleRoot, 'identity/MEMORY.md'), join(workspace, 'MEMORY.md'))
  writeFileSync(join(workspace, 'AGENTS.md'), renderHandoff(bundleRoot, messages, 'OpenClaw'), 'utf8')
  writeFileSync(join(workspace, 'IDENTITY.md'), '# NOVA\n\nIdentity imported from an OpenClaude agent bundle.\n', 'utf8')
  writeFileSync(join(workspace, 'TOOLS.md'), '# Tools\n\nMCP servers are configured under `mcp.servers` in `openclaw.json`.\n', 'utf8')
  copySkills(bundleRoot, join(workspace, 'skills'))
  const importedWorkspace = bundlePath(bundleRoot, 'workspace')
  if (existsSync(importedWorkspace)) copyTreeRaw(importedWorkspace, join(workspace, 'imported'))
  writeJson(join(output, 'openclaw.json'), {
    agents: {
      defaults: { workspace: runtimeWorkspace },
      list: [{ id: 'nova', name: 'NOVA', workspace: runtimeWorkspace, skills: loadSkills(bundleRoot).map(skill => skill.name) }],
    },
    mcp: { servers: openClawMcp(servers) },
    tools: { codeMode: { enabled: true } },
  })
  writeOpenClawSession(messages, output, runtimeRoot)
  copyBundleArchive(bundleRoot, output)
  copyIfExists(bundlePath(bundleRoot, 'secrets.required.env'), join(output, 'secrets.required.env'))
  writeMigrationReadme(output, 'OpenClaw', [
    'Use this directory as the OpenClaw home and start agent `nova`.',
    'The generated session index links a native OpenClaw JSONL continuation transcript.',
    'Run `openclaw mcp doctor --probe` after filling target secrets.',
  ])
}

async function adaptCodex(bundleRoot, output, messages, servers) {
  const codexDir = join(output, '.codex')
  mkdirSync(codexDir, { recursive: true })
  copySkills(bundleRoot, join(codexDir, 'skills'))
  writeFileSync(join(output, 'AGENTS.md'), renderHandoff(bundleRoot, messages, 'Codex'), 'utf8')
  writeFileSync(join(codexDir, 'config.toml'), renderCodexConfig(servers), 'utf8')
  copyBundleArchive(bundleRoot, output)
  const importedWorkspace = bundlePath(bundleRoot, 'workspace')
  if (existsSync(importedWorkspace)) copyTreeRaw(importedWorkspace, join(output, 'imported-workspace'))
  copyIfExists(bundlePath(bundleRoot, 'secrets.required.env'), join(codexDir, 'secrets.required.env'))
  writeMigrationReadme(output, 'Codex', [
    'Open this directory as a Codex workspace. `AGENTS.md` is the continuation context.',
    'Codex does not expose a stable cross-runtime thread-import API, so the complete canonical',
    'history remains under `imports/nova-agent-bundle/conversations/`.',
  ])
}

export async function adaptBundle(options) {
  const bundleRoot = resolve(options.bundle)
  const target = String(options.target || '').toLowerCase()
  if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}. Expected one of: ${TARGETS.join(', ')}`)
  const verification = verifyBundle(bundleRoot)
  if (!verification.ok) throw new Error(`Bundle verification failed:\n- ${verification.errors.join('\n- ')}`)
  const transaction = prepareAtomicOutput(options.output, options.force)
  const output = transaction.partial
  try {
    const messages = await loadRecentCanonicalMessages(bundleRoot, Number(options.recentMessages || 600))
    const servers = loadMcpServers(bundleRoot)
    const requestedExposure = String(options.exposure || 'routed').toLowerCase()
    if (!['routed', 'direct', 'both'].includes(requestedExposure)) {
      throw new Error('exposure must be routed, direct, or both')
    }
    const capabilityRuntime = prepareCapabilityRuntime(
      bundleRoot,
      output,
      transaction.target,
      servers,
      requestedExposure,
    )
    const exposedServers = capabilityRuntime.exposedServers
    if (target === 'openclaude') await adaptOpenClaude(bundleRoot, output, exposedServers)
    if (target === 'hermes') await adaptHermes(bundleRoot, output, messages, exposedServers)
    if (target === 'opencode') await adaptOpenCode(bundleRoot, output, messages, exposedServers, transaction.target)
    if (target === 'openclaw') await adaptOpenClaw(bundleRoot, output, messages, exposedServers, transaction.target)
    if (target === 'codex') await adaptCodex(bundleRoot, output, messages, exposedServers)
    writeJson(join(output, 'migration-result.json'), {
      schemaVersion: 1,
      sourceBundleId: verification.manifest.id,
      target,
      createdAt: new Date().toISOString(),
      recentMessagesMaterialized: messages.length,
      completeHistoryPath: target === 'codex'
        ? 'imports/nova-agent-bundle/conversations/messages.jsonl'
        : target === 'openclaude'
          ? 'agent-gateway/logs/chat.jsonl'
          : 'imports/nova-agent-bundle/conversations/messages.jsonl',
      mcpServers: servers.length,
      exposedMcpServers: exposedServers.length,
      capabilityExposure: capabilityRuntime.exposure,
      skills: loadSkills(bundleRoot).length,
    })
    const committedOutput = commitAtomicOutput(transaction)
    return {
      output: committedOutput,
      target,
      messages: messages.length,
      mcpServers: servers.length,
      exposedMcpServers: exposedServers.length,
      capabilityExposure: capabilityRuntime.exposure,
      skills: loadSkills(bundleRoot).length,
    }
  } catch (error) {
    abortAtomicOutput(transaction)
    throw error
  }
}
