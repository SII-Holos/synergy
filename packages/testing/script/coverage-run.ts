export * from "./batches"
export { runCoverageBatch as runBatch } from "./run"
import { runTests } from "./run"

export async function main() {
  process.exitCode = await runTests({ coverage: true })
}

if (import.meta.main) await main()
