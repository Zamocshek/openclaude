import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import migrationSkill from '../../../skills/agent-migration/SKILL.md'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerAgentMigrationSkill(): void {
  registerBundledSkill({
    name: 'agent-migration',
    aliases: ['migrate-agent', 'portable-agent'],
    description:
      'Export, verify, restore, or migrate NOVA identity, memory, history, skills, MCP servers, and workspace to OpenClaude, Hermes, OpenCode, OpenClaw, or Codex.',
    whenToUse:
      'Use when the user asks to move, clone, back up, restore, hand off, or continue this agent in another supported runtime.',
    argumentHint: '[export|verify|inspect|adapt] [options]',
    files: { 'SKILL.md': migrationSkill },
    getPromptForCommand: async (): Promise<ContentBlockParam[]> => [
      { type: 'text', text: migrationSkill },
    ],
  })
}
