import { describe, expect, test } from 'bun:test'

import { buildToolRouterHtml } from './routerUi.js'

describe('Tool Router UI', () => {
  test('ships Android device controls with parseable browser JavaScript', () => {
    const html = buildToolRouterHtml({
      toolRouter: 'http://localhost:8642/router',
      fileManager: 'http://localhost:8642/files',
      openWebUI: 'http://localhost:3000',
      hindsight: 'http://localhost:8888',
      openRAG: 'http://localhost:18000',
      telegramMcp: 'http://localhost:18765',
      omniRoute: 'http://localhost:20128',
    })

    expect(html).toContain('data-view="android"')
    expect(html).toContain('id="android-list"')
    expect(html).toContain("request('/api/android/devices')")
    expect(html).toContain('setAndroidState')

    const script = html.match(/<script>([\s\S]+)<\/script>/u)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
  })
})
