import type { ProviderAuthMethod } from "@ericsanchezok/synergy-sdk/client"

export function createProviderCredentialCommand(write: () => Promise<void>, refresh: () => Promise<void>) {
  let persisted = false
  return {
    persisted: () => persisted,
    reset: () => {
      persisted = false
    },
    async run() {
      if (!persisted) {
        await write()
        persisted = true
      }
      await refresh()
    },
  }
}

export function resolveProviderAuthMethods(input: {
  registry: Record<string, ProviderAuthMethod[]>
  providerID: string
  fallbackLabel: string
}): ProviderAuthMethod[] {
  return (
    input.registry[input.providerID] ?? [
      {
        type: "api",
        label: input.fallbackLabel,
      },
    ]
  )
}

export async function runProviderDeviceCallback(input: {
  callback: () => Promise<unknown>
  complete: () => Promise<void>
  active: () => boolean
  onError: () => void
  onComplete: () => void
}) {
  try {
    await input.callback()
    if (!input.active()) return
    await input.complete()
    if (input.active()) input.onComplete()
  } catch {
    if (input.active()) input.onError()
  }
}

export function shouldAutoAdvanceConnection(methods: ProviderAuthMethod[]) {
  if (methods.length !== 1) return false
  // OAuth launches an external browser flow; require an explicit click so a
  // single-method OAuth provider never opens the authorization page on select.
  return methods[0]?.type !== "oauth"
}
