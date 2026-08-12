import { describe, expect, test } from 'bun:test'
import { getDefaultAgentGatewayConfig } from './config.js'
import { getOpenWebUICommandPreview, getOpenWebUIUrl } from './openWebUI.js'

describe('Open WebUI helper', () => {
  test('builds local Open WebUI URL and agent API environment preview', () => {
    const config = getDefaultAgentGatewayConfig()
    config.api.enabled = true
    config.api.host = '127.0.0.1'
    config.api.port = 8642
    config.api.apiKey = 'ocag_test'

    const preview = getOpenWebUICommandPreview(config)

    expect(getOpenWebUIUrl(config)).toBe('http://localhost:8080')
    expect(preview.install).toContain('-m pip install open-webui')
    expect(preview.serve).toContain('WEBUI_AUTH')
    expect(preview.serve).toContain('OPENAI_API_BASE_URLS')
    expect(preview.serve).toContain('http://127.0.0.1:8642/v1')
    expect(preview.serve).toContain('ocag...test')
    expect(preview.serve).not.toContain('ocag_test')
    expect(preview.serve).toContain('AUDIO_STT_ENGINE')
    expect(preview.serve).toContain('WHISPER_MODEL')
    expect(preview.serve).toContain('WHISPER_VAD_FILTER')
    expect(preview.serve).toContain('FILE_IMAGE_COMPRESSION_WIDTH')
    expect(preview.serve).toContain('FILE_IMAGE_COMPRESSION_HEIGHT')
  })

  test('uses loopback for Open WebUI when the agent API binds all interfaces', () => {
    const config = getDefaultAgentGatewayConfig()
    config.api.enabled = true
    config.api.host = '0.0.0.0'
    config.api.port = 8642

    const preview = getOpenWebUICommandPreview(config)

    expect(preview.serve).toContain('http://127.0.0.1:8642/v1')
    expect(preview.serve).not.toContain('http://0.0.0.0:8642/v1')
  })
})
