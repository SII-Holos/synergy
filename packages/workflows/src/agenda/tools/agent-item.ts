import type { AgendaTypes } from "../types"

export function agendaAgentItem(item: AgendaTypes.Item) {
  return {
    agendaItemId: item.id,
    agendaTitle: item.title,
    agendaDescription: item.description,
    executionInstructions: item.prompt,
    status: item.status,
    triggers: item.triggers,
    tags: item.tags,
    global: item.global,
    wake: item.wake,
    silent: item.silent,
    agent: item.agent,
    model: item.model,
    controlProfile: item.controlProfile,
    sessionMode: item.sessionMode,
    sessionRefs: item.sessionRefs,
    timeoutSeconds: item.timeout === undefined ? undefined : item.timeout / 1000,
    nextRunAtMs: item.state.nextRunAt,
    lastRunAtMs: item.state.lastRunAt,
    lastRunStatus: item.state.lastRunStatus,
    runCount: item.state.runCount,
  }
}
