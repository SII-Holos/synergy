import type { ToastConfig, ToastType as RuntimeToastType } from "@ericsanchezok/synergy-ui/toast"
import { TOAST_TYPES, snapToastDuration, type ToastDurationOverrides, type ToastType } from "./types"

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
  const normalizedMuted = muted.filter(isToastType) as RuntimeToastType[]
  const durationOverrides = parseToastDurationOverrides(durations)
  if (!normalizedMuted.length && !Object.keys(durationOverrides).length) return undefined
  return {
    ...(normalizedMuted.length ? { muted: normalizedMuted } : {}),
    ...(Object.keys(durationOverrides).length
      ? { durationOverrides: durationOverrides as ToastConfig["durationOverrides"] }
      : {}),
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
    ...(muted.length ? { muted } : {}),
    ...(Object.keys(durationOverrides).length ? { durationOverrides } : {}),
  }
}
