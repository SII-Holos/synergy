import type { ConfigInstructionsInfo } from "@ericsanchezok/synergy-sdk/client"
import { createSignal } from "solid-js"

export type CustomInstructionsInfo = ConfigInstructionsInfo
export type PersonalizeStatus = "idle" | "loading" | "saving" | "error"

export type PersonalizeApi = {
  get(): Promise<CustomInstructionsInfo>
  update(content: string): Promise<CustomInstructionsInfo>
  reset(): Promise<CustomInstructionsInfo>
}

export function createPersonalizeController(api: PersonalizeApi) {
  const [info, setInfo] = createSignal<CustomInstructionsInfo>()
  const [content, setContent] = createSignal("")
  const [savedContent, setSavedContent] = createSignal("")
  const [resetPending, setResetPending] = createSignal(false)
  const [status, setStatus] = createSignal<PersonalizeStatus>("idle")
  const [error, setError] = createSignal<string>()

  const byteCount = () => new TextEncoder().encode(content()).byteLength
  const dirty = () => resetPending() || content() !== savedContent()
  const overLimit = () => byteCount() > (info()?.maxBytes ?? Number.POSITIVE_INFINITY)
  const busy = () => status() === "loading" || status() === "saving"
  const canSave = () => dirty() && !overLimit() && !busy()

  function adopt(next: CustomInstructionsInfo) {
    setInfo(next)
    setContent(next.content)
    setSavedContent(next.content)
    setResetPending(false)
    setError(undefined)
    setStatus("idle")
  }

  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause))
    setStatus("error")
  }

  function updateContent(next: string) {
    setResetPending(false)
    setContent(next)
  }

  function stageReset() {
    if (busy()) return false
    setResetPending(true)
    setContent("")
    setError(undefined)
    setStatus("idle")
    return true
  }

  function discard() {
    setResetPending(false)
    setContent(savedContent())
    setError(undefined)
    setStatus("idle")
  }
  async function load() {
    setStatus("loading")
    setError(undefined)
    try {
      adopt(await api.get())
    } catch (cause) {
      fail(cause)
    }
  }

  async function save() {
    if (!canSave()) return false
    setStatus("saving")
    setError(undefined)
    try {
      adopt(resetPending() ? await api.reset() : await api.update(content()))
      return true
    } catch (cause) {
      fail(cause)
      return false
    }
  }

  return {
    info,
    content,
    setContent: updateContent,
    savedContent,
    resetPending,
    status,
    error,
    byteCount,
    dirty,
    overLimit,
    busy,
    canSave,
    load,
    save,
    stageReset,
    discard,
  }
}

export type PersonalizeController = ReturnType<typeof createPersonalizeController>
