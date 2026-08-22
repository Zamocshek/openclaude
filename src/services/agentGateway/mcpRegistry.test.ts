import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  importManagedMcpServers,
  listManagedMcpServers,
  parseMcpConfigImport,
  removeManagedMcpServer,
  resolveEffectiveMcpConfigPath,
  setManagedMcpServerEnabled,
  setManagedMcpServerGroupEnabled,
} from './mcpRegistry.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  delete process.env.CAPABILITY_ROUTER_STATE
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ))
})

async function makeProject(): Promise<{ project: string; state: string }> {
  const project = await mkdtemp(join(tmpdir(), 'openclaude-mcp-project-'))
  const state = await mkdtemp(join(tmpdir(), 'openclaude-mcp-state-'))
  temporaryPaths.push(project, state)
  process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
  process.env.CAPABILITY_ROUTER_STATE = join(state, 'capability-router.json')
  await writeFile(join(project, '.mcp.json'), JSON.stringify({
    mcpServers: {
      core: {
        command: 'node',
        args: ['core-server.js'],
        env: { CORE_TOKEN: '${CORE_TOKEN}' },
      },
    },
  }))
  return { project, state }
}

describe('agent gateway managed MCP registry', () => {
  test('accepts Telegram JSON and normalizes npx without a shell', () => {
    const parsed = parseMcpConfigImport(`
      \`\`\`json
      {
        "mcpServers": {
          "searxng": {
            "command": "npx",
            "args": ["-y", "mcp-searxng"],
            "env": { "SEARXNG_URL": "http://searxng:8080" }
          }
        }
      }
      \`\`\`
    `)

    expect(parsed?.ok).toBe(true)
    if (!parsed?.ok) return
    expect(parsed.normalizedNpxServers).toEqual(['searxng'])
    expect(parsed.config.mcpServers.searxng).toMatchObject({
      command: 'node',
      args: ['scripts/run-npx-mcp.cjs', '-y', 'mcp-searxng'],
    })
  })

  test('rejects unsupported fields and unsafe transport types', () => {
    expect(parseMcpConfigImport(JSON.stringify({
      mcpServers: { bad: { command: 'node', args: [], shell: true } },
    }))).toMatchObject({ ok: false })
    expect(parseMcpConfigImport(JSON.stringify({
      mcpServers: { bad: { type: 'sdk', name: 'internal' } },
    }))).toMatchObject({ ok: false })
  })

  test('merges runtime servers, disables base servers, and keeps secrets out of the project', async () => {
    const { project } = await makeProject()
    const imported = parseMcpConfigImport(JSON.stringify({
      mcpServers: {
        custom: {
          command: 'node',
          args: ['custom-server.js'],
          env: { PRIVATE_API_KEY: 'secret-value' },
        },
      },
    }))
    if (imported === undefined) throw new Error('parse failed')
    if (imported.ok === false) throw new Error(imported.error)

    await importManagedMcpServers(project, imported.config)
    let servers = await listManagedMcpServers(project)
    expect(servers.find(server => server.name === 'core')).toMatchObject({
      enabled: true,
      origin: 'base',
    })
    expect(servers.find(server => server.name === 'custom')).toMatchObject({
      enabled: true,
      origin: 'custom',
    })

    await setManagedMcpServerEnabled(project, 'core', false)
    const effectivePath = resolveEffectiveMcpConfigPath(project)
    expect(effectivePath).toBeTruthy()
    const effective = JSON.parse(await readFile(effectivePath!, 'utf8'))
    expect(effective.mcpServers.core).toBeUndefined()
    expect(effective.mcpServers.custom.env.PRIVATE_API_KEY).toBe('secret-value')
    expect(await readFile(join(project, '.mcp.json'), 'utf8')).not.toContain('secret-value')

    await setManagedMcpServerEnabled(project, 'core', true)
    await removeManagedMcpServer(project, 'custom')
    servers = await listManagedMcpServers(project)
    expect(servers.map(server => server.name)).toEqual(['core'])
    expect(JSON.parse(await readFile(resolveEffectiveMcpConfigPath(project)!, 'utf8'))
      .mcpServers.core).toBeTruthy()
  })

  test('toggles a capability server group atomically', async () => {
    const { project, state } = await makeProject()
    const parsed = parseMcpConfigImport(JSON.stringify({
      mcpServers: {
        vision: { command: 'node', args: ['vision.js'] },
      },
    }))
    if (!parsed || parsed.ok === false) {
      throw new Error(parsed?.ok === false ? parsed.error : 'parse failed')
    }
    await importManagedMcpServers(project, parsed.config)

    await setManagedMcpServerGroupEnabled(project, ['core', 'vision'], false)
    let servers = await listManagedMcpServers(project)
    expect(servers
      .filter(server => ['core', 'vision'].includes(server.name))
      .every(server => server.enabled === false)).toBe(true)
    expect(JSON.parse(await readFile(join(state, 'capability-router.json'), 'utf8')))
      .toMatchObject({
        disabledServers: ['core', 'vision'],
        mcpEnablementAuthority: 'capability-router',
      })

    await expect(setManagedMcpServerGroupEnabled(
      project,
      ['core', 'missing'],
      true,
    )).rejects.toThrow('MCP server not found: missing')
    servers = await listManagedMcpServers(project)
    expect(servers.find(server => server.name === 'core')?.enabled).toBe(false)

    await setManagedMcpServerGroupEnabled(project, ['core', 'vision'], true)
    servers = await listManagedMcpServers(project)
    expect(servers
      .filter(server => ['core', 'vision'].includes(server.name))
      .every(server => server.enabled === true)).toBe(true)
  })

  test('treats Capability Router server state as authoritative for execution', async () => {
    const { project, state } = await makeProject()
    const routerStatePath = join(state, 'capability-router.json')
    await writeFile(routerStatePath, JSON.stringify({
      schemaVersion: 2,
      revision: 1,
      disabledServers: ['core'],
      mcpEnablementAuthority: 'capability-router',
    }))

    expect((await listManagedMcpServers(project))[0]).toMatchObject({
      name: 'core',
      enabled: false,
    })
    let effective = JSON.parse(await readFile(resolveEffectiveMcpConfigPath(project)!, 'utf8'))
    expect(effective.mcpServers.core).toBeUndefined()

    await writeFile(routerStatePath, JSON.stringify({
      schemaVersion: 2,
      revision: 2,
      disabledServers: [],
      mcpEnablementAuthority: 'capability-router',
    }))
    effective = JSON.parse(await readFile(resolveEffectiveMcpConfigPath(project)!, 'utf8'))
    expect(effective.mcpServers.core).toBeTruthy()
  })
})
