import type { ControlProfileId } from "@/context/input"

export type DroppedSessionData = {
  id: string
  directory: string
  title?: string
  updatedAt?: number
}

export interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  hideAgentSelector?: boolean
}

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  kind?: "prompt" | "action"
}

export type AtOption = {
  type: "file"
  path: string
  display: string
}

export type PromptPopoverMode = "at" | "slash" | null

export type PermissionModeVisual = {
  id: ControlProfileId
  label: string
  shortLabel: string
  description: string
  icon: "shield-check" | "orbit" | "shield-alert"
  iconClass: string
}
