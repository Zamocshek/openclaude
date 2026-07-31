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

const require = createRequire(import.meta.url)
const {
  getBrowserModelProfile,
  listBrowserModelProfiles,
} = require('./browser-model-profiles.cjs')

const qwenProfile = getBrowserModelProfile('qwen')
export const QWEN_PROFILE = Object.freeze({
  ...qwenProfile,
  model: qwenProfile.defaultModel,
})

const POLL_INTERVAL_MS = 2_000
const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60_000

export function resolveAuthPaths(
  env = process.env,
  homeDir = os.homedir(),
  profile = QWEN_PROFILE,
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
    statusPath: path.join(authDir, `${profile.id}-status.json`),
    controlPath: path.join(authDir, `${profile.id}-control.json`),
    screenshotPath: path.join(
      authDir,
      `${profile.id}-authenticated.png`,
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

export function snapshotShowsModel(text, profile = QWEN_PROFILE) {
  const model = String(profile.defaultModel || profile.model || '').trim()
  return Boolean(
    model &&
      String(text || '').toLowerCase().includes(model.toLowerCase()),
  )
}

export function snapshotShowsQwenModel(text) {
  return snapshotShowsModel(text, QWEN_PROFILE)
}

export function isProfileUrl(value, profile = QWEN_PROFILE) {
  try {
    return (
      new URL(String(value)).hostname === new URL(profile.url).hostname
    )
  } catch {
    return false
  }
}

export function isQwenChatUrl(value) {
  return isProfileUrl(value, QWEN_PROFILE)
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

async function writeStatus(paths, profile, phase, extra = {}) {
  await writeJsonAtomic(paths.statusPath, {
    version: 1,
    profile: profile.id,
    userId: profile.userId,
    model: profile.defaultModel || '',
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

async function hasVisibleLoginControl(page) {
  const candidates = [
    page.getByRole('button', {
      name: /(log in|login|sign in|sign up|continue with)/i,
    }),
    page.getByRole('link', {
      name: /(log in|login|sign in|sign up)/i,
    }),
  ]
  for (const candidate of candidates) {
    if (
      await candidate
        .first()
        .isVisible({ timeout: 750 })
        .catch(() => false)
    ) {
      return true
    }
  }
  return false
}

async function hasVisibleComposer(page) {
  const candidates = [
    page.getByRole('textbox').first(),
    page.locator('textarea').first(),
    page.locator('[contenteditable="true"]').first(),
  ]
  for (const candidate of candidates) {
    if (
      await candidate.isVisible({ timeout: 750 }).catch(() => false)
    ) {
      return true
    }
  }
  return false
}

export async function isProfileAuthenticated(page, profile) {
  if (!isProfileUrl(page.url(), profile)) return false
  const [loginVisible, composerVisible] = await Promise.all([
    hasVisibleLoginControl(page),
    hasVisibleComposer(page),
  ])
  return composerVisible && !loginVisible
}

async function findAuthenticatedPage(context, profile) {
  const pages = context.pages()
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    if (
      await isProfileAuthenticated(pages[index], profile).catch(
        () => false,
      )
    ) {
      return pages[index]
    }
  }
  return null
}

async function selectPreferredModel(page, profile, diagnostics = {}) {
  const model = String(profile.defaultModel || '').trim()
  if (!model) {
    diagnostics.reason = 'no-default-model'
    return null
  }

  const modelPattern = new RegExp(
    model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    'i',
  )
  const selectorCandidates = [
    page.getByRole('button', { name: /select model/i }).first(),
    page.getByRole('button', { name: modelPattern }).first(),
  ]
  let selector = null
  for (const candidate of selectorCandidates) {
    if (
      await candidate.isVisible({ timeout: 1_500 }).catch(() => false)
    ) {
      selector = candidate
      break
    }
  }
  if (!selector) {
    diagnostics.reason = 'model-selector-not-visible'
    return false
  }

  const selectedText = String(
    await selector.textContent({ timeout: 1_000 }).catch(() => ''),
  )
    .trim()
    .slice(0, 160)
  diagnostics.initialLabel = selectedText
  if (snapshotShowsModel(selectedText, profile)) {
    diagnostics.reason = 'already-selected'
    return true
  }

  await selector.click()
  const candidates = [
    page.getByRole('option', { name: modelPattern }).first(),
    page.getByText(modelPattern, { exact: false }).first(),
  ]
  for (const candidate of candidates) {
    if (
      await candidate.isVisible({ timeout: 3_000 }).catch(() => false)
    ) {
      await candidate.click()
      diagnostics.reason = 'selected'
      return true
    }
  }
  diagnostics.reason = 'preferred-model-option-not-visible'
  return false
}

async function openBrowserContext(paths, profile, { headless }) {
  const runtime = await loadRuntime(paths)
  const storageStatePath = await runtime.loadPersistedStorageState(
    paths.profileDir,
    profile.userId,
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

async function persistAuthenticatedContext(
  paths,
  profile,
  runtime,
  context,
  page,
) {
  const modelSelection = {}
  const selectedModel = await selectPreferredModel(
    page,
    profile,
    modelSelection,
  ).catch(error => {
    modelSelection.reason =
      error instanceof Error ? error.message : String(error)
    return false
  })
  const persisted = await runtime.persistStorageState({
    profileDir: paths.profileDir,
    userId: profile.userId,
    context,
  })
  if (!persisted.persisted) {
    throw new Error(
      `Failed to persist ${profile.label} browser storage: ${persisted.reason || 'unknown error'}`,
    )
  }
  await page
    .screenshot({ path: paths.screenshotPath, fullPage: false })
    .catch(() => {})
  return {
    selectedModel,
    ...(!selectedModel && profile.defaultModel
      ? { modelSelection }
      : {}),
    ...summarizeStorageState(await context.storageState()),
  }
}

async function login(paths, profile) {
  const previous = await readJson(paths.statusPath)
  if (
    previous?.phase === 'awaiting-login' &&
    pidIsRunning(previous.pid)
  ) {
    console.log(
      JSON.stringify({
        ok: true,
        profile: profile.id,
        phase: previous.phase,
        pid: previous.pid,
        message: `A ${profile.label} login window is already running.`,
      }),
    )
    return
  }

  await mkdir(paths.authDir, { recursive: true })
  await writeStatus(paths, profile, 'launching', {
    startedAt: new Date().toISOString(),
  })

  let browser
  let context
  try {
    const opened = await openBrowserContext(paths, profile, {
      headless: false,
    })
    browser = opened.browser
    context = opened.context
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    await page.goto(profile.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await writeStatus(paths, profile, 'awaiting-login', {
      startedAt: previous?.startedAt || new Date().toISOString(),
      message:
        `Complete ${profile.label} login in the visible Camofox window. ` +
        'Credentials are never read by OpenClaude.',
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
        await writeStatus(paths, profile, 'cancelled')
        return
      }

      const authenticatedPage = await findAuthenticatedPage(
        context,
        profile,
      )
      authenticatedStreak = authenticatedPage
        ? authenticatedStreak + 1
        : 0

      if (control?.action === 'save' && !authenticatedPage) {
        await writeStatus(paths, profile, 'awaiting-login', {
          message:
            `${profile.label} still shows a login control or no chat composer. ` +
            'Finish login, then request save again.',
        })
      }

      if (
        authenticatedStreak >= 3 ||
        (control?.action === 'save' && authenticatedPage)
      ) {
        const summary = await persistAuthenticatedContext(
          paths,
          profile,
          opened.runtime,
          context,
          authenticatedPage,
        )
        await writeStatus(paths, profile, 'authenticated', {
          authenticated: true,
          finishedAt: new Date().toISOString(),
          persisted: true,
          ...summary,
        })
        console.log(
          JSON.stringify({
            ok: true,
            profile: profile.id,
            phase: 'authenticated',
            model: profile.defaultModel || '',
            ...summary,
          }),
        )
        return
      }

      await delay(POLL_INTERVAL_MS)
    }

    await writeStatus(paths, profile, 'timed-out', {
      authenticated: false,
      message:
        `Login window timed out without a verified ${profile.label} session.`,
    })
    process.exitCode = 1
  } catch (error) {
    await writeStatus(paths, profile, 'failed', {
      authenticated: false,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

async function verify(paths, profile) {
  let browser
  let context
  try {
    const opened = await openBrowserContext(paths, profile, {
      headless: true,
    })
    browser = opened.browser
    context = opened.context
    if (!opened.storageStatePath) {
      throw new Error(
        `No persisted ${profile.label} profile found. Start the interactive login first.`,
      )
    }
    const page = await context.newPage()
    await page.goto(profile.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    })
    await delay(5_000)
    const authenticatedPage = await findAuthenticatedPage(
      context,
      profile,
    )
    const authenticated = Boolean(authenticatedPage)
    const modelSelection = {}
    const selectedModel = authenticated
      ? await selectPreferredModel(
          authenticatedPage,
          profile,
          modelSelection,
        ).catch(error => {
          modelSelection.reason =
            error instanceof Error ? error.message : String(error)
          return false
        })
      : false
    if (authenticated) {
      await opened.runtime.persistStorageState({
        profileDir: paths.profileDir,
        userId: profile.userId,
        context,
      })
    }
    const result = {
      ok: authenticated,
      profile: profile.id,
      authenticated,
      selectedModel,
      model: profile.defaultModel || '',
      ...(!selectedModel && profile.defaultModel
        ? { modelSelection }
        : {}),
      ...summarizeStorageState(await context.storageState()),
    }
    await writeStatus(
      paths,
      profile,
      authenticated ? 'authenticated' : 'authentication-required',
      {
        authenticated,
        verifiedAt: new Date().toISOString(),
        ...(!selectedModel && profile.defaultModel
          ? { modelSelection }
          : {}),
      },
    )
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
  } finally {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }
}

async function requestControl(paths, profile, action) {
  const status = await readJson(paths.statusPath)
  if (
    !status ||
    status.phase !== 'awaiting-login' ||
    !pidIsRunning(status.pid)
  ) {
    throw new Error(
      `No active ${profile.label} login helper is waiting for input.`,
    )
  }
  await writeJsonAtomic(paths.controlPath, {
    action,
    requestedAt: new Date().toISOString(),
  })
  console.log(
    JSON.stringify({ ok: true, profile: profile.id, requested: action }),
  )
}

async function showStatus(paths, profile) {
  const status = await readJson(paths.statusPath)
  console.log(
    JSON.stringify(
      status || {
        version: 1,
        profile: profile.id,
        model: profile.defaultModel || '',
        phase: 'not-started',
      },
      null,
      2,
    ),
  )
}

function showProfiles() {
  console.log(
    JSON.stringify(
      {
        version: 1,
        profiles: listBrowserModelProfiles(),
        security:
          'The registry contains routing metadata only. Credentials and cookies remain outside the repository.',
      },
      null,
      2,
    ),
  )
}

async function main() {
  const action = process.argv[2] || 'status'
  if (action === 'list') {
    showProfiles()
    return
  }
  const profile = getBrowserModelProfile(process.argv[3] || 'qwen')
  const paths = resolveAuthPaths(process.env, os.homedir(), profile)
  if (action === 'login') await login(paths, profile)
  else if (action === 'status') await showStatus(paths, profile)
  else if (action === 'save') {
    await requestControl(paths, profile, 'save')
  } else if (action === 'cancel') {
    await requestControl(paths, profile, 'cancel')
  } else if (action === 'verify') await verify(paths, profile)
  else {
    throw new Error(
      'Usage: camofox-auth-profile.mjs list|login|status|save|cancel|verify [profile-id]',
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
