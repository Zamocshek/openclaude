import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { prepareGatewayControlMcpConfig } from './gatewayControlMcp.js'

const temporaryPaths: string[] = []
let mockGateway: ReturnType<typeof Bun.serve> | undefined

afterEach(async () => {
  mockGateway?.stop(true)
  mockGateway = undefined
  delete process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true })
  ))
})

describe('gateway control MCP configuration', () => {
  test('merges a private gateway-control MCP server into the effective config', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-gateway-control-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-gateway-control-state-'))
    temporaryPaths.push(project, state)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: { existing: { command: 'node', args: ['existing.mjs'] } },
    }))

    const generatedPath = prepareGatewayControlMcpConfig(project)
    expect(generatedPath).toBe(join(state, 'gateway-control.mcp.json'))
    const generated = JSON.parse(await readFile(generatedPath!, 'utf8'))
    expect(generated.mcpServers.existing).toBeTruthy()
    expect(generated.mcpServers['gateway-control']).toMatchObject({
      command: process.execPath,
      env: {
        OPENCLAUDE_AGENT_GATEWAY_STATE_DIR: state,
      },
    })
    expect(JSON.stringify(generated)).not.toContain('DEEPSEEK_API_KEY')
  })

  test('builds a strict pentest MCP profile without unrelated or control servers', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-pentest-mcp-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-pentest-mcp-state-'))
    temporaryPaths.push(project, state)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        pentest: { command: 'node', args: ['scripts/pentest-mcp.cjs'] },
        codegraph: { command: 'node', args: ['codegraph.mjs'] },
        context7: { command: 'node', args: ['context7.mjs'] },
        camofox: { url: 'http://camofox:9377/mcp' },
      },
    }))

    const generatedPath = prepareGatewayControlMcpConfig(project, 'pentest')
    expect(generatedPath).toBe(join(state, 'gateway-pentest.mcp.json'))
    const generated = JSON.parse(await readFile(generatedPath!, 'utf8'))
    expect(Object.keys(generated.mcpServers).sort()).toEqual([
      'codegraph',
      'pentest',
    ])
    expect(generated.mcpServers['gateway-control']).toBeUndefined()
    expect(generated.mcpServers.camofox).toBeUndefined()
    expect(generated.mcpServers.context7).toBeUndefined()
  })

  test('builds an empty MCP profile when model tools are disabled', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-disabled-mcp-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-disabled-mcp-state-'))
    temporaryPaths.push(project, state)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        codegraph: { command: 'node', args: ['codegraph.mjs'] },
        context7: { command: 'node', args: ['context7.mjs'] },
      },
    }))

    const generatedPath = prepareGatewayControlMcpConfig(project, 'disabled')
    expect(generatedPath).toBe(join(state, 'gateway-tools-disabled.mcp.json'))
    const generated = JSON.parse(await readFile(generatedPath!, 'utf8'))
    expect(generated.mcpServers).toEqual({})
  })

  test('builds a task-scoped MCP profile from enabled servers only', async () => {
    const project = await mkdtemp(join(tmpdir(), 'openclaude-task-mcp-project-'))
    const state = await mkdtemp(join(tmpdir(), 'openclaude-task-mcp-state-'))
    temporaryPaths.push(project, state)
    process.env.OPENCLAUDE_AGENT_GATEWAY_STATE_DIR = state
    await writeFile(join(project, '.mcp.json'), JSON.stringify({
      mcpServers: {
        codegraph: { command: 'node', args: ['codegraph.mjs'] },
        camofox: { command: 'node', args: ['camofox.mjs'] },
        hindsight: { command: 'node', args: ['hindsight.mjs'] },
      },
    }))
    const outputPath = join(state, 'runs', 'task.mcp.json')

    const generatedPath = prepareGatewayControlMcpConfig(
      project,
      'default',
      {
        includeServers: new Set(['codegraph']),
        outputPath,
      },
    )
    const generated = JSON.parse(await readFile(generatedPath!, 'utf8'))

    expect(generatedPath).toBe(outputPath)
    expect(Object.keys(generated.mcpServers)).toEqual(['codegraph'])
  })

  test('exposes Android tools and calls the authenticated Gateway API', async () => {
    const requests: Array<{ path: string; authorization: string | null }> = []
    mockGateway = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          path: url.pathname,
          authorization: request.headers.get('authorization'),
        })
        return Response.json({
          data: { active_alias: null, profiles: [] },
        })
      },
    })

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('scripts/gateway-control-mcp.mjs')],
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAUDE_AGENT_GATEWAY_URL:
          `http://127.0.0.1:${mockGateway.port}`,
        OPENCLAUDE_AGENT_API_KEY: 'android-test-secret',
      } as Record<string, string>,
      stderr: 'pipe',
    })
    const client = new Client({
      name: 'gateway-control-android-test',
      version: '1.0.0',
    })

    try {
      await client.connect(transport)
      const tools = await client.listTools()
      expect(tools.tools.map(tool => tool.name)).toContain(
        'android_register_device',
      )
      expect(tools.tools.map(tool => tool.name)).toContain(
        'android_check_device',
      )
      const configureTool = tools.tools.find(
        tool => tool.name === 'configure_subagent_route',
      )
      const configureSchema = configureTool?.inputSchema as {
        properties?: { role?: { description?: string } }
      }
      expect(configureSchema.properties?.role?.description).toContain(
        'gateway-vision',
      )

      const result = await client.callTool({
        name: 'android_list_devices',
        arguments: { discover: false },
      })
      expect(result.isError).not.toBe(true)
      expect(result.content).toEqual([{
        type: 'text',
        text: JSON.stringify({
          data: { active_alias: null, profiles: [] },
        }),
      }])
      expect(requests).toEqual([{
        path: '/api/android/devices',
        authorization: 'Bearer android-test-secret',
      }])
    } finally {
      await client.close()
    }
  })
})
