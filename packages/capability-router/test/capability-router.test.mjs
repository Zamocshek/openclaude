import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { CapabilityRouter } from '../src/core.mjs'
import { buildUi } from '../src/ui.mjs'

const fakeServer = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp.mjs')

test('web control center emits syntactically valid browser JavaScript', () => {
  const html = buildUi()
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new Function(script))
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'capability-router-'))
  mkdirSync(join(root, 'skills', 'code-review'), { recursive: true })
  writeFileSync(join(root, 'skills', 'code-review', 'SKILL.md'), [
    '---',
    'name: code-review',
    'description: Review code and verify repository changes',
    '---',
    '',
    '# Code review',
    'Inspect evidence before reporting findings.',
  ].join('\n'))
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      codegraph: { command: process.execPath, args: [fakeServer] },
    },
  }))
  writeFileSync(join(root, 'capability-registry.json'), JSON.stringify({
    schemaVersion: 1,
    skillRoots: ['skills'],
    servers: {
      codegraph: {
        description: 'Repository code symbols and dependency graph',
        tags: ['code', 'repository', 'symbols', '\u043a\u043e\u0434'],
        intents: ['inspect code', 'review implementation', '\u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u043a\u043e\u0434'],
      },
    },
  }))
  return root
}

test('routes lazily and exposes only the bounded relevant tool set', async t => {
  const root = fixture()
  const router = new CapabilityRouter({
    workspaceRoot: root,
    registryPath: join(root, 'capability-registry.json'),
    mcpConfigPath: join(root, '.mcp.json'),
    statePath: join(root, 'state', 'state.json'),
    maxTools: 1,
  })
  t.after(async () => {
    await router.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(router.snapshot().servers[0].connected, false)
  const route = await router.route('Inspect repository code symbols and review dependency impact', { maxTools: 1 })
  assert.deepEqual(route.selectedServers.map(server => server.name), ['codegraph'])
  assert.equal(route.tools.length, 1)
  assert.equal(route.tools[0].name, 'inspect_code')
  assert.equal(router.snapshot().servers[0].connected, true)
  assert.equal(route.skills[0].name, 'code-review')
  assert.deepEqual(route.skills[0].readWith, { tool: 'skill_store', action: 'read' })

  const russianRoute = await router.route('\u041f\u0440\u043e\u0432\u0435\u0440\u044c \u043a\u043e\u0434 \u0438 \u0441\u0438\u043c\u0432\u043e\u043b\u044b \u0440\u0435\u043f\u043e\u0437\u0438\u0442\u043e\u0440\u0438\u044f', { maxTools: 1 })
  assert.deepEqual(russianRoute.selectedServers.map(server => server.name), ['codegraph'])

  const result = await router.call('codegraph', 'inspect_code', { query: 'CapabilityRouter' })
  assert.match(result.content[0].text, /called:inspect_code/u)
})

test('deferred skill discovery keeps MCP startup cheap and loads skills on demand', async t => {
  const root = fixture()
  const router = new CapabilityRouter({
    workspaceRoot: root,
    registryPath: join(root, 'capability-registry.json'),
    mcpConfigPath: join(root, '.mcp.json'),
    statePath: join(root, 'state', 'state.json'),
    deferSkillDiscovery: true,
  })
  t.after(async () => {
    await router.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(router.snapshot().skillsLoaded, false)
  assert.deepEqual(router.snapshot().skills, [])
  assert.equal(router.listSkills()[0].name, 'code-review')
  assert.equal(router.snapshot().skillsLoaded, true)
})

test('shares concurrent MCP connection attempts', async t => {
  const root = fixture()
  const router = new CapabilityRouter({
    workspaceRoot: root,
    registryPath: join(root, 'capability-registry.json'),
    mcpConfigPath: join(root, '.mcp.json'),
    statePath: join(root, 'state', 'state.json'),
  })
  t.after(async () => {
    await router.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  const connections = await Promise.all(Array.from({ length: 12 }, () =>
    router.connect('codegraph')))
  assert.equal(new Set(connections).size, 1)
  assert.equal(router.snapshot().servers[0].connected, true)
})

test('distinguishes required and explicitly optional environment references', async t => {
  const root = fixture()
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      optional: {
        command: process.execPath,
        args: [fakeServer],
        env: { OPTIONAL_API_KEY: '${OPTIONAL_API_KEY:-}' },
      },
      required: {
        command: process.execPath,
        args: [fakeServer],
        env: { REQUIRED_API_KEY: '${REQUIRED_API_KEY}' },
      },
    },
  }))
  const router = new CapabilityRouter({
    workspaceRoot: root,
    registryPath: join(root, 'capability-registry.json'),
    mcpConfigPath: join(root, '.mcp.json'),
    statePath: join(root, 'state', 'state.json'),
    environment: {},
  })
  t.after(async () => {
    await router.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  const servers = new Map(router.snapshot().servers.map(server => [server.name, server]))
  assert.deepEqual(servers.get('optional').requiredEnvironment, [])
  assert.deepEqual(servers.get('required').requiredEnvironment, ['REQUIRED_API_KEY'])
  assert.equal((await router.listServerTools('optional')).length, 2)
  await assert.rejects(router.listServerTools('required'), /requires environment: REQUIRED_API_KEY/u)
})

test('keeps imported capabilities portable and scopes skills/files to their stores', async t => {
  const root = fixture()
  const router = new CapabilityRouter({
    workspaceRoot: root,
    registryPath: join(root, 'capability-registry.json'),
    mcpConfigPath: join(root, '.mcp.json'),
    statePath: join(root, 'state', 'state.json'),
  })
  t.after(async () => {
    await router.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  assert.throws(() => router.importMcp({
    mcpServers: { unsafe: { url: 'https://example.test/mcp', headers: { Authorization: 'literal-secret' } } },
  }), /environment reference/u)
  assert.throws(() => router.importMcp({
    mcpServers: {
      valid: { url: 'https://valid.example.test/mcp' },
      invalid: {
        url: 'https://invalid.example.test/mcp',
        headers: { Authorization: 'literal-secret' },
      },
    },
  }), /environment reference/u)
  assert.equal(router.snapshot().servers.some(server => server.name === 'valid'), false)
  assert.deepEqual(router.importMcp({
    mcpServers: { remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}' } } },
  }).imported, ['remote'])

  router.installSkill({ name: 'portable-plan', description: 'Plan complex tasks', instructions: 'Create and verify a concrete plan.' })
  assert.match(router.readSkill('portable-plan').instructions, /Create and verify/u)
  assert.throws(() => router.installSkill({
    name: 'invalid-skill',
    description: 'Invalid manifest override',
    instructions: 'Never installed.',
    files: { 'SKILL.md': 'override' },
  }), /cannot replace/u)
  router.setEnabled('skill', 'portable-plan', false)
  assert.throws(() => router.readSkill('portable-plan'), /disabled/u)

  router.writeFile('nested/result.txt', 'done')
  assert.equal(router.readFile('nested/result.txt').content, 'done')
  router.writeFile('nested/result.txt', 'updated')
  assert.equal(router.readFile('nested/result.txt').content, 'updated')
  assert.equal(existsSync(join(root, 'nested', 'result.txt')), true)
  assert.throws(() => router.readFile('../outside.txt'), /escapes workspace/u)
})

test('stdio MCP facade presents five stable tools instead of downstream schemas', async t => {
  const root = fixture()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(dirname(fakeServer), '..', '..', 'src', 'mcp.mjs')],
    env: {
      ...process.env,
      CAPABILITY_ROUTER_WORKSPACE_ROOT: root,
      CAPABILITY_ROUTER_MCP_CONFIG: join(root, '.mcp.json'),
      CAPABILITY_ROUTER_REGISTRY: join(root, 'capability-registry.json'),
      CAPABILITY_ROUTER_STATE: join(root, 'state', 'state.json'),
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'router-test', version: '1.0.0' }, { capabilities: {} })
  t.after(async () => {
    await client.close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), [
    'capability_route',
    'capability_call',
    'capability_registry',
    'skill_store',
    'workspace_files',
  ])
  const routed = await client.callTool({
    name: 'capability_route',
    arguments: { task: 'Inspect repository symbols', max_tools: 1 },
  })
  assert.match(routed.content[0].text, /inspect_code/u)
})

test('web control center exposes health, state, and authenticated Streamable HTTP MCP', async t => {
  const root = fixture()
  const port = 31_000 + Math.floor(Math.random() * 2_000)
  const apiKey = 'router-test-key'
  const child = spawn(process.execPath, [resolve(dirname(fakeServer), '..', '..', 'src', 'http.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      CAPABILITY_ROUTER_HOST: '127.0.0.1',
      CAPABILITY_ROUTER_PORT: String(port),
      CAPABILITY_ROUTER_API_KEY: apiKey,
      CAPABILITY_ROUTER_AUTO_SESSION: '1',
      CAPABILITY_ROUTER_SESSION_TTL_MS: '60000',
      CAPABILITY_ROUTER_WORKSPACE_ROOT: root,
      CAPABILITY_ROUTER_MCP_CONFIG: join(root, '.mcp.json'),
      CAPABILITY_ROUTER_REGISTRY: join(root, 'capability-registry.json'),
      CAPABILITY_ROUTER_STATE: join(root, 'state', 'state.json'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let client
  t.after(async () => {
    await client?.close().catch(() => {})
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolveExit => child.once('exit', resolveExit))
    }
    rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  let healthy = false
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`)
      healthy = response.ok
      if (healthy) break
    } catch {
      // Process startup is bounded by the loop below.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  assert.equal(healthy, true)
  assert.equal((await fetch(`${base}/favicon.ico`)).status, 204)
  assert.equal((await fetch(`${base}/api/state`)).status, 401)
  assert.equal((await fetch(`${base}/api/state?key=${apiKey}`)).status, 401)
  const consoleResponse = await fetch(base)
  assert.equal(consoleResponse.status, 200)
  assert.match(consoleResponse.headers.get('content-security-policy') || '', /frame-ancestors 'none'/u)
  const consoleCookie = (consoleResponse.headers.get('set-cookie') || '').split(';')[0]
  assert.match(consoleCookie, /^capability_router_session=/u)
  const consoleStateResponse = await fetch(`${base}/api/state`, {
    headers: { cookie: consoleCookie },
  })
  assert.equal(consoleStateResponse.status, 200)
  assert.equal((await consoleStateResponse.json()).servers.length, 1)
  const foreignHostStatus = await new Promise((resolveStatus, rejectRequest) => {
    const request = httpRequest(`${base}/api/state`, {
      headers: { cookie: consoleCookie, host: 'router.example' },
    }, response => {
      response.resume()
      resolveStatus(response.statusCode)
    })
    request.once('error', rejectRequest)
    request.end()
  })
  assert.equal(foreignHostStatus, 401)
  assert.equal((await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { cookie: consoleCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).status, 401)
  const stateResponse = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${apiKey}` } })
  assert.equal(stateResponse.status, 200)
  assert.equal((await stateResponse.json()).servers.length, 1)

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  })
  client = new Client({ name: 'router-http-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  assert.equal((await client.listTools()).tools.length, 5)
})
