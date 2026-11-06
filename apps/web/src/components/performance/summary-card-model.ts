import type { PerformanceSummary } from "./types"

export function performanceSummaryCardModel(summary: PerformanceSummary | null | undefined) {
  const resources = summary?.resources
  return {
    openIssueCount: summary?.health.openIssueCount ?? 0,
    serverRssBytes: resources?.rssBytes,
    serviceMemory: resources?.serviceMemory,
    childProcessCount: resources?.childProcessCount ?? 0,
    measuredChildProcessCount: resources?.measuredChildProcessCount ?? 0,
    childProcessRssBytes: resources?.childProcessRssBytes,
  }
}
