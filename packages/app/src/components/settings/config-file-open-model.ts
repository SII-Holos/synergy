import type { DesktopServerStatus, Platform } from "@/context/platform"

type ErrorRecord = Record<string, unknown>

export type ConfigFileOpenFailure = {
  title: string
  description: string
}

function asRecord(value: unknown): ErrorRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  return value as ErrorRecord
}

function stringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value)
  const candidate = record?.[field]
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

export function canUseConfigFileOpen(platform: Platform, status: DesktopServerStatus | null | undefined): boolean {
  return (
    platform.platform === "desktop" &&
    !!platform.desktopServer &&
    status?.mode === "managed" &&
    status.state === "running"
  )
}

export function configFileOpenFailure(error: unknown, fallbackPath: string): ConfigFileOpenFailure {
  const message =
    stringField(error, "message") ??
    (error instanceof Error && error.message ? error.message : "The server could not open this config file.")
  const filepath = stringField(error, "path") ?? fallbackPath
  const separator = /[.!?]$/.test(message) ? " " : ". "
  const detail = message.includes(filepath) ? message : `${message}${separator}Config file: ${filepath}.`

  return {
    title: "Could not open config file",
    description: `${detail} Use Copy Path to open it manually.`,
  }
}
