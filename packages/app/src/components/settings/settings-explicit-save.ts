export type ExplicitSettingsSaveSource = {
  dirty(): boolean
  save(): Promise<boolean>
}

export function hasExplicitSettingsChanges(sources: ExplicitSettingsSaveSource[]) {
  return sources.some((source) => source.dirty())
}

export async function saveExplicitSettingsChanges(sources: ExplicitSettingsSaveSource[], close: () => void) {
  const active = sources.filter((source) => source.dirty())
  if (active.length === 0) return false

  const results = await Promise.all(active.map((source) => source.save()))
  const saved = results.every(Boolean)
  if (saved) close()
  return saved
}
