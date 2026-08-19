export type ExplicitSettingsSaveSource = {
  dirty(): boolean
  save(): Promise<boolean>
}

export function hasExplicitSettingsChanges(sources: ExplicitSettingsSaveSource[]) {
  return sources.some((source) => source.dirty())
}

export function retainDraftAfterSave<T>(current: T | undefined, submitted: T): T | undefined {
  return current === submitted ? undefined : current
}

// Theme is applied instantly on selection and persisted via a background
// domain update, so the explicit save flow no longer extracts it from the
// patch. When the panel re-reads server config that has not yet received the
// background update, callers restore the live provider value with
// `themeIdToSettingsValue` so a stale server value never overrides it.
export function themeIdToSettingsValue(themeId: string, defaultThemeId = "synergy"): string {
  return themeId === defaultThemeId ? "" : themeId
}

export function snapshotSettingsDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function rebaseDraftAfterSave<T>(refreshed: T, submitted: T, current: T): T {
  return rebaseValue(refreshed, submitted, current) as T
}

function rebaseValue(refreshed: unknown, submitted: unknown, current: unknown): unknown {
  if (JSON.stringify(current) === JSON.stringify(submitted)) return refreshed
  if (!isRecord(refreshed) || !isRecord(submitted) || !isRecord(current)) return current

  const rebased: Record<string, unknown> = { ...refreshed }
  for (const key of new Set([...Object.keys(submitted), ...Object.keys(current)])) {
    if (!(key in current)) {
      delete rebased[key]
      continue
    }
    if (!(key in submitted)) {
      rebased[key] = current[key]
      continue
    }
    rebased[key] = rebaseValue(refreshed[key], submitted[key], current[key])
  }
  return rebased
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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
