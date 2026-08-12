import { describe, expect, test } from 'bun:test'

import { buildToolRouterHtml } from './routerUi.js'

describe('Tool Router UI', () => {
  test('ships Android device controls with parseable browser JavaScript', () => {
    const html = buildToolRouterHtml({
      toolRouter: 'http://localhost:8642/router',
      fileManager: 'http://localhost:8642/files',
      openWebUI: 'http://localhost:3000',
      hindsight: 'http://localhost:8888',
      lightRAG: 'http://localhost:9621/webui',
      telegramMcp: 'http://localhost:19765',
      omniRoute: 'http://localhost:20128',
    })

    expect(html).toContain('data-view="android"')
    expect(html).toContain('id="android-list"')
    expect(html).toContain("request('/api/android/devices')")
    expect(html).toContain('setAndroidState')
    expect(html).toContain('header { align-items:stretch; flex-direction:column;')
    expect(html).toContain('id="builtin-tool-list"')
    expect(html).toContain('data-toggle-builtin-tool')
    expect(html).toContain("tool:input.dataset.toggleBuiltinTool")
    expect(html).not.toContain('data-harness-mode=')
    expect(html).toContain('Ouroboros · evidence loop, acceptance, and recovery')
    expect(html).toContain('Always on')
    expect(html).not.toContain("request('/api/router/harness'")

    const script = html.match(/<script>([\s\S]+)<\/script>/u)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
  })
})
