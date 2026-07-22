export namespace ProcessMemory {
  export type HeapUsageRatio =
    | { available: true; ratio: number }
    | { available: false; reason: "missing_values" | "invariant_violated" | "runtime_accounting_unstable" }

  export function heapUsageRatio(
    input: { heapUsedBytes?: number; heapTotalBytes?: number },
    runtime: { runtime: "bun" | "node"; version: string } = currentRuntime(),
  ): HeapUsageRatio {
    const heapUsed = input.heapUsedBytes
    const heapTotal = input.heapTotalBytes
    if (heapUsed === undefined || heapTotal === undefined || heapTotal <= 0) {
      return { available: false, reason: "missing_values" }
    }
    if (runtime.runtime === "bun") return { available: false, reason: "runtime_accounting_unstable" }
    if (heapUsed < 0 || heapUsed > heapTotal) return { available: false, reason: "invariant_violated" }
    return { available: true, ratio: heapUsed / heapTotal }
  }

  function currentRuntime(): { runtime: "bun" | "node"; version: string } {
    return typeof Bun === "undefined"
      ? { runtime: "node", version: process.versions.node }
      : { runtime: "bun", version: Bun.version }
  }
}
