import type { MessageDescriptor } from "@lingui/core"

const HOST_ACCESS_COPY: Record<string, { title: MessageDescriptor; description: MessageDescriptor }> = {
  "asset.write": {
    title: { id: "app.plugin.permission.assetWrite", message: "Create attachments" },
    description: {
      id: "app.plugin.permission.assetWrite.description",
      message: "Can create files and attachments in Synergy.",
    },
  },
  "task.delegate": {
    title: { id: "app.plugin.permission.taskDelegate", message: "Run bounded internal tasks" },
    description: {
      id: "app.plugin.permission.taskDelegate.description",
      message: "Can delegate bounded work to approved Synergy agents.",
    },
  },
  "shell.execute": {
    title: { id: "app.plugin.permission.shellExecute", message: "Run declared setup commands" },
    description: {
      id: "app.plugin.permission.shellExecute.description",
      message: "Can execute commands only through contributions that explicitly require this access.",
    },
  },
  mcp_spawn: {
    title: { id: "app.plugin.permission.mcpSpawn", message: "Start MCP services" },
    description: {
      id: "app.plugin.permission.mcpSpawn.description",
      message: "Can start and manage declared MCP service processes.",
    },
  },
  mcp_invoke: {
    title: { id: "app.plugin.permission.mcpInvoke", message: "Use MCP tools" },
    description: {
      id: "app.plugin.permission.mcpInvoke.description",
      message: "Can call tools exposed by declared MCP services.",
    },
  },
  network_request: {
    title: { id: "app.plugin.permission.networkRequest", message: "Access the network" },
    description: {
      id: "app.plugin.permission.networkRequest.description",
      message: "Can make outbound network requests.",
    },
  },
  "config:read": {
    title: { id: "app.plugin.permission.configRead", message: "Read configuration" },
    description: {
      id: "app.plugin.permission.configRead.description",
      message: "Can read approved Synergy configuration values.",
    },
  },
  "config:write": {
    title: { id: "app.plugin.permission.configWrite", message: "Update configuration" },
    description: {
      id: "app.plugin.permission.configWrite.description",
      message: "Can update approved Synergy configuration values.",
    },
  },
  prompt_transform: {
    title: { id: "app.plugin.permission.promptTransform", message: "Add conversation guidance" },
    description: {
      id: "app.plugin.permission.promptTransform.description",
      message: "Can add plugin guidance to the context sent to the model.",
    },
  },
}

const HOST_ACCESS_TITLES: Record<string, MessageDescriptor> = {
  "session.read": { id: "app.plugin.permission.sessionRead", message: "Read conversations" },
  "session.control": { id: "app.plugin.permission.sessionControl", message: "Control conversation execution" },
  "workspace.read": { id: "app.plugin.permission.workspaceRead", message: "Read workspace files" },
  "workspace.write": { id: "app.plugin.permission.workspaceWrite", message: "Update workspace files" },
  "settings.read": { id: "app.plugin.permission.settingsRead", message: "Read plugin settings" },
  "settings.write": { id: "app.plugin.permission.settingsWrite", message: "Update plugin settings" },
  secrets: { id: "app.plugin.permission.secrets", message: "Manage plugin credentials" },
  "tool.invoke": { id: "app.plugin.permission.toolInvoke", message: "Use declared tools" },
  "ui.hostActions": { id: "app.plugin.permission.uiHostActions", message: "Use workbench actions" },
  "composer.read": { id: "app.plugin.permission.composerRead", message: "Read the active draft" },
  "composer.write": { id: "app.plugin.permission.composerWrite", message: "Update the active draft" },
  "composer.intercept": { id: "app.plugin.permission.composerIntercept", message: "Review messages before sending" },
  "selection.read": { id: "app.plugin.permission.selectionRead", message: "Read selected text" },
  "agent.call": { id: "app.plugin.permission.agentCall", message: "Call approved agents" },
  "runtime.endpoint.read": {
    id: "app.plugin.permission.runtimeEndpointRead",
    message: "Read the local server endpoint",
  },
}

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

export function presentPluginPermission(
  input: PluginPermissionPresentationInput,
  translate?: (copy: MessageDescriptor) => string,
): PluginPermissionPresentation {
  let title = input.title?.trim() || input.key
  let description = input.description?.trim()
  let technical = input.technical?.trim()
  const hostCopy = HOST_ACCESS_COPY[input.key]
  if (translate && hostCopy && title === hostCopy.title.message && description === hostCopy.description.message) {
    title = translate(hostCopy.title)
    description = translate(hostCopy.description)
  } else if (
    translate &&
    title === input.key.replace(/[._:-]+/g, " ").replace(/^./, (value) => value.toUpperCase()) &&
    description === `Can use the declared Synergy access ${input.key}.`
  ) {
    title = translate(
      HOST_ACCESS_TITLES[input.key] ?? {
        id: "app.plugin.permission.declaredAccess",
        message: "Declared access: {capability}",
        values: { capability: input.key },
      },
    )
    description = undefined
    if (HOST_ACCESS_TITLES[input.key]) technical ||= input.key
  } else if (translate && title === input.key && (!description || isFallbackDescription(description, input.key))) {
    const copy = HOST_ACCESS_TITLES[input.key] ?? HOST_ACCESS_COPY[input.key]?.title
    if (copy) {
      title = translate(copy)
      description = undefined
      technical ||= input.key
    }
  }

  return {
    title,
    ...(!description || description === title || isFallbackDescription(description, input.key) ? {} : { description }),
    ...(!technical || (technical === input.key && title === input.key) || technical === title ? {} : { technical }),
  }
}

export function formatPluginBuildId(generation: string): string {
  return generation.slice(0, 8)
}

export function presentPluginFeature(
  input: PluginPermissionPresentationInput,
  translate: (copy: MessageDescriptor) => string,
): PluginPermissionPresentation {
  const presentation = presentPluginPermission(input)
  const generated: Record<string, { title: MessageDescriptor; pattern: RegExp; description: MessageDescriptor }> = {
    agents: {
      title: { id: "app.plugin.feature.agents", message: "Specialized agents" },
      pattern: /^Provides (\d+) specialized agents?\.$/,
      description: { id: "app.plugin.feature.agents.description", message: "Provides {count} specialized agents." },
    },
    skills: {
      title: { id: "app.plugin.feature.skills", message: "Packaged skills" },
      pattern: /^Provides (\d+) skills? that agents can use when relevant\.$/,
      description: {
        id: "app.plugin.feature.skills.description",
        message: "Provides {count} skills that agents can use when relevant.",
      },
    },
    mcp: {
      title: { id: "app.plugin.feature.mcp", message: "Optional MCP services" },
      pattern: /^Provides (\d+) MCP services?, enabled only when configured\.$/,
      description: {
        id: "app.plugin.feature.mcp.description",
        message: "Provides {count} MCP services, enabled only when configured.",
      },
    },
    ui: {
      title: { id: "app.plugin.feature.ui", message: "Synergy interface extensions" },
      pattern: /^Adds (\d+) interface extensions?\.$/,
      description: { id: "app.plugin.feature.ui.description", message: "Adds {count} interface extensions." },
    },
  }
  const copy = generated[input.key]
  const match = copy && input.title === copy.title.message ? input.description?.match(copy.pattern) : undefined
  if (copy && match)
    return {
      ...presentation,
      title: translate(copy.title),
      description: translate({ ...copy.description, values: { count: Number(match[1]) } }),
    }
  if (
    input.key === "chat.system.transform" &&
    input.title === "Conversation guidance" &&
    input.description === "Adds plugin guidance to conversations when the feature is active."
  )
    return {
      ...presentation,
      title: translate({ id: "app.plugin.feature.guidance", message: "Conversation guidance" }),
      description: translate({
        id: "app.plugin.feature.guidance.description",
        message: "Adds plugin guidance to conversations when the feature is active.",
      }),
    }
  return presentation
}
