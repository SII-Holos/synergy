import type { Accessor } from "solid-js"

export type NewSessionSubmitLease = {
  release: () => void
}

export function acquireNewSessionSubmitLock(input: {
  isNewSession: boolean
  pending: Accessor<boolean>
  setPending: (pending: boolean) => void
}): NewSessionSubmitLease | undefined {
  if (!input.isNewSession) return { release: () => undefined }
  if (input.pending()) return undefined

  input.setPending(true)
  let active = true
  return {
    release: () => {
      if (!active) return
      active = false
      input.setPending(false)
    },
  }
}
