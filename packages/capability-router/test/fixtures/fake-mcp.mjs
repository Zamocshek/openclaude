#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fake-capability', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'inspect_code',
      description: 'Inspect repository symbols and dependency impact.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    {
      name: 'send_weather',
      description: 'Send an unrelated weather report.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async request => ({
  content: [{ type: 'text', text: `called:${request.params.name}:${JSON.stringify(request.params.arguments || {})}` }],
}))

await server.connect(new StdioServerTransport())
