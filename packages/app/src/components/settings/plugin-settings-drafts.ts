export type PluginSettingsDraftKey = {
  pluginId: string
  scopeId: string
}

type PluginSettingsDraftEntry = {
  key: PluginSettingsDraftKey
  saved: Record<string, unknown>
  draft: Record<string, unknown>
  dirty: boolean
}

export function createPluginSettingsDrafts(onChange: () => void = () => {}) {
  const entries = new Map<string, PluginSettingsDraftEntry>()

  function id(key: PluginSettingsDraftKey) {
    return `${key.pluginId}\u0000${key.scopeId}`
  }

  function adopt(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry = entries.get(id(key))
    if (entry?.dirty) return entry.draft
    const next = { key, saved: values, draft: values, dirty: false }
    entries.set(id(key), next)
    onChange()
    return next.draft
  }

  function values(key: PluginSettingsDraftKey) {
    return entries.get(id(key))?.draft
  }

  function stage(key: PluginSettingsDraftKey, values: Record<string, unknown>) {
    const entry = entries.get(id(key)) ?? { key, saved: {}, draft: {}, dirty: false }
    entry.draft = values
    entry.dirty = JSON.stringify(values) !== JSON.stringify(entry.saved)
    entries.set(id(key), entry)
    onChange()
  }

  function dirty() {
    return [...entries.values()].some((entry) => entry.dirty)
  }

  async function save(
    update: (key: PluginSettingsDraftKey, values: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) {
    const active = [...entries.values()].filter((entry) => entry.dirty)
    const results = await Promise.all(
      active.map(async (entry) => {
        try {
          const saved = await update(entry.key, entry.draft)
          entry.saved = saved
          entry.draft = saved
          entry.dirty = false
          onChange()
          return true
        } catch {
          onChange()
          return false
        }
      }),
    )
    return results.every(Boolean)
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
