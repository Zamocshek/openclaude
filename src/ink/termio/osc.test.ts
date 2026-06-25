// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'

const originalEnv = { ...process.env }
const mockedClipboardPath = join(process.cwd(), 'openclaude-clipboard.txt')
let testEnv = { ...originalEnv }
let testPlatform: NodeJS.Platform = process.platform

const generateTempFilePathMock = mock(() => mockedClipboardPath)

const execFileNoThrowMock = mock(
  async () => ({ code: 0, stdout: '', stderr: '' }),
)

async function importFreshOscModule() {
  const module = await import(`./osc.ts?ts=${Date.now()}-${Math.random()}`)
  module._setClipboardTestOverrides({
    platform: testPlatform,
    env: testEnv,
    execFileNoThrow: execFileNoThrowMock,
    generateTempFilePath: generateTempFilePathMock,
  })
  return module
}

async function flushClipboardCopy(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitForExecCall(
  command: string,
  attempts = 20,
): Promise<(typeof execFileNoThrowMock.mock.calls)[number] | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const call = execFileNoThrowMock.mock.calls.find(([cmd]) => cmd === command)
    if (call) {
      return call
    }
    await flushClipboardCopy()
  }

  return undefined
}

describe('Windows clipboard fallback', () => {
  beforeEach(() => {
    execFileNoThrowMock.mockClear()
    generateTempFilePathMock.mockClear()
    testEnv = { ...originalEnv }
    delete testEnv['SSH_CONNECTION']
    delete testEnv['TMUX']
    testPlatform = 'win32'
  })

  afterEach(() => {
    testEnv = { ...originalEnv }
    testPlatform = process.platform
  })

  test('uses PowerShell instead of clip.exe for local Windows copy', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'clip')).toBe(
      false,
    )
    expect(
      execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'powershell'),
    ).toBe(true)
  })

  test('passes Windows clipboard text through a UTF-8 temp file instead of stdin', async () => {
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')
    await flushClipboardCopy()

    const windowsCall = await waitForExecCall('powershell')

    expect(windowsCall?.[2]).toMatchObject({
      stdin: 'ignore',
    })
    expect(windowsCall?.[2]).not.toMatchObject({ input: 'Привет мир' })
    expect(windowsCall?.[2]).not.toMatchObject({
      env: expect.objectContaining({
        OPENCLAUDE_CLIPBOARD_TEXT_B64: expect.any(String),
      }),
    })
    expect(windowsCall?.[1]).toContain(
      `$text = [System.IO.File]::ReadAllText('${mockedClipboardPath.replace(/'/g, "''")}', [System.Text.Encoding]::UTF8); Set-Clipboard -Value $text`,
    )
  })
})

describe('clipboard path behavior remains stable', () => {
  beforeEach(() => {
    execFileNoThrowMock.mockClear()
    testEnv = { ...originalEnv }
    delete testEnv['SSH_CONNECTION']
    delete testEnv['TMUX']
    testPlatform = process.platform
  })

  afterEach(() => {
    testEnv = { ...originalEnv }
    testPlatform = process.platform
  })

  test('getClipboardPath stays native on local macOS', async () => {
    testPlatform = 'darwin'
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('native')
  })

  test('getClipboardPath stays tmux-buffer when TMUX is set', async () => {
    testPlatform = 'linux'
    testEnv['TMUX'] = '/tmp/tmux-1000/default,123,0'
    const { getClipboardPath } = await importFreshOscModule()

    expect(getClipboardPath()).toBe('tmux-buffer')
  })

  test('Windows clipboard fallback is skipped over SSH', async () => {
    testPlatform = 'win32'
    testEnv['SSH_CONNECTION'] = '1 2 3 4'
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('Привет мир')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'powershell')).toBe(
      false,
    )
  })

  test('local macOS clipboard fallback still uses pbcopy', async () => {
    testPlatform = 'darwin'
    const { setClipboard } = await importFreshOscModule()

    await setClipboard('hello')

    expect(execFileNoThrowMock.mock.calls.some(([cmd]) => cmd === 'pbcopy')).toBe(
      true,
    )
  })
})
