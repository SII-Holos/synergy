import { createSignal, onCleanup } from "solid-js"

export type RequestSubmissionState = {
  status: "idle" | "pending" | "error" | "unknown" | "settled"
  error?: unknown
}
type Operation = { submit(): Promise<unknown>; isPending(): Promise<boolean> }
const idle: RequestSubmissionState = { status: "idle" }

export function createRequestSubmission() {
  const [states, setStates] = createSignal<Record<string, RequestSubmissionState>>({})
  const versions = new Map<string, symbol>()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const state = (key: string) => states()[key] ?? idle
  const set = (key: string, value: RequestSubmissionState) => {
    if (!disposed) setStates((previous) => ({ ...previous, [key]: value }))
  }
  const run = async (key: string, operation: Operation) => {
    const previous = state(key)
    if (disposed || requestSubmissionLocked(previous)) return
    const version = Symbol()
    versions.set(key, version)
    const current = () => !disposed && versions.get(key) === version
    set(key, { status: "pending" })
    if (previous.status !== "idle") {
      try {
        if (!(await operation.isPending())) {
          if (current()) set(key, { status: "settled" })
          return
        }
      } catch (error) {
        if (current()) set(key, { status: "unknown", error: previous.error ?? error })
        return
      }
    }
    if (!current()) return
    try {
      await operation.submit()
      if (current()) set(key, { status: "settled" })
    } catch (error) {
      try {
        const pending = await operation.isPending()
        if (current()) set(key, pending ? { status: "error", error } : { status: "settled", error })
      } catch {
        if (current()) set(key, { status: "unknown", error })
      }
    }
  }
  const check = async (key: string, isPending: () => Promise<boolean>) => {
    const previous = state(key)
    if (disposed || (previous.status !== "unknown" && previous.status !== "error")) return
    const version = Symbol()
    versions.set(key, version)
    set(key, { status: "pending" })
    try {
      const pending = await isPending()
      if (!disposed && versions.get(key) === version)
        set(key, { status: pending ? "error" : "settled", error: previous.error })
    } catch (error) {
      if (!disposed && versions.get(key) === version) set(key, { status: "unknown", error: previous.error ?? error })
    }
  }
  const forget = (key: string) => {
    versions.delete(key)
    if (!disposed)
      setStates((previous) => {
        const next = { ...previous }
        delete next[key]
        return next
      })
  }
  const settle = (key: string) => {
    versions.set(key, Symbol())
    set(key, { status: "settled" })
  }
  return { state, run, check, forget, settle }
}

export function requestSubmissionLocked(state: RequestSubmissionState) {
  return state.status === "pending" || state.status === "unknown" || state.status === "settled"
}
