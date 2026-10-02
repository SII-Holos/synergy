import type { ExecutionCostPresentation } from "@ericsanchezok/synergy-sdk/client"

export function executionMoney(value: number, currency = "USD", locale = "en") {
  const prefix = currency === "USD" ? "US$" : currency + " "
  if (value > 0 && value < 0.0001) return "< " + prefix + "0.0001"
  return (
    prefix +
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: value >= 0.1 || !value ? 2 : 0,
      maximumFractionDigits: value < 0.01 && value ? 4 : 3,
    }).format(value)
  )
}
export function executionCostText(cost: ExecutionCostPresentation | undefined, locale: string) {
  if (!cost) return "—"
  const reported = cost.reported.map((value) => executionMoney(value.amount, value.currency, locale))
  if (cost.estimates.length) {
    const minimum = cost.estimates.reduce((sum, value) => sum + value.known, 0)
    const maximum = cost.estimates.reduce((sum, value) => sum + value.maximum, 0)
    reported.push(
      "≈ " +
        executionMoney(minimum, "USD", locale) +
        (maximum > minimum ? "–" + executionMoney(maximum, "USD", locale) : ""),
    )
  }
  return reported.length ? (cost.missing ? "≥ " : "") + reported.join(" · ") : "—"
}
