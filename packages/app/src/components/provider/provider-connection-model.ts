import type { ProviderAuthMethod } from "@ericsanchezok/synergy-sdk/client"

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
