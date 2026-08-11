export type ExplicitSettingsSaveSource = {
  dirty(): boolean
  save(): Promise<boolean>
}

export function hasExplicitSettingsChanges(sources: ExplicitSettingsSaveSource[]) {
  return sources.some((source) => source.dirty())
}

export async function saveExplicitSettingsChanges(sources: ExplicitSettingsSaveSource[]) {
  const active = sources.filter((source) => source.dirty())
  if (active.length === 0) return false

  const results = await Promise.all(
    active.map(async (source) => {
      try {
        return await source.save()
      } catch {
        return false
      }
    }),
  )
  return results.every(Boolean)
}
