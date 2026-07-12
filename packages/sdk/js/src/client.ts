export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { Plugin as GeneratedPlugin, SynergyClient } from "./gen/sdk.gen.js"
export { type Config as SynergyClientConfig }
export { SynergyClient }

type GeneratedPluginRequestOptions = NonNullable<Parameters<GeneratedPlugin["invokeOperation"]>[1]>
export type PluginInvokeOptions = GeneratedPluginRequestOptions & {
  sessionId?: string
  directory?: string
  scopeID?: string
}

export interface PluginInvoker {
  invoke(
    pluginId: string,
    operationId: string,
    input: unknown,
    options?: PluginInvokeOptions,
  ): ReturnType<GeneratedPlugin["invokeOperation"]>
}

export type SynergyClientInstance = SynergyClient & {
  plugin: GeneratedPlugin & PluginInvoker
}

export function createSynergyClient(config?: Config & { directory?: string; scopeID?: string }): SynergyClientInstance {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    const isNonASCII = /[^\x00-\x7F]/.test(config.directory)
    const encodedDirectory = isNonASCII ? encodeURIComponent(config.directory) : config.directory
    config.headers = {
      ...config.headers,
      "x-synergy-directory": encodedDirectory,
    }
  }

  if (config?.scopeID) {
    config.headers = {
      ...config.headers,
      "x-synergy-scope-id": encodeURIComponent(config.scopeID),
    }
  }

  const client = createClient(config)
  const synergy = new SynergyClient({ client })
  const plugin = Object.assign(synergy.plugin, {
    invoke(pluginId: string, operationId: string, input: unknown, options: PluginInvokeOptions = {}) {
      const { sessionId, directory, scopeID, ...request } = options
      return synergy.plugin.invokeOperation({ pluginId, operationId, input, sessionId, directory, scopeID }, request)
    },
  })
  return Object.assign(synergy, { plugin }) as SynergyClientInstance
}
