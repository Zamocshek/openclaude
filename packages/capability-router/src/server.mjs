import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { resultText } from './core.mjs'

const tools = [
  {
    name: 'capability_route',
    description: 'Select the smallest useful set of MCP servers, tool schemas, and skills for a task. This is the first call for work that may need external capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete task or goal; do not reduce it to keywords.' },
        preferred: { type: 'array', items: { type: 'string' }, description: 'Optional exact server ids requested by the user.' },
        excluded: { type: 'array', items: { type: 'string' }, description: 'Optional server ids that must not be used.' },
        max_servers: { type: 'integer', minimum: 1, maximum: 12 },
        max_tools: { type: 'integer', minimum: 1, maximum: 100 },
        refresh: { type: 'boolean', description: 'Refresh downstream tool discovery instead of using the bounded cache.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'capability_call',
    description: 'Call one downstream tool selected by capability_route. The downstream MCP is connected lazily and disconnected/retried after transport failures.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['server', 'tool'],
      additionalProperties: false,
    },
  },
  {
    name: 'capability_registry',
    description: 'Inspect, import, export, enable, or disable portable MCP capabilities. Import accepts standard mcpServers JSON and stores credentials only as environment references.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'export', 'import', 'enable', 'disable', 'reload'] },
        kind: { type: 'string', enum: ['server', 'skill'] },
        name: { type: 'string' },
        config: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_store',
    description: 'List, read, install, enable, or disable self-contained Agent Skills. Read a selected skill before following its instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'install', 'enable', 'disable'] },
        name: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        files: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_files',
    description: 'Portable file-manager operations scoped to CAPABILITY_ROUTER_WORKSPACE_ROOT. Supports directory listing, text/base64 reads and writes, and explicit deletion.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write', 'delete'] },
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        recursive: { type: 'boolean' },
        max_bytes: { type: 'integer', minimum: 1, maximum: 268435456 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
]

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  }
}

export function createCapabilityMcpServer(router) {
  const server = new Server(
    {
      name: 'portable-capability-router',
      version: '1.0.0',
      description: 'Agent-neutral lazy MCP router, skill store, and workspace file manager',
    },
    { capabilities: { tools: { listChanged: true } } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.name
    const input = request.params.arguments || {}
    try {
      if (name === 'capability_route') {
        return resultText(await router.route(input.task, {
          preferred: input.preferred,
          excluded: input.excluded,
          maxServers: input.max_servers,
          maxTools: input.max_tools,
          refresh: input.refresh,
        }))
      }
      if (name === 'capability_call') {
        return await router.call(input.server, input.tool, input.arguments || {})
      }
      if (name === 'capability_registry') {
        if (input.action === 'list') {
          router.ensureSkillsLoaded()
          return resultText(router.snapshot())
        }
        if (input.action === 'export') return resultText(router.exportRegistry())
        if (input.action === 'import') return resultText(router.importMcp(input.config))
        if (input.action === 'reload') return resultText(router.reload())
        if (input.action === 'enable' || input.action === 'disable') {
          return resultText(router.setEnabled(input.kind || 'server', input.name, input.action === 'enable'))
        }
      }
      if (name === 'skill_store') {
        if (input.action === 'list') return resultText({ skills: router.listSkills() })
        if (input.action === 'read') return resultText(router.readSkill(input.name))
        if (input.action === 'install') return resultText(router.installSkill(input))
        if (input.action === 'enable' || input.action === 'disable') {
          return resultText(router.setEnabled('skill', input.name, input.action === 'enable'))
        }
      }
      if (name === 'workspace_files') {
        if (input.action === 'list') return resultText(router.listFiles(input.path || '.'))
        if (input.action === 'read') return resultText(router.readFile(input.path, { encoding: input.encoding, maxBytes: input.max_bytes }))
        if (input.action === 'write') return resultText(router.writeFile(input.path, input.content, { encoding: input.encoding }))
        if (input.action === 'delete') return resultText(router.deleteFile(input.path, input.recursive))
      }
      return errorResult(`Unsupported tool or action: ${name}`)
    } catch (error) {
      return errorResult(error)
    }
  })

  return server
}
