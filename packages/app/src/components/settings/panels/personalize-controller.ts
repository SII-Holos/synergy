import type { ConfigInstructionsInfo } from "@ericsanchezok/synergy-sdk/client"
import { createSignal } from "solid-js"

export type CustomInstructionsInfo = ConfigInstructionsInfo
export type PersonalizeStatus = "idle" | "loading" | "saving" | "resetting" | "error"

export type PersonalizeApi = {
  get(): Promise<CustomInstructionsInfo>
  update(content: string): Promise<CustomInstructionsInfo>
  reset(): Promise<CustomInstructionsInfo>
}

export function createPersonalizeController(api: PersonalizeApi) {
  const [info, setInfo] = createSignal<CustomInstructionsInfo>()
  const [content, setContent] = createSignal("")
  const [savedContent, setSavedContent] = createSignal("")
  const [status, setStatus] = createSignal<PersonalizeStatus>("idle")
  const [error, setError] = createSignal<string>()

  const byteCount = () => new TextEncoder().encode(content()).byteLength
  const dirty = () => content() !== savedContent()
  const overLimit = () => byteCount() > (info()?.maxBytes ?? Number.POSITIVE_INFINITY)
  const busy = () => status() === "loading" || status() === "saving" || status() === "resetting"
  const canSave = () => dirty() && !overLimit() && !busy()

  function adopt(next: CustomInstructionsInfo) {
    setInfo(next)
    setContent(next.content)
    setSavedContent(next.content)
    setError(undefined)
    setStatus("idle")
  }

  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause))
    setStatus("error")
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
      adopt(await api.update(content()))
      return true
    } catch (cause) {
      fail(cause)
      return false
    }
  }

  async function reset() {
    if (busy()) return false
    setStatus("resetting")
    setError(undefined)
    try {
      adopt(await api.reset())
      return true
    } catch (cause) {
      fail(cause)
      return false
    }
  }

  return {
    info,
    content,
    setContent,
    savedContent,
    status,
    error,
    byteCount,
    dirty,
    overLimit,
    busy,
    canSave,
    load,
    save,
    reset,
  }
}

export type PersonalizeController = ReturnType<typeof createPersonalizeController>
