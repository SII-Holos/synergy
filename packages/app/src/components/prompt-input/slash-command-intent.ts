import { PI } from "./prompt-input-i18n"

export type SlashBackendCommand = {
  name: string
  kind?: "prompt" | "action"
  description?: string
}

export type SlashUiCommand = {
  id: string
  title: string
  slash?: string
  disabled?: boolean
}

export type SlashCommandIntent =
  | { kind: "none" }
  | { kind: "backend-prompt"; command: string; arguments: string; label: string }
  | { kind: "backend-action"; command: string; arguments: string; label: string }
  | { kind: "ui"; command: string; label: string }

export type PendingLightLoopSlashBlock = {
  title: string
  description: string
}

function parseSlashInvocation(text: string): { command: string; arguments: string } | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("/")) return undefined

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match?.[1]) return undefined
  return {
    command: match[1],
    arguments: match[2] ?? "",
  }
}

export function resolveSlashCommandIntent(input: {
  text: string
  backendCommands: SlashBackendCommand[]
  uiCommands: SlashUiCommand[]
}): SlashCommandIntent {
  const invocation = parseSlashInvocation(input.text)
  if (!invocation) return { kind: "none" }

  const backendCommand = input.backendCommands.find((command) => command.name === invocation.command)
  if (backendCommand) {
    return {
      kind: backendCommand.kind === "action" ? "backend-action" : "backend-prompt",
      command: backendCommand.name,
      arguments: invocation.arguments,
      label: backendCommand.name,
    }
  }

  const uiCommand = input.uiCommands.find(
    (command) => !command.disabled && !command.id.startsWith("suggested.") && command.slash === invocation.command,
  )
  if (uiCommand) {
    return {
      kind: "ui",
      command: invocation.command,
      label: uiCommand.title,
    }
  }

  return { kind: "none" }
}

export function getPendingLightLoopSlashBlock(intent: SlashCommandIntent): PendingLightLoopSlashBlock | undefined {
  if (intent.kind === "backend-action") {
    return {
      title: PI.slashUseTask.message,
      description: PI.slashNoAction.message,
    }
  }
  if (intent.kind === "ui") {
    return {
      title: PI.slashUseTask.message,
      description: PI.slashNoUi.message,
    }
  }
  return undefined
}
