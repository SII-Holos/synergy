export function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

export function accountedCost(
  cost: number,
  accounting?: {
    apiEstimate: { known: number; unknown: number }
    legacy: { cost: number; messages: number }
  },
): number | undefined {
  if (cost === 0 && accounting?.apiEstimate.unknown && !accounting.apiEstimate.known && !accounting.legacy.messages)
    return undefined
  return cost
}

export function formatCost(n: number): string {
  if (n === 0) return "$0.00"
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K"
  if (n >= 1) return "$" + n.toFixed(2)
  if (Math.abs(n) >= 0.01) return "$" + n.toFixed(2)
  const digits = Math.min(12, Math.max(4, Math.ceil(-Math.log10(Math.abs(n))) + 1))
  return "$" + n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "")
}
