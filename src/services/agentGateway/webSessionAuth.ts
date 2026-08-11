import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { IncomingMessage } from 'http'

export const WEB_SESSION_COOKIE_NAME = 'openclaude_ui_session'
const DEFAULT_WEB_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export type WebSessionPayload = {
  version: 1
  expiresAt: number
  csrfToken: string
}

export type IssuedWebSession = {
  token: string
  csrfToken: string
  expiresAt: number
}

export function issueWebSession(
  apiKey: string,
  options: { now?: number; ttlMs?: number } = {},
): IssuedWebSession {
  const now = options.now ?? Date.now()
  const payload: WebSessionPayload = {
    version: 1,
    expiresAt: now + normalizeWebSessionTtl(options.ttlMs),
    csrfToken: randomBytes(24).toString('base64url'),
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    token: `${encoded}.${signWebSession(encoded, apiKey)}`,
    csrfToken: payload.csrfToken,
    expiresAt: payload.expiresAt,
  }
}

export function verifyWebSessionToken(
  token: string | undefined,
  apiKey: string,
  now = Date.now(),
): WebSessionPayload | undefined {
  if (!token || !apiKey) return undefined
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) return undefined
  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  if (!constantTimeEqual(signature, signWebSession(encoded, apiKey))) return undefined

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<WebSessionPayload>
    if (
      payload.version !== 1 ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt! <= now ||
      typeof payload.csrfToken !== 'string' ||
      payload.csrfToken.length < 16
    ) {
      return undefined
    }
    return payload as WebSessionPayload
  } catch {
    return undefined
  }
}

export function webSessionFromRequest(
  request: Pick<IncomingMessage, 'headers'>,
  apiKey: string,
  now = Date.now(),
): WebSessionPayload | undefined {
  return verifyWebSessionToken(
    readCookie(request.headers.cookie, WEB_SESSION_COOKIE_NAME),
    apiKey,
    now,
  )
}

export function buildWebSessionCookie(
  token: string,
  options: { secure?: boolean; ttlMs?: number } = {},
): string {
  const maxAge = Math.floor(normalizeWebSessionTtl(options.ttlMs) / 1000)
  return [
    `${WEB_SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function clearWebSessionCookie(options: { secure?: boolean } = {}): string {
  return [
    `${WEB_SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function validateWebSessionMutation(
  request: Pick<IncomingMessage, 'method' | 'headers'>,
  session: WebSessionPayload,
): string | undefined {
  const method = String(request.method || 'GET').toUpperCase()
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return undefined

  const fetchSite = firstHeader(request.headers['sec-fetch-site'])
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) {
    return 'Cross-site UI request rejected'
  }
  const origin = firstHeader(request.headers.origin)
  const host = firstHeader(request.headers.host)
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return 'Cross-origin UI request rejected'
    } catch {
      return 'Invalid UI request origin'
    }
  }

  const csrfToken = firstHeader(request.headers['x-csrf-token'])
  if (!constantTimeEqual(csrfToken || '', session.csrfToken)) {
    return 'Invalid UI session CSRF token'
  }
  return undefined
}

export function isLoopbackWebRequest(
  request: Pick<IncomingMessage, 'headers'>,
): boolean {
  const host = firstHeader(request.headers.host)?.trim().toLowerCase()
  if (!host) return false
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.split(':', 1)[0]
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function isSecureWebRequest(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
): boolean {
  const forwarded = firstHeader(request.headers['x-forwarded-proto'])
    ?.split(',', 1)[0]
    ?.trim()
    .toLowerCase()
  return forwarded === 'https' || Boolean((request.socket as { encrypted?: boolean }).encrypted)
}

export function isWebSessionAutoAuthEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.OPENCLAUDE_CONSOLE_AUTO_SESSION || '').trim().toLowerCase(),
  )
}

export function constantTimeSecretEqual(left: string, right: string): boolean {
  return constantTimeEqual(left, right)
}

export function getWebSessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(
    String(env.OPENCLAUDE_CONSOLE_SESSION_TTL_MS || ''),
    10,
  )
  return normalizeWebSessionTtl(Number.isFinite(parsed) ? parsed : undefined)
}

function normalizeWebSessionTtl(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_WEB_SESSION_TTL_MS
  return Math.min(7 * 24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, value!))
}

function signWebSession(encodedPayload: string, apiKey: string): string {
  return createHmac('sha256', apiKey).update(encodedPayload).digest('base64url')
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || undefined
    }
  }
  return undefined
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
