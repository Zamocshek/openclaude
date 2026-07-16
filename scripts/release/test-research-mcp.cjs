#!/usr/bin/env node

const { resolve } = require('node:path')

const CALL_TIMEOUT_MS = 45_000

function textContent(result) {
  return (result.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text || '')
    .join('\n')
}

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), CALL_TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function connectProjectServer(name, entrypoint, env = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/run-project-mcp.cjs'), entrypoint],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: `${name}-smoke`, version: '0.1.0' })
  await withTimeout(client.connect(transport), `${name} connect`)
  return client
}

async function testSearxng() {
  const client = await connectProjectServer('searxng', 'mcp-searxng/dist/cli.js', {
    SEARXNG_URL: process.env.SEARXNG_URL || 'http://127.0.0.1:18088',
    SEARXNG_TIMEOUT_MS: '20000',
  })
  try {
    const tools = await withTimeout(client.listTools(), 'SearXNG listTools')
    const names = tools.tools.map(tool => tool.name)
    for (const expected of [
      'searxng_web_search',
      'searxng_search_suggestions',
      'searxng_instance_info',
      'web_url_read',
    ]) {
      if (!names.includes(expected)) throw new Error(`SearXNG MCP is missing ${expected}`)
    }

    const info = await withTimeout(client.callTool({
      name: 'searxng_instance_info',
      arguments: {},
    }), 'SearXNG instance info')
    if (info.isError || !textContent(info).trim()) {
      throw new Error(`SearXNG instance check failed: ${textContent(info)}`)
    }

    const search = await withTimeout(client.callTool({
      name: 'searxng_web_search',
      arguments: {
        query: 'Model Context Protocol official documentation',
        num_results: 3,
        response_format: 'json',
      },
    }), 'SearXNG web search')
    const searchText = textContent(search)
    if (search.isError || !searchText.includes('results')) {
      throw new Error(`SearXNG search failed: ${searchText}`)
    }
    console.log('SEARXNG_MCP_SMOKE_OK')
  } finally {
    await client.close().catch(() => {})
  }
}

async function testContext7() {
  const client = await connectProjectServer(
    'context7',
    '@upstash/context7-mcp/dist/index.js',
    process.env.CONTEXT7_API_KEY ? { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY } : {},
  )
  try {
    const tools = await withTimeout(client.listTools(), 'Context7 listTools')
    const names = tools.tools.map(tool => tool.name)
    for (const expected of ['resolve-library-id', 'query-docs']) {
      if (!names.includes(expected)) throw new Error(`Context7 MCP is missing ${expected}`)
    }

    const resolved = await withTimeout(client.callTool({
      name: 'resolve-library-id',
      arguments: {
        libraryName: 'Bun',
        query: 'Find current Bun test runner documentation.',
      },
    }), 'Context7 resolve-library-id')
    const resolvedText = textContent(resolved)
    const libraryId = resolvedText.match(/(?:Context7-compatible library ID|Library ID):\s*(\/[\w./-]+)/u)?.[1]
    if (resolved.isError || !libraryId) {
      throw new Error(`Context7 library resolution failed: ${resolvedText}`)
    }

    const docs = await withTimeout(client.callTool({
      name: 'query-docs',
      arguments: {
        libraryId,
        query: 'How do I define and run a basic test with the current Bun test runner?',
      },
    }), 'Context7 query-docs')
    const docsText = textContent(docs)
    if (docs.isError || docsText.length < 100) {
      throw new Error(`Context7 documentation query failed: ${docsText}`)
    }
    console.log(`CONTEXT7_MCP_SMOKE_OK ${libraryId}`)
  } finally {
    await client.close().catch(() => {})
  }
}

async function main() {
  await testSearxng()
  await testContext7()
}

main().catch(error => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
