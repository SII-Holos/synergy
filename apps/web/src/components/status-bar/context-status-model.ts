export async function openContextPanel(input: {
  sessionID: string | undefined
  openPanel: (panelID: string, options: { reuseExisting: boolean }) => Promise<unknown> | unknown
}) {
  if (!input.sessionID) return false
  await input.openPanel("context", { reuseExisting: true })
  return true
}

export function contextStatusAriaLabel(input: {
  exactInputTokens: number | null
  contextPercentage: number | null
  formatNumber: (value: number) => string
  formatPercent: (value: number) => string
  usageUnavailable: string
  formatUsage: (percent: string) => string
  formatLabel: (tokens: string, usage: string) => string
}) {
  const tokens = input.exactInputTokens === null ? "—" : input.formatNumber(input.exactInputTokens)
  const usage =
    input.contextPercentage === null
      ? input.usageUnavailable
      : input.formatUsage(input.formatPercent(input.contextPercentage / 100))
  return input.formatLabel(tokens, usage)
}
