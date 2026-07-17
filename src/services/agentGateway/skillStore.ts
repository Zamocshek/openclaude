import { createHash, randomUUID } from 'crypto'
import { rmSync } from 'node:fs'
import {
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const SKILL_IMPORT_MAX_CHARS = 72 * 1024
const SKILL_DESCRIPTION_MAX_CHARS = 2_000
const SKILL_INSTRUCTIONS_MAX_CHARS = 64 * 1024
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const SKILL_FIELDS = new Set(['name', 'description', 'instructions'])

export type SkillStoreErrorCode =
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'forbidden'

export type SkillCreateInput = {
  name: string
  description: string
  instructions: string
}

export type SkillStoreOptions = {
  skillsRoot?: string
}

export type SkillStoreItem = {
  id: string
  name: string
  label: string
  description: string
  origin: string
  managed: boolean
  skillRoot?: string
  contentLength?: number
}

export type SkillStoreItemDetails = SkillStoreItem & {
  instructions?: string
}

export type SkillStoreImportResult =
  | { ok: true; input: SkillCreateInput }
  | { ok: false; error: string }

export class SkillStoreError extends Error {
  constructor(
    readonly code: SkillStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SkillStoreError'
  }
}

let skillMutationTail: Promise<void> = Promise.resolve()
let bundledSkillInitializationAttempted = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  return (match?.[1] || trimmed).trim()
}

function assertOnlySkillFields(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).filter(key => !SKILL_FIELDS.has(key))
  if (unknown.length > 0) {
    throw new SkillStoreError(
      'invalid',
      `Skill contains unsupported fields: ${unknown.join(', ')}`,
    )
  }
}

function normalizeTextField(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SkillStoreError('invalid', `Skill ${field} must be a non-empty string`)
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim()
  if (normalized.length > maxChars) {
    throw new SkillStoreError(
      'invalid',
      `Skill ${field} exceeds ${maxChars} characters`,
    )
  }
  if (normalized.includes('\0')) {
    throw new SkillStoreError('invalid', `Skill ${field} contains a null byte`)
  }
  return normalized
}

export function normalizeSkillCreateInput(value: unknown): SkillCreateInput {
  if (!isRecord(value)) {
    throw new SkillStoreError('invalid', 'Skill definition must be an object')
  }
  assertOnlySkillFields(value)

  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!SKILL_NAME.test(name)) {
    throw new SkillStoreError(
      'invalid',
      'Skill name must use 1-64 lowercase letters, digits, or dashes',
    )
  }

  return {
    name,
    description: normalizeTextField(
      value.description,
      'description',
      SKILL_DESCRIPTION_MAX_CHARS,
    ),
    instructions: normalizeTextField(
      value.instructions,
      'instructions',
      SKILL_INSTRUCTIONS_MAX_CHARS,
    ),
  }
}

export function parseSkillStoreImport(
  text: string,
): SkillStoreImportResult | undefined {
  const jsonText = stripJsonFence(text)
  if (!jsonText.startsWith('{') || !/"skill"\s*:/u.test(jsonText)) {
    return undefined
  }
  if (jsonText.length > SKILL_IMPORT_MAX_CHARS) {
    return {
      ok: false,
      error: `Skill JSON exceeds ${SKILL_IMPORT_MAX_CHARS} characters`,
    }
  }

  try {
    const raw = JSON.parse(jsonText)
    if (!isRecord(raw)) {
      throw new SkillStoreError('invalid', 'Skill JSON root must be an object')
    }
    const rootKeys = Object.keys(raw)
    if (rootKeys.length !== 1 || rootKeys[0] !== 'skill') {
      throw new SkillStoreError(
        'invalid',
        'Skill JSON root must contain only the skill field',
      )
    }
    return { ok: true, input: normalizeSkillCreateInput(raw.skill) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function getManagedSkillsRoot(options: SkillStoreOptions = {}): string {
  return resolve(options.skillsRoot || join(getClaudeConfigHomeDir(), 'skills'))
}

export function getSkillStoreId(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12)
}

function isManagedSkillRoot(
  skillRoot: string | undefined,
  name: string,
  options: SkillStoreOptions,
): boolean {
  if (!skillRoot || !SKILL_NAME.test(name)) return false
  return resolve(skillRoot) === resolve(getManagedSkillsRoot(options), name)
}

function normalizeDescription(value: string | undefined): string {
  return (value || 'No description provided.').replace(/\s+/gu, ' ').trim()
}

async function getBundledSkillsForStore() {
  const bundledSkills = await import('../../skills/bundledSkills.js')
  if (!bundledSkillInitializationAttempted) {
    bundledSkillInitializationAttempted = true
    if (bundledSkills.getBundledSkills().length === 0) {
      const { initBundledSkills } = await import('../../skills/bundled/index.js')
      initBundledSkills()
    }
  }
  return bundledSkills.getBundledSkills()
}

async function getProjectSkillDirCommands(projectRoot: string) {
  const { getSkillDirCommands } = await import('../../skills/loadSkillsDir.js')
  return getSkillDirCommands(projectRoot)
}

async function clearLoadedSkillCaches(): Promise<void> {
  const { clearSkillCaches } = await import('../../skills/loadSkillsDir.js')
  clearSkillCaches()
}

function readStoreDescription(content: string): string {
  const raw = content.match(/^description:\s*(.+)$/mu)?.[1]?.trim()
  if (!raw) return 'No description provided.'
  try {
    return normalizeDescription(JSON.parse(raw))
  } catch {
    return normalizeDescription(raw.replace(/^['"]|['"]$/gu, ''))
  }
}

async function listExplicitStoreSkills(
  skillsRoot: string,
): Promise<SkillStoreItem[]> {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const skills = await Promise.all(entries
    .filter(entry => entry.isDirectory() && SKILL_NAME.test(entry.name))
    .map(async entry => {
      const skillRoot = join(skillsRoot, entry.name)
      try {
        const content = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
        return {
          id: getSkillStoreId(entry.name),
          name: entry.name,
          label: entry.name,
          description: readStoreDescription(content),
          origin: 'skills',
          managed: true,
          skillRoot,
          contentLength: content.length,
        } satisfies SkillStoreItem
      } catch {
        return undefined
      }
    }))
  return skills.filter((skill): skill is SkillStoreItem => Boolean(skill))
}

export async function listSkillStore(
  projectRoot: string,
  options: SkillStoreOptions = {},
): Promise<SkillStoreItem[]> {
  const commands = options.skillsRoot
    ? []
    : [
        ...await getBundledSkillsForStore(),
        ...await getProjectSkillDirCommands(resolve(projectRoot)),
      ]
  const byName = new Map<string, SkillStoreItem>()

  for (const command of commands) {
    if (command.type !== 'prompt') continue
    const managed = isManagedSkillRoot(command.skillRoot, command.name, options)
    const item: SkillStoreItem = {
      id: getSkillStoreId(command.name),
      name: command.name,
      label: typeof command.userFacingName === 'function'
        ? command.userFacingName()
        : command.name,
      description: normalizeDescription(command.description),
      origin: command.loadedFrom || String(command.source || 'unknown'),
      managed,
      ...(command.skillRoot ? { skillRoot: command.skillRoot } : {}),
      ...(command.contentLength === undefined
        ? {}
        : { contentLength: command.contentLength }),
    }
    const existing = byName.get(item.name)
    if (!existing || (item.managed && !existing.managed)) {
      byName.set(item.name, item)
    }
  }

  if (options.skillsRoot) {
    for (const skill of await listExplicitStoreSkills(
      getManagedSkillsRoot(options),
    )) {
      byName.set(skill.name, skill)
    }
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
}

export async function getSkillStoreItem(
  projectRoot: string,
  selector: string,
  options: SkillStoreOptions = {},
): Promise<SkillStoreItem | undefined> {
  const normalized = selector.trim()
  const skills = await listSkillStore(projectRoot, options)
  return skills.find(skill => skill.name === normalized || skill.id === normalized)
}

function stripSkillFrontmatter(content: string): string {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u, '')
    .trim()
}

export async function getSkillStoreItemDetails(
  projectRoot: string,
  selector: string,
  options: SkillStoreOptions = {},
): Promise<SkillStoreItemDetails | undefined> {
  const item = await getSkillStoreItem(projectRoot, selector, options)
  if (!item) return undefined
  if (!item.skillRoot) return item

  try {
    const content = await readFile(join(item.skillRoot, 'SKILL.md'), 'utf8')
    return {
      ...item,
      instructions: stripSkillFrontmatter(content).slice(
        0,
        SKILL_INSTRUCTIONS_MAX_CHARS,
      ),
    }
  } catch {
    return item
  }
}

function renderSkillFile(input: SkillCreateInput): string {
  return [
    '---',
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    '---',
    '',
    `# ${input.name}`,
    '',
    input.instructions,
    '',
  ].join('\n')
}

async function applyDockerSkillOwnership(
  skillRoot: string,
  skillPath: string,
): Promise<void> {
  if (
    process.platform === 'win32'
    || process.getuid?.() !== 0
    || !['1', 'true', 'yes', 'on'].includes(
      (process.env.OPENCLAUDE_DOCKER_RUN_AS_ROOT || '').toLowerCase(),
    )
  ) {
    return
  }
  await chown(skillRoot, 1000, 1000)
  await chown(skillPath, 1000, 1000)
}

async function withSkillMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = skillMutationTail
  let release!: () => void
  skillMutationTail = new Promise<void>(resolveLock => {
    release = resolveLock
  })
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
  }
}

export async function createManagedSkill(
  projectRoot: string,
  rawInput: unknown,
  options: SkillStoreOptions = {},
): Promise<SkillStoreItemDetails> {
  const input = normalizeSkillCreateInput(rawInput)
  return withSkillMutationLock(async () => {
    const skillsRoot = getManagedSkillsRoot(options)
    const skillRoot = join(skillsRoot, input.name)
    await mkdir(skillsRoot, { recursive: true })
    try {
      await mkdir(skillRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SkillStoreError('conflict', `Skill already exists: ${input.name}`)
      }
      throw error
    }

    const skillPath = join(skillRoot, 'SKILL.md')
    const temporary = join(skillRoot, `.SKILL.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, renderSkillFile(input), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporary, skillPath)
      await applyDockerSkillOwnership(skillRoot, skillPath)
    } catch (error) {
      try {
        rmSync(skillRoot, { recursive: true, force: true })
      } catch {
        // Preserve the original write error.
      }
      throw error
    }

    if (!options.skillsRoot) await clearLoadedSkillCaches()
    const created = await getSkillStoreItemDetails(
      projectRoot,
      input.name,
      options,
    )
    if (!created) {
      throw new SkillStoreError(
        'not_found',
        `Skill was written but did not load: ${input.name}`,
      )
    }
    return created
  })
}

export async function deleteManagedSkill(
  projectRoot: string,
  selector: string,
  options: SkillStoreOptions = {},
): Promise<SkillStoreItem[]> {
  return withSkillMutationLock(async () => {
    const item = await getSkillStoreItem(projectRoot, selector, options)
    if (!item) {
      throw new SkillStoreError('not_found', `Skill not found: ${selector}`)
    }
    if (!item.managed || !item.skillRoot) {
      throw new SkillStoreError(
        'forbidden',
        `Built-in, project, plugin, and MCP skills cannot be removed from the Store: ${item.name}`,
      )
    }

    const info = await lstat(item.skillRoot).catch(() => undefined)
    if (!info) {
      throw new SkillStoreError('not_found', `Skill directory not found: ${item.name}`)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new SkillStoreError('forbidden', `Unsafe skill directory: ${item.name}`)
    }

    rmSync(item.skillRoot, { recursive: true })
    if (!options.skillsRoot) await clearLoadedSkillCaches()
    return listSkillStore(projectRoot, options)
  })
}
