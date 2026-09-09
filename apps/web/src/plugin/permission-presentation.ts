export interface PluginPermissionPresentationInput {
  key: string
  title?: string
  description?: string
  technical?: string
}

export interface PluginPermissionPresentation {
  title: string
  description?: string
  technical?: string
}

function isFallbackDescription(description: string, key: string): boolean {
  return (
    description === key ||
    description === `Requires ${key}` ||
    description === `Synergy host capability ${key}` ||
    description === `Use the Synergy host capability ${key}.`
  )
}

export function presentPluginPermission(input: PluginPermissionPresentationInput): PluginPermissionPresentation {
  const title = input.title?.trim() || input.key
  const description = input.description?.trim()
  const technical = input.technical?.trim()

  return {
    title,
    ...(!description || description === title || isFallbackDescription(description, input.key) ? {} : { description }),
    ...(!technical || (technical === input.key && title === input.key) || technical === title ? {} : { technical }),
  }
}

export function formatPluginBuildId(generation: string): string {
  return generation.slice(0, 8)
}
