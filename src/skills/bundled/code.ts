import { registerBundledSkill } from '../bundledSkills.js'

import { CODE_SKILL_PROMPT } from '../codingWorkflow.js'

export function registerCodeSkill(): void {
  registerBundledSkill({
    name: 'code',
    description:
      'Use for implementation, bug fixes, refactoring, code review, scripts, repository changes, or deployment work that requires production-quality code and verification.',
    argumentHint: '[task or additional constraints]',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{
        type: 'text',
        text: args
          ? `${CODE_SKILL_PROMPT}\n\n## Task-specific constraints\n\n${args}`
          : CODE_SKILL_PROMPT,
      }]
    },
  })
}
