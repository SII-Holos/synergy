import type { PluginSettingsSaveStatus } from "@ericsanchezok/synergy-plugin"

export type PluginSettingsDraftKey = {
  pluginId: string
  scopeId: string
}

type PluginSettingsDraftEntry = {
  key: PluginSettingsDraftKey
  saved: Record<string, unknown>
  draft: Record<string, unknown>
  dirty: boolean
  revision: number
  saveState: "idle" | "saving" | "error"
}

export function createPluginSettingsDrafts(onChange: () => void = () => {}) {
  const entries = new Map<string, PluginSettingsDraftEntry>()

  function id(key: PluginSettingsDraftKey) {
    return `${key.pluginId}\u0000${key.scopeId}`
  }

  function adopt(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry = entries.get(id(key))
    if (entry?.dirty) return entry.draft
    const next: PluginSettingsDraftEntry = {
      key,
      saved: values,
      draft: values,
      dirty: false,
      revision: 0,
      saveState: "idle",
    }
    entries.set(id(key), next)
    onChange()
    return next.draft
  }

  function values(key: PluginSettingsDraftKey) {
    return entries.get(id(key))?.draft
  }

  function stage(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry: PluginSettingsDraftEntry = entries.get(id(key)) ?? {
      key,
      saved: {},
      draft: {},
      dirty: false,
      revision: 0,
      saveState: "idle",
    }
    entry.draft = values
    entry.dirty = JSON.stringify(values) !== JSON.stringify(entry.saved)
    entry.revision += 1
    if (entry.saveState === "error") entry.saveState = "idle"
    entries.set(id(key), entry)
    onChange()
  }

  function dirty() {
    return [...entries.values()].some((entry) => entry.dirty)
  }

  function status(key: PluginSettingsDraftKey): PluginSettingsSaveStatus {
    const entry = entries.get(id(key))
    if (entry?.saveState === "saving" || entry?.saveState === "error") return entry.saveState
    return entry?.dirty ? "dirty" : "saved"
  }

  async function save(
    update: (key: PluginSettingsDraftKey, values: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    const active = [...entries.values()]
      .filter((entry) => entry.dirty)
      .map((entry) => ({ entry, submitted: entry.draft, revision: entry.revision }))
    let savedAll = true
    for (const { entry, submitted, revision } of active) {
      entry.saveState = "saving"
      onChange()
      try {
        const saved = await update(entry.key, submitted)
        entry.saved = saved
        if (entry.revision === revision) entry.draft = saved
        entry.dirty = JSON.stringify(entry.draft) !== JSON.stringify(entry.saved)
        entry.saveState = "idle"
        onChange()
      } catch {
        entry.saveState = "error"
        savedAll = false
        onChange()
      }
    }
    return savedAll
  }

  function discard() {
    for (const entry of entries.values()) {
      entry.draft = entry.saved
      entry.dirty = false
      entry.saveState = "idle"
    }
    onChange()
  }

  return {
    adopt,
    values,
    stage,
    dirty,
    status,
    save,
    discard,
  }
}
