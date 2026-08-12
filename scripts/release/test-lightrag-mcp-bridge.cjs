#!/usr/bin/env node

const { resolve } = require('node:path')

function textContent(result) {
  return (result.content || [])
    .filter(item => item.type === 'text')
    .map(item => item.text || '')
    .join('\n')
}

async function main() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/release/lightrag-mcp-bridge.cjs')],
    env: {
      ...process.env,
      LIGHTRAG_URL: process.env.LIGHTRAG_URL || 'http://127.0.0.1:9621',
      LIGHTRAG_MCP_TIMEOUT: process.env.LIGHTRAG_MCP_TIMEOUT || '180',
    },
    stderr: 'pipe',
  })
  let bridgeStderr = ''
  transport.stderr?.on('data', chunk => {
    bridgeStderr += String(chunk)
  })
  const client = new Client({ name: 'lightrag-bridge-smoke', version: '1.0.0' })

  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)
    for (const expected of [
      'lightrag_search',
      'lightrag_chat',
      'lightrag_ingest_text',
      'lightrag_ingest_file',
      'lightrag_track_status',
      'lightrag_list_documents',
      'lightrag_health',
    ]) {
      if (!names.includes(expected)) throw new Error(`Missing LightRAG MCP tool: ${expected}`)
    }

    const healthResult = await client.callTool({ name: 'lightrag_health', arguments: {} })
    const healthText = textContent(healthResult)
    if (healthResult.isError || !healthText.includes('"status": "healthy"')) {
      throw new Error(`Unexpected LightRAG health result: ${healthText}`)
    }

    const documentsResult = await client.callTool({ name: 'lightrag_list_documents', arguments: {} })
    const documentsText = textContent(documentsResult)
    if (documentsResult.isError || !documentsText.trim()) {
      throw new Error(`LightRAG document listing failed: ${documentsText}`)
    }

    let retrievalLength = 0
    const query = String(process.env.LIGHTRAG_SMOKE_QUERY || '').trim()
    if (query) {
      const retrieval = await client.callTool({
        name: 'lightrag_search',
        arguments: { query, mode: 'naive' },
      })
      const retrievalText = textContent(retrieval)
      if (retrieval.isError || !retrievalText.trim()) {
        throw new Error(`LightRAG retrieval failed: ${retrievalText}`)
      }
      retrievalLength = retrievalText.length
    }

    console.log(JSON.stringify({
      ok: true,
      tools: names.length,
      health: 'healthy',
      documentsPayloadBytes: Buffer.byteLength(documentsText),
      retrievalLength,
    }))
  } catch (error) {
    const detail = bridgeStderr.trim()
    throw new Error(`${error?.message || error}${detail ? `\nBridge stderr: ${detail}` : ''}`)
  } finally {
    await client.close().catch(() => {})
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || error)
  process.exit(1)
})
