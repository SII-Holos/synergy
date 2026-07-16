import { Agent } from "@/agent/agent"
import { Log } from "@/util/log"

const log = Log.create({ service: "clarus.agent-resolver" })

export namespace ClarusAgentResolver {
  export type Resolution = {
    agentId: string
    source: "explicit_task" | "project_primary" | "default"
  }

  export async function resolveAgent(params: {
    explicitTaskAgent?: string | null
    projectPrimaryAgent?: string | null
  }): Promise<Resolution | { error: string }> {
    if (params.explicitTaskAgent) {
      const agent = await Agent.get(params.explicitTaskAgent)
      if (agent) {
        return { agentId: params.explicitTaskAgent, source: "explicit_task" }
      }
      log.warn("explicit task agent not available, falling back", {
        requested: params.explicitTaskAgent,
      })
    }

    if (params.projectPrimaryAgent) {
      const agent = await Agent.get(params.projectPrimaryAgent)
      if (agent) {
        return { agentId: params.projectPrimaryAgent, source: "project_primary" }
      }
      log.warn("project primary agent not available", {
        requested: params.projectPrimaryAgent,
      })
    }

    const defaultId = await Agent.defaultAgent()
    if (defaultId) {
      const agent = await Agent.get(defaultId)
      if (agent) {
        return { agentId: defaultId, source: "default" }
      }
    }

    return { error: "No Clarus-capable agent available. Add a primary agent via: synergy config agent add <name>" }
  }
}
