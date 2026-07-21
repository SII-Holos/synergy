export function isIterationBudgetExhausted(attempts: number, maxIterations: number | undefined): boolean {
  return maxIterations !== undefined && attempts >= maxIterations
}
