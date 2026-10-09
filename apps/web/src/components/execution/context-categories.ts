import type { AssistantMessage } from "@ericsanchezok/synergy-sdk/client"

export const contextCategories = {
  systemInstructions: {
    label: { id: "context.category.system", message: "System instructions" },
    color: "var(--chart-series-1)",
  },
  toolDefinitions: {
    label: { id: "context.category.tools", message: "Tool definitions" },
    color: "var(--chart-series-2)",
  },
  userMessages: { label: { id: "context.category.user", message: "User messages" }, color: "var(--chart-series-3)" },
  injectedContext: {
    label: { id: "context.category.injected", message: "Injected context" },
    color: "var(--chart-series-4)",
  },
  skills: { label: { id: "context.category.skills", message: "Skill content" }, color: "var(--chart-series-5)" },
  assistantMessages: {
    label: { id: "context.category.assistant", message: "Assistant messages" },
    color: "var(--chart-series-6)",
  },
  toolResults: { label: { id: "context.category.results", message: "Tool results" }, color: "var(--chart-series-7)" },
  attachments: {
    label: { id: "context.category.attachments", message: "Attachments and references" },
    color: "var(--chart-series-8)",
  },
  overhead: {
    label: { id: "context.category.other", message: "Other / unattributed" },
    color: "var(--icon-weak-base)",
  },
  legacyConversation: {
    label: { id: "context.category.legacyConversation", message: "Conversation · historical aggregate" },
    color: "var(--chart-series-6)",
  },
  legacyTools: {
    label: { id: "context.category.legacyTools", message: "Tools · historical aggregate" },
    color: "var(--chart-series-2)",
  },
  legacyInstructions: {
    label: { id: "context.category.legacyInstructions", message: "Instructions · historical aggregate" },
    color: "var(--chart-series-1)",
  },
} as const
export type ContextCategory = keyof typeof contextCategories
export function contextRows(usage: AssistantMessage["contextUsage"]) {
  if (!usage) return []
  return [
    ...usage.categories.map((entry) => ({ ...entry, ...contextCategories[entry.category] })),
    {
      category: "overhead" as const,
      precision: "source" as const,
      estimatedTokens: 0,
      attributedTokens: usage.overhead.attributedTokens,
      items: undefined,
      ...contextCategories.overhead,
    },
  ]
}
export const D = {
  requestDetails: { id: "context.dashboard.requestDetails", message: "Request details" },
  tokenUnit: { id: "context.dashboard.tokenUnit", message: "tokens" },
  current: { id: "context.dashboard.current", message: "Current context" },
  historical: { id: "context.dashboard.historical", message: "Context for request {number}" },
  tokenStats: { id: "context.dashboard.tokenStats", message: "Token statistics" },
  answerTokens: { id: "context.dashboard.answerTokens", message: "Output excluding reasoning" },
  reasoning: { id: "context.dashboard.reasoning", message: "Reasoning" },
  accumulated: { id: "context.dashboard.accumulated", message: "Cumulative usage" },
  usageDetails: { id: "context.dashboard.usageDetails", message: "Details" },
  latest: { id: "context.dashboard.latest", message: "Latest recorded request" },
  input: { id: "context.dashboard.input", message: "Input tokens" },
  composition: { id: "context.dashboard.composition", message: "Input composition" },
  capacity: { id: "context.dashboard.capacity", message: "Context window" },
  remaining: { id: "context.dashboard.remaining", message: "{tokens} remaining" },
  estimated: {
    id: "context.dashboard.estimated",
    message: "Categories are estimates; the total comes from the provider.",
  },
  unavailable: {
    id: "context.dashboard.unavailable",
    message: "Context composition was not recorded for this request.",
  },
  noRequests: { id: "context.dashboard.noRequests", message: "Context appears after the first model request." },
  growth: { id: "context.dashboard.growth", message: "Context history" },
  byRequest: { id: "context.dashboard.byRequest", message: "Requests" },
  byRound: { id: "context.dashboard.byRound", message: "Rounds" },
  total: { id: "context.dashboard.total", message: "Total" },
  delta: { id: "context.dashboard.delta", message: "Change" },
  request: { id: "context.dashboard.request", message: "Request {number}" },
  requestPicker: { id: "context.dashboard.requestPicker", message: "Choose a request" },
  round: { id: "context.dashboard.round", message: "Round {number} · last request" },
  earlier: { id: "context.dashboard.earlier", message: "Load earlier requests" },
  content: { id: "context.dashboard.content", message: "Context contents" },
  comparedPrevious: { id: "context.dashboard.comparedPrevious", message: "Estimated change from previous request" },
  sourceChange: {
    id: "context.dashboard.sourceChange",
    message: "Estimated {tokens} tokens · {items} items from previous request",
  },
  taskActivity: { id: "context.dashboard.taskActivity", message: "Task activity" },
  toolCount: { id: "context.dashboard.toolCount", message: "{count} tool calls" },
  failedTools: { id: "context.dashboard.failedTools", message: "{count} failed tool calls" },
  roundPrompt: { id: "context.dashboard.roundPrompt", message: "Task in this round" },
  mainRequests: { id: "context.dashboard.mainRequests", message: "{count} main requests" },
  sourceSearch: { id: "context.dashboard.sourceSearch", message: "Search sources" },
  taskScope: { id: "context.dashboard.taskScope", message: "Entire task" },
  items: { id: "context.dashboard.items", message: "{count} items" },
  characters: { id: "context.dashboard.characters", message: "{count} characters" },
  moreItems: { id: "context.dashboard.moreItems", message: "Load more items" },
  sourceUnavailable: {
    id: "context.dashboard.sourceUnavailable",
    message: "The source index is unavailable. Open execution records to inspect the saved request.",
  },
  requestIdentity: { id: "context.dashboard.requestIdentity", message: "Round {round} · Request {request}" },
  requestChange: { id: "context.dashboard.requestChange", message: "Change {tokens}" },
  requestInput: { id: "context.dashboard.requestInput", message: "Input {tokens}" },
  timing: { id: "context.dashboard.timing", message: "Timing breakdown" },
  timingBasis: { id: "context.dashboard.timingBasis", message: "Recorded durations · parallel work can overlap" },
  timingTotal: { id: "context.dashboard.timingTotal", message: "Recorded time" },
  modelWait: { id: "context.dashboard.modelWait", message: "First-token wait" },
  generation: { id: "context.dashboard.generation", message: "Generation, including reasoning" },
  toolExecution: { id: "context.dashboard.toolExecution", message: "Tool execution" },
  timedCalls: { id: "context.dashboard.timedCalls", message: "{count} measured" },
  requestCount: { id: "context.dashboard.requestCount", message: "{count} requests" },
  retryCount: { id: "context.dashboard.retryCount", message: "{count} retries" },
  viewContent: { id: "context.dashboard.viewContent", message: "View" },
  hideContent: { id: "context.dashboard.hideContent", message: "Hide" },
  moreContent: { id: "context.dashboard.moreContent", message: "Read more" },
  contentLimit: {
    id: "context.dashboard.contentLimit",
    message: "Preview limit reached. Open execution records to read or download the full request.",
  },
  back: { id: "context.dashboard.back", message: "Back to overview" },
  records: { id: "context.dashboard.records", message: "View execution records" },
  events: { id: "context.dashboard.events", message: "Context events" },
  compaction: { id: "context.dashboard.compaction", message: "Context compacted before this request" },
  noEvents: { id: "context.dashboard.noEvents", message: "No compaction recorded in the loaded history." },
  indexTruncated: {
    id: "context.dashboard.indexTruncated",
    message: "Some sources exceed the index budget. Open execution records for the complete request.",
  },
  loading: { id: "context.dashboard.loading", message: "Loading context…" },
  error: { id: "context.dashboard.error", message: "Could not load context. Try again." },
  noItems: { id: "context.dashboard.noItems", message: "No matching sources." },
} as const
