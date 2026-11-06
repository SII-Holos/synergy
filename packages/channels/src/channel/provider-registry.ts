import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import type { Provider } from "./types"

const runtimeState = RuntimeContext.state(() => ({
  providers: new Map<string, Provider>(),
}))

export function registerProvider<TAccountConfig, TChannelConfig>(
  provider: Provider<TAccountConfig, TChannelConfig>,
): void {
  const instanceState = runtimeState()

  instanceState.providers.set(provider.type, provider as unknown as Provider)
}

export function getProvider(type: string): Provider | undefined {
  const instanceState = runtimeState()

  return instanceState.providers.get(type)
}
