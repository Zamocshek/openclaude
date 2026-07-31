#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const QWEN_PROFILE = Object.freeze({
  id: 'qwen',
  userId: 'nova-qwen-max',
  sessionKey: 'qwen-collaboration',
  url: 'https://chat.qwen.ai/',
  model: 'Qwen3.8-Max-Preview',
})

const POLL_INTERVAL_MS = 2_000
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60_000

export function resolveAuthPaths(
  env = process.env,
  homeDir = os.homedir(),
) {
  const camofoxRoot =
    env.OPENCLAUDE_CAMOFOX_HOME ||
    path.join(homeDir, '.openclaude', 'camofox-browser')
  const authDir =
    env.OPENCLAUDE_CAMOFOX_AUTH_DIR ||
    path.join(homeDir, '.openclaude', 'camofox-auth')
  const profileDir =
    env.CAMOFOX_PROFILE_DIR ||
    path.join(homeDir, '.camofox', 'profiles')
  return {
    camofoxRoot,
    packageDir: path.join(
      camofoxRoot,
      'node_modules',
      '@askjo',
      'camofox-browser',
    ),
    authDir,
    profileDir,
    statusPath: path.join(authDir, `${QWEN_PROFILE.id}-status.json`),
    controlPath: path.join(authDir, `${QWEN_PROFILE.id}-control.json`),
    screenshotPath: path.join(
      authDir,
      `${QWEN_PROFILE.id}-authenticated.png`,
    ),
  }
}

export function summarizeStorageState(storageState) {
  return {
    cookies: Array.isArray(storageState?.cookies)
      ? storageState.cookies.length
      : 0,
    origins: Array.isArray(storageState?.origins)
      ? storageState.origins.length
      : 0,
  }
}

export function snapshotShowsQwenModel(text) {
  return String(text || '')
    .toLowerCase()
    .includes(QWEN_PROFILE.model.toLowerCase())
}

export function isQwenChatUrl(value) {
  try {
    return new URL(String(value)).hostname === 'chat.qwen.ai'
  } catch {
    return false
  }
}

function hostOs() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tempPath, filePath)
}

async function writeStatus(paths, phase, extra = {}) {
  await writeJsonAtomic(paths.statusPath, {
    version: 1,
    profile: QWEN_PROFILE.id,
    userId: QWEN_PROFILE.userId,
    model: QWEN_PROFILE.model,
    phase,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra,
  })
}

async function consumeControl(paths) {
  const control = await readJson(paths.controlPath)
  if (!control) return null
  await unlink(paths.controlPath).catch(() => {})
  return control
}

function pidIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function loadRuntime(paths) {
  const packageJson = path.join(paths.packageDir, 'package.json')
  if (!existsSync(packageJson)) {
    throw new Error(
      `Camofox is not installed at ${paths.packageDir}. Run release:camofox:install first.`,
    )
  }

  const runtimeRequire = createRequire(packageJson)
  const [{ Camoufox }, persistence] = await Promise.all([
    import(pathToFileURL(runtimeRequire.resolve('camoufox-js')).href),
    import(
      pathToFileURL(
        path.join(paths.packageDir, 'lib', 'persistence.js'),
      ).href
    ),
  ])
  return {
    Camoufox,
    ...persistence,
  }
}

async function isQwenAuthenticated(page) {
  if (!isQwenChatUrl(page.url())) return false
  const loginVisible = await page
    .getByRole('button', { name: /(log in|sign in|sign up)/i })
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  const composerVisible = await page
    .getByRole('textbox')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  const modelSelectorVisible = await page
    .getByRole('button', { name: /select model/i })
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false)
  return composerVisible && modelSelectorVisible && !loginVisible
}

async function findAuthenticatedQwenPage(context) {
  const pages = context.pages()
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (await isQwenAuthenticated(pages[index]).catch(() => false)) {
      return pages[index]
    }
  }
  return null
}

async function selectRequiredModel(page) {
  const selector = page
    .getByRole('button', { name: /select model/i })
    .first()
  if (
    !(await selector.isVisible({ timeout: 3_000 }).catch(() => false))
  ) {
    return false
  }
  await selector.click()
  const option = page
    .getByRole('option', {
      name: new RegExp(QWEN_PROFILE.model.replaceAll('.', '\\.'), 'i'),
    })
    .first()
  if (!(await option.isVisible({ timeout: 5_000 }).catch(() => false))) {
    return false
  }
  await option.click()
  return true
}

async function openBrowserContext(paths, { headless }) {
  const runtime = await loadRuntime(paths)
  const storageStatePath = await runtime.loadPersistedStorageState(
    paths.profileDir,
    QWEN_PROFILE.userId,
  )
  const browser = await runtime.Camoufox({
    headless,
    os: hostOs(),
    humanize: true,
    enable_cache: true,
  })
  const context = await browser.newContext(
    storageStatePath ? { storageState: storageStatePath } : {},
  )
  return {
    runtime,
    browser,
    context,
    storageStatePath,
  }
}

async function persistAuthenticatedContext(paths, runtime, context, page) {
  const selectedModel = await selectRequiredModel(page).catch(() => false)
  if (!selectedModel) {
    throw new Error(
      `Authenticated Qwen page did not expose the required ${QWEN_PROFILE.model} model.`,
    )
  }
  await delay(1_000)
  const persisted = await runtime.persistStorageState({
    profileDir: paths.profileDir,
    userId: QWEN_PROFILE.userId,
    context,
  })
  if (!persisted.persisted) {
    throw new Error(
      `Failed to persist Qwen storage state: ${persisted.reason || 'unknown error'}`,
    )
  }
  await page
    .screenshot({ path: paths.screenshotPath, fullPage: false })
    .catch(() => {})
  return {
    selectedModel,
    ...summarizeStorageState(await context.storageState()),
  }
}

async function login(paths) {
  const previous = await readJson(paths.statusPath)
  if (
    previous?.phase === 'awaiting-login' &&
    pidIsRunning(previous.pid)
  ) {
    console.log(
      JSON.stringify({
        ok: true,
        phase: previous.phase,
        pid: previous.pid,
        message: 'A Qwen login window is already running.',
      }),
    )
    return
  }

  await mkdir(paths.authDir, { recursive: true })
  await writeStatus(paths, 'launching', {
    startedAt: new Date().toISOString(),
  })

  let browser
  let context
  try {
    const opened = await openBrowserContext(paths, { headless: false })
    browser = opened.browser
    context = opened.context
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    await page.goto(QWEN_PROFILE.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await writeStatus(paths, 'awaiting-login', {
      startedAt: previous?.startedAt || new Date().toISOString(),
      message:
        'Complete Qwen login in the visible Camoufox window. Credentials are never read by OpenClaude.',
    })

    const timeoutMs = Math.max(
      60_000,
      Number(
        process.env.OPENCLAUDE_CAMOFOX_LOGIN_TIMEOUT_MS ||
          DEFAULT_LOGIN_TIMEOUT_MS,
      ),
    )
    const deadline = Date.now() + timeoutMs
    let authenticatedStreak = 0

    while (Date.now() < deadline) {
      const control = await consumeControl(paths)
      if (control?.action === 'cancel') {
        await writeStatus(paths, 'cancelled')
        return
      }

      const authenticatedPage = await findAuthenticatedQwenPage(context)
      authenticatedStreak = authenticatedPage
        ? authenticatedStreak + 1
        : 0

      if (control?.action === 'save' && !authenticatedPage) {
        await writeStatus(paths, 'awaiting-login', {
          message:
            'Qwen still shows a login control. Finish login, then request save again.',
        })
      }

      if (
        authenticatedStreak >= 3 ||
        (control?.action === 'save' && authenticatedPage)
      ) {
        const summary = await persistAuthenticatedContext(
          paths,
          opened.runtime,
          context,
          authenticatedPage,
        )
        await writeStatus(paths, 'authenticated', {
          finishedAt: new Date().toISOString(),
          persisted: true,
          ...summary,
        })
        console.log(
          JSON.stringify({
            ok: true,
            phase: 'authenticated',
            model: QWEN_PROFILE.model,
            ...summary,
          }),
        )
        return
      }

      await delay(POLL_INTERVAL_MS)
    }

    await writeStatus(paths, 'timed-out', {
      message: 'Login window timed out without a verified Qwen session.',
    })
    process.exitCode = 1
  } catch (error) {
    await writeStatus(paths, 'failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

async function verify(paths) {
  let browser
  let context
  try {
    const opened = await openBrowserContext(paths, { headless: true })
    browser = opened.browser
    context = opened.context
    if (!opened.storageStatePath) {
      throw new Error(
        'No persisted Qwen profile found. Start the interactive login first.',
      )
    }
    const page = await context.newPage()
    await page.goto(QWEN_PROFILE.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await delay(5_000)
    const authenticatedPage = await findAuthenticatedQwenPage(context)
    const authenticated = Boolean(authenticatedPage)
    const selectedModel = authenticated
      ? await selectRequiredModel(authenticatedPage).catch(() => false)
      : false
    if (authenticated) {
      await opened.runtime.persistStorageState({
        profileDir: paths.profileDir,
        userId: QWEN_PROFILE.userId,
        context,
      })
    }
    const result = {
      ok: authenticated && selectedModel,
      authenticated,
      selectedModel,
      model: QWEN_PROFILE.model,
      ...summarizeStorageState(await context.storageState()),
    }
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

async function requestControl(paths, action) {
  const status = await readJson(paths.statusPath)
  if (
    !status ||
    status.phase !== 'awaiting-login' ||
    !pidIsRunning(status.pid)
  ) {
    throw new Error('No active Qwen login helper is waiting for input.')
  }
  await writeJsonAtomic(paths.controlPath, {
    action,
    requestedAt: new Date().toISOString(),
  })
  console.log(JSON.stringify({ ok: true, requested: action }))
}

async function showStatus(paths) {
  const status = await readJson(paths.statusPath)
  console.log(
    JSON.stringify(
      status || {
        version: 1,
        profile: QWEN_PROFILE.id,
        phase: 'not-started',
      },
      null,
      2,
    ),
  )
}

async function main() {
  const action = process.argv[2] || 'status'
  const paths = resolveAuthPaths()
  if (action === 'login') await login(paths)
  else if (action === 'status') await showStatus(paths)
  else if (action === 'save') await requestControl(paths, 'save')
  else if (action === 'cancel') await requestControl(paths, 'cancel')
  else if (action === 'verify') await verify(paths)
  else {
    throw new Error(
      'Usage: camofox-auth-profile.mjs login|status|save|cancel|verify',
    )
  }
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
