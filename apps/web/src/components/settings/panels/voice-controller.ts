import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { VoiceConfig } from "@ericsanchezok/synergy-sdk/client"
import { buildVoiceConfigPatch, emptyVoiceDraft, voiceDraftFromConfig } from "./voice-panel-model"
import { rebaseDraftAfterSave, snapshotSettingsDraft } from "../settings-explicit-save"

export function createVoiceController(api: {
  get(): Promise<VoiceConfig | undefined>
  update(config: VoiceConfig): Promise<VoiceConfig | undefined>
}) {
  const [config, setConfig] = createSignal<VoiceConfig>()
  const [draft, setDraft] = createStore(emptyVoiceDraft())
  const [status, setStatus] = createSignal<"idle" | "loading" | "saving" | "error">("idle")
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const patch = () => (loaded() ? buildVoiceConfigPatch(draft, config()) : undefined)
  const dirty = () => Boolean(patch())
  const validate = () => {
    for (const side of ["stt", "tts"] as const) {
      if (draft[side].enabled && !draft[side].model.trim()) return { side, field: "model", reason: "model" } as const
      if (!draft[side].baseURL.trim()) continue
      try {
        const url = new URL(draft[side].baseURL)
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol")
      } catch {
        return { side, field: "baseURL", reason: "endpoint" } as const
      }
    }
  }
  async function load() {
    if (status() === "loading" || status() === "saving") return
    setStatus("loading")
    try {
      const previous = voiceDraftFromConfig(config())
      const next = await api.get()
      setDraft(
        reconcile(
          loaded()
            ? rebaseDraftAfterSave(voiceDraftFromConfig(next), previous, snapshotSettingsDraft(draft))
            : voiceDraftFromConfig(next),
        ),
      )
      setConfig(next)
      setLoaded(true)
      setError(undefined)
      setStatus("idle")
    } catch (cause) {
      fail(cause)
    }
  }
  function fail(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause))
    setStatus("error")
  }
  async function save() {
    if (status() === "saving" || validate()) return false
    const change = patch()
    if (!change) return true
    const submitted = snapshotSettingsDraft(draft)
    setStatus("saving")
    try {
      const next = await api.update(change)
      setDraft(reconcile(rebaseDraftAfterSave(voiceDraftFromConfig(next), submitted, snapshotSettingsDraft(draft))))
      setConfig(next)
      setError(undefined)
      setStatus("idle")
      return true
    } catch (cause) {
      fail(cause)
      return false
    }
  }
  function discard() {
    setDraft(reconcile(voiceDraftFromConfig(config())))
    setError(undefined)
    setStatus("idle")
  }
  return { config, draft, setDraft, dirty, loaded, status, error, validate, load, save, discard }
}
export type VoiceController = ReturnType<typeof createVoiceController>
