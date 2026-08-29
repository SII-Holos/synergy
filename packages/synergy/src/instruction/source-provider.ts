/**
 * H7 source inversion: instruction domains (skill, command) receive their
 * raw entries from owning product domains (plugin skills, MCP prompts)
 * through these L1 provider registries instead of importing them, so the
 * product layer stays acyclic (no skill→plugin or command→mcp edges). The
 * L4 product manifest registers the concrete providers.
 */
export namespace SkillSourceProviders {
  export interface Entry {
    name: string
    description: string
    content?: string
    references?: Record<string, string>
    dir?: string
    contributionId: string
    pluginId: string
    pluginName?: string
    pluginDir: string
  }

  type Provider = () => Promise<Entry[]>

  const providers = new Map<string, Provider>()

  export function register(id: string, provider: Provider): void {
    providers.set(id, provider)
  }

  export function unregister(id: string): void {
    providers.delete(id)
  }

  export async function list(): Promise<Entry[]> {
    const result: Entry[] = []
    for (const provider of providers.values()) result.push(...(await provider()))
    return result
  }
}

export namespace CommandSourceProviders {
  export interface PromptInfo {
    client: string
    name: string
    description?: string
    arguments?: Array<{ name: string }>
  }

  export interface Provider {
    /** Prompt catalog keyed by prompt name across all backing sources. */
    prompts(): Promise<Record<string, PromptInfo>>
    /** Resolve a prompt to its rendered template text; undefined on failure. */
    getPrompt(client: string, name: string, args?: Record<string, string>): Promise<string | undefined>
    /** Subscribe to catalog changes; returns an unsubscribe function. */
    subscribe(change: () => void): () => void
  }

  const providers = new Map<string, Provider>()

  export function register(id: string, provider: Provider): void {
    providers.set(id, provider)
  }

  export async function prompts(): Promise<Record<string, PromptInfo>> {
    const result: Record<string, PromptInfo> = {}
    for (const provider of providers.values()) Object.assign(result, await provider.prompts())
    return result
  }

  export async function getPrompt(client: string, name: string, args?: Record<string, string>) {
    for (const provider of providers.values()) {
      const template = await provider.getPrompt(client, name, args)
      if (template !== undefined) return template
    }
    return undefined
  }

  export function subscribeAll(change: () => void): () => void {
    const unsubscribers = [...providers.values()].map((provider) => provider.subscribe(change))
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }
}
