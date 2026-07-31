import { registerBundledSkill } from '../bundledSkills.js'

function buildAndroidDevicePrompt(task: string): string {
  return `# Android Device Operations

Use Android-MCP and the Gateway Android registry to operate authorized Android
devices. Treat every device alias and screen as a distinct execution target.

## Routing

1. Call \`android_list_devices\` with \`discover=false\` to resolve saved aliases.
   Use \`discover=true\` only when the user asks to find currently connected
   devices. Gateway discovery runs plain \`adb devices -l\` without attaching to
   mDNS peers.
2. Prefer the pinned MCP server named \`android-<alias>\` for a saved profile.
   It runs an isolated Android-MCP process fixed to that serial. A generic base
   server is intentionally not started because upstream Android-MCP exits when
   no device is attached.
3. A profile registered during the current run becomes a pinned MCP server on
   the next run. Finish registration, then continue device UI work in a new
   agent run so the new MCP namespace is loaded.
4. Never use two MCP namespaces for the same physical serial in parallel.
   Independent aliases may be operated in parallel only when they resolve to
   different serials and the user requested independent work.

## Device workflow

1. Resolve the alias and serial before any UI action. If the requested target is
   ambiguous, list profiles and report the ambiguity instead of auto-selecting.
2. Call \`android_connect_device\` or \`android_check_device\` for ADB state and
   basic device identity. An \`unauthorized\` device requires the user to accept
   the USB debugging prompt on that device.
3. Call Android-MCP \`Snapshot\` before acting. Prefer
   \`ClickBySelector\` and \`WaitForElement\`; use coordinate clicks only when
   selectors are unavailable. Snapshot again after each state-changing action.
4. Keep tool calls bounded. After two identical connection or selector
   failures, stop retrying and return the exact state/error with a concrete
   recovery step.
5. Do not read notifications, messages, account data, or unrelated apps unless
   the user explicitly requested that scope. Never echo authentication codes,
   passwords, or private screen content into logs or durable memory.
6. Pairing codes are short-lived: pass them only to
   \`android_pair_device\`; they must never be retained.
7. For WiFi devices, prefer a saved host:port profile. For Docker on Windows,
   direct WiFi ADB works; USB requires a reachable host ADB server or running
   the Gateway locally with platform-tools.

## Current task

${task || 'Inspect the Android device registry and ask what device operation to perform.'}
`
}

export function registerAndroidDeviceSkill(): void {
  registerBundledSkill({
    name: 'android-device',
    aliases: ['android-agent', 'mobile-android'],
    description:
      'Manage and operate one or more authorized Android devices through saved aliases, ADB diagnostics, and pinned Android-MCP tool servers.',
    whenToUse:
      'Use for Android phones, tablets, emulators, ADB pairing/connection, mobile app navigation, UI automation, screenshots, or Android QA tasks.',
    argumentHint: '[device alias and task]',
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{
        type: 'text',
        text: buildAndroidDevicePrompt(args.trim()),
      }]
    },
  })
}
