import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import { getAgentGatewayStateDir } from './config.js'

type StoredResponse = Record<string, unknown>
type ConversationIndex = Record<string, string>

function responseDir(): string {
  return join(getAgentGatewayStateDir(), 'api-responses')
}

function responsePath(responseId: string): string {
  if (!/^resp_[A-Za-z0-9]+$/u.test(responseId)) {
    throw new Error('Invalid response id')
  }
  return join(responseDir(), `${responseId}.json`)
}

function conversationIndexPath(): string {
  return join(responseDir(), 'conversations.json')
}

export async function loadStoredApiResponse(
  responseId: string,
): Promise<StoredResponse | undefined> {
  try {
    const parsed = JSON.parse(await readFile(responsePath(responseId), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function saveStoredApiResponse(
  responseId: string,
  payload: StoredResponse,
): Promise<void> {
  await writeJsonAtomic(responsePath(responseId), payload)
  const conversation = String(payload.conversation || '').trim()
  if (!conversation) return

  const index = await loadConversationIndex()
  index[conversation] = responseId
  await writeJsonAtomic(conversationIndexPath(), index)
}

export async function deleteStoredApiResponse(
  responseId: string,
): Promise<boolean> {
  const stored = await loadStoredApiResponse(responseId)
  if (!stored) return false
  await rm(responsePath(responseId), { force: true })

  const conversation = String(stored.conversation || '').trim()
  if (conversation) {
    const index = await loadConversationIndex()
    if (index[conversation] === responseId) {
      delete index[conversation]
      await writeJsonAtomic(conversationIndexPath(), index)
    }
  }
  return true
}

export async function loadLatestConversationResponseId(
  conversation: string,
): Promise<string> {
  const index = await loadConversationIndex()
  return index[conversation] || ''
}

async function loadConversationIndex(): Promise<ConversationIndex> {
  try {
    const parsed = JSON.parse(await readFile(conversationIndexPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
