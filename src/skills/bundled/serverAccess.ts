import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import serverAccessSkill from '../../../skills/server-access/SKILL.md'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerServerAccessSkill(): void {
  registerBundledSkill({
    name: 'server-access',
    aliases: ['vps', 'ssh-server'],
    description:
      'Maintain persistent SSH access to user-owned VPS/server profiles with bounded diagnostics, key-first authentication, and password-file bootstrap fallback.',
    whenToUse:
      'Use for VPS deployments, remote coding, service management, SSH failures, or any request to work on a user-owned server.',
    argumentHint: '[doctor|run|connect|bootstrap-key] [profile]',
    files: { 'SKILL.md': serverAccessSkill },
    getPromptForCommand: async (): Promise<ContentBlockParam[]> => [
      { type: 'text', text: serverAccessSkill },
    ],
  })
}
