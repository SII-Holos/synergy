import type { AgendaActivityEntry, AgendaActivityPage, SynergyClient } from "@ericsanchezok/synergy-sdk/client"

export type AgendaActivityState = {
  items: AgendaActivityEntry[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export function defaultAgendaActivityState(limit = 25): AgendaActivityState {
  return {
    items: [],
    total: 0,
    offset: 0,
    limit,
    hasMore: false,
  }
}

export async function requestAgendaActivity(input: {
  client: SynergyClient
  directory: string
  scopeID?: string
  query?: string
  append?: boolean
  state: AgendaActivityState
}) {
  const activityApi = (input.client.agenda as any).activity
  if (typeof activityApi !== "function") {
    throw new Error("Agenda activity API is unavailable in the current client build")
  }

  const offset = input.append ? input.state.offset + input.state.items.length : 0
  const res = await activityApi({
    directory: input.directory,
    scopeID: input.scopeID,
    query: input.query || undefined,
    offset,
    limit: input.state.limit,
  })

  const page = (res.data as AgendaActivityPage | undefined) ?? defaultAgendaActivityState(input.state.limit)
  return page
}

export function mergeAgendaActivityPage(input: {
  append?: boolean
  previous: AgendaActivityState
  page: AgendaActivityPage
}): AgendaActivityState {
  return {
    items: input.append ? [...input.previous.items, ...input.page.items] : input.page.items,
    total: input.page.total,
    offset: input.page.offset,
    limit: input.page.limit,
    hasMore: input.page.hasMore,
  }
}

export function normalizeAgendaActivityError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "data" in error
        ? String((error as any).data?.message ?? "")
        : ""

  if (message.toLowerCase().includes("agenda item not found: activity")) {
    return "Activity endpoint is unavailable on the running server instance"
  }

  return message || "Activity is unavailable right now"
}
