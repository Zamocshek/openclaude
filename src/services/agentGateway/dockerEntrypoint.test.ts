import { describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'

describe('production Docker entrypoint', () => {
  test('runs MCP preflight from the image dependency tree', async () => {
    const script = await readFile(
      new URL('../../../scripts/docker-entrypoint.sh', import.meta.url),
      'utf8',
    )

    expect(script).toContain(
      'preflight_script="/app/scripts/release/check-base-mcp.cjs"',
    )
    expect(script).not.toContain(
      'preflight_script="$project_root/scripts/release/check-base-mcp.cjs"',
    )
  })
})
