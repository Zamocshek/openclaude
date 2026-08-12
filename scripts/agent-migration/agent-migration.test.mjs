import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adaptBundle } from './adapters.mjs'
import { exportOpenClaudeBundle, inspectBundle, readJson, verifyBundle, writeJson } from './core.mjs'

const roots = []

setDefaultTimeout(30_000)

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openclaude-migration-'))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  mkdirSync(join(home, 'agent-gateway', 'memory', 'knowledge'), { recursive: true })
  mkdirSync(join(home, 'agent-gateway', 'logs'), { recursive: true })
  mkdirSync(join(home, 'capability-router'), { recursive: true })
  mkdirSync(join(home, 'projects', '-workspace'), { recursive: true })
  mkdirSync(join(workspace, 'skills', 'sample'), { recursive: true })
  mkdirSync(join(workspace, 'packages', 'capability-router', 'src'), { recursive: true })
  mkdirSync(join(workspace, 'profile'), { recursive: true })

  writeJson(join(home, 'agent-gateway.json'), {
    api: { modelName: 'nova', apiKey: 'sk-123456789012345678901234567890' },
    telegram: { botToken: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi' },
    subagents: {
      routes: {
        code: {
          provider: 'example',
          model: 'frontier',
          baseUrl: 'https://example.test/v1',
          apiKeyEnv: 'EXAMPLE_API_KEY',
        },
      },
    },
  })
  writeFileSync(join(home, 'agent-gateway', 'memory', 'identity.md'), '# NOVA\nPersistent identity.\n')
  writeFileSync(join(home, 'agent-gateway', 'memory', 'USER.md'), '# User\nPrefers complete migrations.\n')
  writeFileSync(join(home, 'agent-gateway', 'memory', 'MEMORY.md'), '# Memory\nMigration decisions are durable.\n')
  writeFileSync(join(home, 'agent-gateway', 'memory', 'scratchpad.md'), '# Scratchpad\nCurrent work.\n')
  writeJson(join(home, 'agent-gateway', 'memory', 'curated_memory.json'), { version: 1, entries: [] })
  writeJson(join(home, 'agent-gateway', 'cron-jobs.json'), { jobs: [], updatedAt: '2026-08-07T00:00:00.000Z' })
  writeJson(join(home, 'capability-router', 'state.json'), {
    schemaVersion: 2,
    disabledServers: [],
    disabledSkills: [],
    disabledTools: { local: ['dangerous_fixture'] },
    toolInventory: {
      local: [{
        name: 'inspect_fixture',
        description: 'Inspect fixture source with opaque-tool-secret-value-1234567890',
        inputSchema: {
          type: 'object',
          properties: {
            apiToken: {
              type: 'string',
              description: 'Provider credential',
              default: 'opaque-tool-secret-value-1234567890',
            },
          },
        },
      }],
    },
    toolInventoryMeta: {
      local: { source: 'live', discoveredAt: '2026-08-07T00:00:00.000Z' },
    },
    customServers: {
      legacy: {
        type: 'http',
        url: 'https://legacy.example.test/mcp',
        headers: { Authorization: 'Bearer literal-router-secret-1234567890' },
        env: { LEGACY_API_KEY: 'literal-router-key-1234567890' },
      },
    },
  })

  const gatewayHistory = [
    { ts: '2026-08-07T00:00:00.000Z', direction: 'inbound', text: 'Remember the migration.', chatId: '42', messageId: 1 },
    { ts: '2026-08-07T00:00:01.000Z', direction: 'outbound', text: 'Stored. sk-abcdefghijklmnopqrstuvwxyz123456', chatId: '42', messageId: 2 },
  ]
  writeFileSync(
    join(home, 'agent-gateway', 'logs', 'chat.jsonl'),
    `${gatewayHistory.map(value => JSON.stringify(value)).join('\n')}\n`,
  )
  writeFileSync(join(home, 'agent-gateway', 'logs', 'task_reflections.jsonl'), '{"lesson":"verify migrations"}\n')
  mkdirSync(join(home, 'agent-gateway', 'telegram-files', '42', '1'), { recursive: true })
  writeFileSync(join(home, 'agent-gateway', 'telegram-files', '42', '1', 'note.txt'), 'portable attachment')

  const projectHistory = [
    {
      type: 'user',
      uuid: 'user-1',
      sessionId: 'project-session',
      timestamp: '2026-08-07T00:01:00.000Z',
      message: { role: 'user', content: 'Implement the adapter.' },
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      parentUuid: 'user-1',
      sessionId: 'project-session',
      timestamp: '2026-08-07T00:01:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Adapter implemented.' }] },
    },
  ]
  writeFileSync(
    join(home, 'projects', '-workspace', 'project-session.jsonl'),
    `${projectHistory.map(value => JSON.stringify(value)).join('\n')}\n`,
  )

  writeFileSync(join(workspace, 'skills', 'sample', 'SKILL.md'), [
    '---',
    'name: sample',
    'description: Sample portable skill',
    '---',
    '',
    '# Sample',
    '',
    'Use the portable sample tool.',
  ].join('\n'))
  writeJson(join(workspace, '.mcp.json'), {
    mcpServers: {
      local: { command: 'node', args: ['server.mjs'], env: { LOCAL_API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz123456' } },
      remote: { type: 'http', url: 'https://mcp.example.test', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456' } },
    },
  })
  writeFileSync(join(workspace, 'packages', 'capability-router', 'package.json'), JSON.stringify({
    name: '@fixture/capability-router',
    type: 'module',
    dependencies: { '@modelcontextprotocol/sdk': '1.29.0' },
  }))
  writeFileSync(join(workspace, 'packages', 'capability-router', 'src', 'mcp.mjs'), '// fixture router entrypoint\n')
  writeJson(join(workspace, 'capability-registry.json'), {
    schemaVersion: 1,
    servers: {
      local: { description: 'Local fixture tools', tags: ['fixture', 'local'] },
      remote: { description: 'Remote fixture tools', tags: ['fixture', 'remote'] },
    },
    components: [{
      id: 'capability-router',
      name: 'Capability Router',
      kind: 'mcp-router',
      root: 'packages/capability-router',
    }],
  })
  writeFileSync(join(workspace, 'profile', 'README.md'), '# Portable profile\n')
  writeJson(join(workspace, 'agent-portability.json'), {
    schemaVersion: 1,
    agent: { id: 'nova', name: 'NOVA' },
    workspace: { include: ['profile'] },
    capabilities: {
      skillRoots: ['skills'],
      mcpConfigs: ['.mcp.json'],
      registry: 'capability-registry.json',
      components: [{ id: 'capability-router', root: 'packages/capability-router' }],
    },
  })
  writeFileSync(join(workspace, '.env'), 'EXAMPLE_API_KEY=not-exported\nANOTHER_PASSWORD=not-exported\n')
  return { root, home, workspace }
}

describe('agent migration bundle', () => {
  test('exports a verified, redacted, complete canonical bundle', async () => {
    const { root, home, workspace } = fixture()
    const output = join(root, 'nova.agent-bundle')
    const result = await exportOpenClaudeBundle({ sourceHome: home, workspace, output, history: 'full' })

    expect(result.manifest.schema).toBe('openclaude.agent-bundle/v1')
    expect(result.manifest.statistics.conversations).toBe(4)
    expect(result.manifest.statistics.sessions).toBe(2)
    expect(result.manifest.statistics.skills).toBe(1)
    expect(result.manifest.statistics.mcpServers).toBe(2)
    expect(result.manifest.statistics.components).toBe(1)
    expect(verifyBundle(output).ok).toBe(true)
    expect(inspectBundle(output).totalBytes).toBeGreaterThan(0)

    const allHistory = readFileSync(join(output, 'conversations', 'messages.jsonl'), 'utf8')
    const rawHistory = readFileSync(join(output, 'conversations', 'raw', 'gateway', 'chat.jsonl'), 'utf8')
    const config = readFileSync(join(output, 'state', 'agent-gateway.json'), 'utf8')
    const secretTemplate = readFileSync(join(output, 'secrets.required.env'), 'utf8')
    expect(allHistory).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(rawHistory).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
    expect(config).not.toContain('sk-123456789012345678901234567890')
    expect(secretTemplate).toContain('MIGRATED_AGENT_GATEWAY_API_APIKEY=')
    expect(secretTemplate).toContain('EXAMPLE_API_KEY=')
    expect(secretTemplate).toContain('LOCAL_API_KEY=')
    const mcp = readJson(join(output, 'capabilities', 'mcp.json'))
    expect(mcp.servers.find(server => server.name === 'local').env.LOCAL_API_KEY).toBe('${LOCAL_API_KEY}')
    const tools = readJson(join(output, 'capabilities', 'tools.json'))
    expect(tools.inventories.local[0].name).toBe('inspect_fixture')
    expect(tools.inventoryMetadata.local.source).toBe('live')
    expect(tools.disabledTools.local).toEqual(['dangerous_fixture'])
    const routerState = readJson(join(output, 'state', 'capability-router', 'state.json'))
    expect(routerState.schemaVersion).toBe(2)
    expect(routerState.customServers.legacy.headers.Authorization).toStartWith('${')
    expect(routerState.customServers.legacy.env.LEGACY_API_KEY).toBe('${LEGACY_API_KEY}')
    expect(readFileSync(join(output, 'state', 'capability-router', 'state.json'), 'utf8')).not.toContain('literal-router')
    expect(readFileSync(join(output, 'state', 'capability-router', 'state.json'), 'utf8')).not.toContain('opaque-tool-secret')
    expect(readFileSync(join(output, 'capabilities', 'tools.json'), 'utf8')).not.toContain('opaque-tool-secret')
    expect(routerState.toolInventory.local[0].inputSchema.properties.apiToken.description).toBe('Provider credential')
    expect(secretTemplate).toContain('LEGACY_API_KEY=')
    expect(readJson(join(output, 'capabilities', 'native-tools.json')).runner.disableTools).toBe(false)
    expect(existsSync(join(output, 'contexts', 'logs', 'task_reflections.jsonl'))).toBe(true)
    expect(readFileSync(join(output, 'contexts', 'telegram-files', '42', '1', 'note.txt'), 'utf8')).toBe('portable attachment')
    expect(existsSync(join(output, 'workspace', 'profile', 'README.md'))).toBe(true)
  })

  test('defaults to gateway history instead of unrelated project sessions', async () => {
    const { root, home, workspace } = fixture()
    const output = join(root, 'default.agent-bundle')
    const result = await exportOpenClaudeBundle({ sourceHome: home, workspace, output })

    expect(result.manifest.options.history).toBe('gateway')
    expect(result.manifest.statistics.conversations).toBe(2)
    expect(existsSync(join(
      output,
      'conversations',
      'raw',
      'projects',
      '-workspace',
      'project-session.jsonl',
    ))).toBe(false)
  })

  test('materializes all supported target layouts from one bundle', async () => {
    const { root, home, workspace } = fixture()
    const bundle = join(root, 'nova.agent-bundle')
    await exportOpenClaudeBundle({ sourceHome: home, workspace, output: bundle, history: 'full' })

    const assertions = {
      openclaude: ['agent-gateway.json', 'agent-gateway/memory/MEMORY.md', 'projects/-workspace/project-session.jsonl'],
      hermes: ['SOUL.md', 'memories/MEMORY.md', 'config.yaml', 'skills/sample/SKILL.md'],
      opencode: ['opencode.json', '.opencode/agents/nova.md', '.opencode/skills/sample/SKILL.md', 'imports/opencode-sessions/nova.json'],
      openclaw: ['openclaw.json', 'workspace/AGENTS.md', 'workspace/skills/sample/SKILL.md', 'agents/nova/sessions/sessions.json'],
      codex: ['AGENTS.md', '.codex/config.toml', '.codex/skills/sample/SKILL.md'],
    }

    for (const [target, expectedPaths] of Object.entries(assertions)) {
      const output = join(root, target)
      const result = await adaptBundle({ bundle, target, output })
      expect(result.target).toBe(target)
      expect(result.mcpServers).toBe(2)
      expect(result.exposedMcpServers).toBe(1)
      expect(result.capabilityExposure).toBe('routed')
      for (const path of expectedPaths) expect(existsSync(join(output, path))).toBe(true)
      expect(existsSync(join(output, 'install-capabilities.mjs'))).toBe(true)
      expect(existsSync(join(output, 'portable-services.compose.yml'))).toBe(true)
      expect(existsSync(join(output, 'capability-router', 'mcp.json'))).toBe(true)
      expect(readFileSync(join(output, 'capability-router', 'state.json'), 'utf8')).not.toContain('opaque-tool-secret')
      expect(readFileSync(join(output, 'imports', 'nova-agent-bundle', 'state', 'capability-router', 'state.json'), 'utf8')).not.toContain('opaque-tool-secret')
      expect(existsSync(join(output, 'imports', 'nova-agent-bundle', 'capabilities', 'components', 'capability-router', 'src', 'mcp.mjs'))).toBe(true)
    }

    const opencodeSession = readJson(join(root, 'opencode', 'imports', 'opencode-sessions', 'nova.json'))
    expect(opencodeSession.info.id).toStartWith('ses_')
    expect(opencodeSession.info.directory).toBe(join(root, 'opencode'))
    expect(opencodeSession.info.directory).not.toContain('.partial-')
    expect(opencodeSession.messages.length).toBe(4)
    const openclaw = readJson(join(root, 'openclaw', 'openclaw.json'))
    expect(openclaw.agents.defaults.workspace).toBe(join(root, 'openclaw', 'workspace'))
    expect(Object.keys(openclaw.mcp.servers)).toEqual(['capability-router'])
    const openclawSessions = readJson(join(root, 'openclaw', 'agents', 'nova', 'sessions', 'sessions.json'))
    expect(openclawSessions['agent:nova:main'].sessionFile).not.toContain('.partial-')
    expect(readFileSync(join(root, 'codex', '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers."capability-router"]')
  })

  test('keeps an existing target intact when forced export fails', async () => {
    const { root, home, workspace } = fixture()
    const output = join(root, 'existing.agent-bundle')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'keep.txt'), 'working profile')
    writeFileSync(join(workspace, '.mcp.json'), '{ invalid json')

    let failed = false
    try {
      await exportOpenClaudeBundle({ sourceHome: home, workspace, output, history: 'gateway', force: true })
    } catch {
      failed = true
    }

    expect(failed).toBe(true)
    expect(readFileSync(join(output, 'keep.txt'), 'utf8')).toBe('working profile')
  })

  test('detects tampering before adaptation', async () => {
    const { root, home, workspace } = fixture()
    const output = join(root, 'nova.agent-bundle')
    await exportOpenClaudeBundle({ sourceHome: home, workspace, output, history: 'gateway' })
    writeFileSync(join(output, 'identity', 'MEMORY.md'), 'tampered')
    const verification = verifyBundle(output)
    expect(verification.ok).toBe(false)
    expect(verification.errors.some(error => error.includes('mismatch'))).toBe(true)
  })
})
