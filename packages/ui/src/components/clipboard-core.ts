import { createMemo, createSignal, onCleanup } from "solid-js"
import type { IconName } from "./icon"

export type ClipboardWriteMethod = "desktop" | "navigator" | "execCommand"
export type ClipboardCopyResult =
  | { ok: true; method: ClipboardWriteMethod }
  | { ok: false; reason: "empty" | "unavailable" | "failed"; error?: unknown }

export type ClipboardWriter = (text: string) => boolean | void | Promise<boolean | void>

export type ClipboardCopyFailure = {
  text: string
  label?: string
  description?: string
  result: Exclude<ClipboardCopyResult, { ok: true }>
}

export type ClipboardEnvironment = {
  navigator?: Pick<Navigator, "clipboard">
  document?: Document
  isSecureContext?: boolean
}

export type ClipboardConfig = {
  writer?: ClipboardWriter
  onFailure?: (failure: ClipboardCopyFailure) => void
}

export type CopyTextOptions = {
  label?: string
  failureDescription?: string
  notifyFailure?: boolean
  writer?: ClipboardWriter
  environment?: ClipboardEnvironment
}

export type CopyState = "idle" | "copied" | "failed"

export type CopyTextSource = string | null | undefined | (() => string | null | undefined)

const defaultCopyResetDelay = 1600

let clipboardConfig: ClipboardConfig = {}

export function configureClipboard(config: ClipboardConfig) {
  const previous = clipboardConfig
  clipboardConfig = { ...config }
  return () => {
    clipboardConfig = previous
  }
}

function resolveText(source: CopyTextSource): string {
  const value = typeof source === "function" ? source() : source
  return value ?? ""
}

async function tryConfiguredWriter(writer: ClipboardWriter, text: string): Promise<boolean> {
  const result = await writer(text)
  return result !== false
}

function currentEnvironment(environment?: ClipboardEnvironment): ClipboardEnvironment {
  return {
    navigator: environment?.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined),
    document: environment?.document ?? (typeof document !== "undefined" ? document : undefined),
    isSecureContext: environment?.isSecureContext ?? (typeof window !== "undefined" ? window.isSecureContext : false),
  }
}

async function writeViaNavigator(text: string, environment: ClipboardEnvironment): Promise<boolean> {
  if (!environment.isSecureContext) return false
  const clipboard = environment.navigator?.clipboard
  if (!clipboard?.writeText) return false
  await clipboard.writeText(text)
  return true
}

function writeViaExecCommand(text: string, environment: ClipboardEnvironment): boolean {
  const doc = environment.document
  if (!doc?.body || typeof doc.execCommand !== "function") return false

  const textarea = doc.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  doc.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  try {
    return doc.execCommand("copy")
  } finally {
    doc.body.removeChild(textarea)
  }
}

function notifyFailure(text: string, options: CopyTextOptions, result: Exclude<ClipboardCopyResult, { ok: true }>) {
  if (options.notifyFailure === false) return
  if (result.reason === "empty") return
  clipboardConfig.onFailure?.({
    text,
    label: options.label,
    description: options.failureDescription,
    result,
  })
}

export async function copyTextToClipboard(text: string, options: CopyTextOptions = {}): Promise<ClipboardCopyResult> {
  if (!text) return { ok: false, reason: "empty" }

  const environment = currentEnvironment(options.environment)
  const errors: unknown[] = []
  const configuredWriter = options.writer ?? clipboardConfig.writer

  if (configuredWriter) {
    try {
      if (await tryConfiguredWriter(configuredWriter, text)) return { ok: true, method: "desktop" }
    } catch (error) {
      errors.push(error)
    }
  }

  try {
    if (await writeViaNavigator(text, environment)) return { ok: true, method: "navigator" }
  } catch (error) {
    errors.push(error)
  }

  try {
    if (writeViaExecCommand(text, environment)) return { ok: true, method: "execCommand" }
  } catch (error) {
    errors.push(error)
  }

  const result: ClipboardCopyResult = {
    ok: false,
    reason: errors.length > 0 ? "failed" : "unavailable",
    error: errors.at(-1),
  }
  notifyFailure(text, options, result)
  return result
}

export type CopyControllerOptions = {
  text: CopyTextSource
  copyLabel?: string
  copiedLabel?: string
  failedLabel?: string
  failureDescription?: string
  resetDelayMs?: number
  copyIcon?: IconName
  copiedIcon?: IconName
  failedIcon?: IconName
  onCopied?: (result: Extract<ClipboardCopyResult, { ok: true }>) => void
  onFailed?: (result: Exclude<ClipboardCopyResult, { ok: true }>) => void
}

export function createCopyController(options: CopyControllerOptions) {
  const [state, setState] = createSignal<CopyState>("idle")
  let resetTimer: ReturnType<typeof setTimeout> | undefined

  const text = createMemo(() => resolveText(options.text))
  const disabled = createMemo(() => text().length === 0)
  const copied = createMemo(() => state() === "copied")
  const failed = createMemo(() => state() === "failed")
  const tooltip = createMemo(() => {
    if (copied()) return options.copiedLabel ?? "Copied"
    if (failed()) return options.failedLabel ?? "Copy failed"
    return options.copyLabel ?? "Copy"
  })
  const icon = createMemo<IconName>(() => {
    if (copied()) return options.copiedIcon ?? "check"
    if (failed()) return options.failedIcon ?? "circle-x"
    return options.copyIcon ?? "copy"
  })

  function scheduleReset() {
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = setTimeout(() => setState("idle"), options.resetDelayMs ?? defaultCopyResetDelay)
  }

  async function copy(source?: CopyTextSource): Promise<ClipboardCopyResult> {
    const value = resolveText(source ?? options.text)
    const result = await copyTextToClipboard(value, {
      label: options.copyLabel,
      failureDescription: options.failureDescription,
    })

    if (result.ok) {
      setState("copied")
      options.onCopied?.(result)
    } else if (result.reason !== "empty") {
      setState("failed")
      options.onFailed?.(result)
    }

    if (result.ok || result.reason !== "empty") scheduleReset()
    return result
  }

  onCleanup(() => {
    if (resetTimer) clearTimeout(resetTimer)
  })

  return {
    state,
    text,
    disabled,
    copied,
    failed,
    tooltip,
    icon,
    copy,
  }
}
