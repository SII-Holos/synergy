import { createSignal, onCleanup } from "solid-js"

export type RequestSubmissionState = {
  status: "idle" | "pending" | "error" | "unknown" | "settled"
  error?: unknown
}
type Operation = { submit(): Promise<unknown>; isPending(): Promise<boolean> }
const idle: RequestSubmissionState = { status: "idle" }

export function createRequestSubmission() {
  const [states, setStates] = createSignal<Record<string, RequestSubmissionState>>({})
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
    if (disposed || previous.status === "pending" || previous.status === "settled") return
    set(key, { status: "pending" })
    if (previous.status !== "idle") {
      try {
        if (!(await operation.isPending())) {
          set(key, { status: "settled" })
          return
        }
      } catch (error) {
        set(key, { status: "unknown", error: previous.error ?? error })
        return
      }
    }
    if (disposed) return
    try {
      await operation.submit()
      set(key, { status: "settled" })
    } catch (error) {
      try {
        const pending = await operation.isPending()
        set(key, pending ? { status: "error", error } : { status: "settled", error })
      } catch {
        set(key, { status: "unknown", error })
      }
    }
  }
  return { state, run }
}

export function requestSubmissionLocked(state: RequestSubmissionState) {
  return state.status === "pending" || state.status === "unknown" || state.status === "settled"
}
