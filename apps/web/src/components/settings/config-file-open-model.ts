import type { MessageDescriptor } from "@lingui/core"
import type { DesktopServerStatus, Platform } from "@/context/platform"

type ErrorRecord = Record<string, unknown>

export type ConfigFileOpenFailure = {
  title: MessageDescriptor
  description: MessageDescriptor
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
  const message = stringField(error, "message") ?? (error instanceof Error && error.message ? error.message : undefined)
  const filepath = stringField(error, "path") ?? fallbackPath
  const title = { id: "settings.configFile.openFailed.title", message: "Could not open config file" }

  if (!message) {
    return {
      title,
      description: {
        id: "settings.configFile.openFailed.unknown",
        message:
          "The server could not open this config file. Config file: {filepath}. Use Copy Path to open it manually.",
        values: { filepath },
      },
    }
  }

  if (message.includes(filepath)) {
    return {
      title,
      description: {
        id: "settings.configFile.openFailed.withPath",
        message: "{error} Use Copy Path to open it manually.",
        values: { error: message },
      },
    }
  }

  return {
    title,
    description: {
      id: "settings.configFile.openFailed.withDetail",
      message: "{error} Config file: {filepath}. Use Copy Path to open it manually.",
      values: { error: message, filepath },
    },
  }
}
