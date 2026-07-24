type ConcurrencyPressureStatus = {
  configured: number | null
  environment: number | null
  effective: number
  memoryPressureLimit: number | null
}

export function concurrencyPressureState(
  status: ConcurrencyPressureStatus | undefined,
): { managed: boolean; value: string } | undefined {
  if (!status || status.memoryPressureLimit === null) return
  const configuredMaximum = status.environment ?? status.configured ?? 8
  if (status.memoryPressureLimit >= configuredMaximum || status.effective !== status.memoryPressureLimit) return

  return {
    managed: status.environment !== null,
    value: String(status.memoryPressureLimit),
  }
}
