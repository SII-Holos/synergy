import type { Provider } from "./types"

const providers = new Map<string, Provider>()

export function registerProvider<TAccountConfig, TChannelConfig>(
  provider: Provider<TAccountConfig, TChannelConfig>,
): void {
  providers.set(provider.type, provider as unknown as Provider)
}

export function getProvider(type: string): Provider | undefined {
  return providers.get(type)
}
