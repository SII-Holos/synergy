import type { ToastConfig, ToastType as RuntimeToastType } from "@ericsanchezok/synergy-ui/toast"
import { TOAST_TYPES, snapToastDuration, type ToastDurationOverrides, type ToastType } from "./types"

export type ToastPatch = {
  muted: RuntimeToastType[]
  durationOverrides?: ToastConfig["durationOverrides"]
}

export function isToastType(value: string): value is ToastType {
  return (TOAST_TYPES as readonly string[]).includes(value)
}

export function nextMutedToasts(muted: readonly string[], type: ToastType, mutedEnabled: boolean): string[] {
  const next = mutedEnabled ? [...muted, type] : muted.filter((item) => item !== type)
  return Array.from(new Set(next.filter(isToastType)))
}

export function parseToastDurationOverrides(durations: ToastDurationOverrides): Partial<Record<ToastType, number>> {
  const result: Partial<Record<ToastType, number>> = {}
  for (const type of TOAST_TYPES) {
    const raw = durations[type]
    if (!raw.trim()) continue
    const parsed = Number(raw)
    if (!Number.isNaN(parsed) && Number.isInteger(parsed) && parsed > 0 && parsed <= 30000) {
      result[type] = snapToastDuration(parsed)
    }
  }
  return result
}

export function toastConfigFromPreferences(
  muted: readonly string[],
  durations: ToastDurationOverrides,
): ToastConfig | undefined {
  const patch = toastPatchFromPreferences(muted, durations)
  if (!patch.muted.length && !patch.durationOverrides) return undefined
  return {
    ...(patch.muted.length ? { muted: patch.muted } : {}),
    ...(patch.durationOverrides ? { durationOverrides: patch.durationOverrides } : {}),
  }
}

/** Domain-update payload that always carries `muted` so mergeDeep can clear it. */
export function toastPatchFromPreferences(muted: readonly string[], durations: ToastDurationOverrides): ToastPatch {
  const normalizedMuted = muted.filter(isToastType) as RuntimeToastType[]
  const durationOverrides = parseToastDurationOverrides(durations)
  return {
    muted: normalizedMuted,
    ...(Object.keys(durationOverrides).length
      ? { durationOverrides: durationOverrides as ToastConfig["durationOverrides"] }
      : {}),
  }
}

export function normalizeServerToast(
  toast:
    | {
        muted?: readonly string[]
        durationOverrides?: Partial<Record<string, number>>
      }
    | undefined
    | null,
): ToastPatch | undefined {
  if (!toast) return undefined
  const muted = (toast.muted ?? []).filter(isToastType) as RuntimeToastType[]
  const durationOverrides: Partial<Record<RuntimeToastType, number>> = {}
  for (const type of TOAST_TYPES) {
    const value = toast.durationOverrides?.[type]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      durationOverrides[type] = snapToastDuration(value)
    }
  }
  if (!muted.length && !Object.keys(durationOverrides).length) return undefined
  return {
    muted,
    ...(Object.keys(durationOverrides).length ? { durationOverrides } : {}),
  }
}

export function toastConfigFromServerToast(
  toast:
    | {
        muted?: readonly string[]
        durationOverrides?: Partial<Record<string, number>>
      }
    | undefined
    | null,
): ToastConfig | undefined {
  const normalized = normalizeServerToast(toast)
  if (!normalized) return undefined
  return {
    ...(normalized.muted.length ? { muted: normalized.muted } : {}),
    ...(normalized.durationOverrides ? { durationOverrides: normalized.durationOverrides } : {}),
  }
}
