import type { AgendaActivityEntry, AgendaActivityPage, SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { requestErrorMessage } from "@/utils/error"

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
  scopeID?: string
  query?: string
  append?: boolean
  state: AgendaActivityState
}) {
  if (!input.client?.agenda?.activity) {
    throw new Error("Agenda activity API is unavailable in the current client build")
  }

  const offset = input.append ? input.state.offset + input.state.items.length : 0
  const res = await input.client.agenda.activity(
    {
      scopeID: input.scopeID,
      query: input.query || undefined,
      offset,
      limit: input.state.limit,
    },
    { throwOnError: true },
  )

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

export function normalizeAgendaActivityError(error: unknown, fallback: string): string {
  return requestErrorMessage(error, fallback)
}
