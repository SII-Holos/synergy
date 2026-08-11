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
}

export function createPluginSettingsDrafts(onChange: () => void = () => {}) {
  const entries = new Map<string, PluginSettingsDraftEntry>()

  function id(key: PluginSettingsDraftKey) {
    return `${key.pluginId}\u0000${key.scopeId}`
  }

  function adopt(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry = entries.get(id(key))
    if (entry?.dirty) return entry.draft
    const next = { key, saved: values, draft: values, dirty: false, revision: 0 }
    entries.set(id(key), next)
    onChange()
    return next.draft
  }

  function values(key: PluginSettingsDraftKey) {
    return entries.get(id(key))?.draft
  }

  function stage(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry = entries.get(id(key)) ?? { key, saved: {}, draft: {}, dirty: false, revision: 0 }
    entry.draft = values
    entry.dirty = JSON.stringify(values) !== JSON.stringify(entry.saved)
    entry.revision += 1
    entries.set(id(key), entry)
    onChange()
  }

  function dirty() {
    return [...entries.values()].some((entry) => entry.dirty)
  }

  async function save(
    update: (key: PluginSettingsDraftKey, values: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    const active = [...entries.values()]
      .filter((entry) => entry.dirty)
      .map((entry) => ({ entry, submitted: entry.draft, revision: entry.revision }))
    let savedAll = true
    for (const { entry, submitted, revision } of active) {
      try {
        const saved = await update(entry.key, submitted)
        entry.saved = saved
        if (entry.revision === revision) entry.draft = saved
        entry.dirty = JSON.stringify(entry.draft) !== JSON.stringify(entry.saved)
        onChange()
      } catch {
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
    }
    onChange()
  }

  return {
    adopt,
    values,
    stage,
    dirty,
    save,
    discard,
  }
}
