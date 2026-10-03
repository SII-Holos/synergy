import { executionBatches } from "../../packages/testing/script/run"
import { batchKind, estimateBatch, timingProfile, type Timings } from "./timing"

export function partitionSuite(
  files: string[],
  root: string,
  count: number,
  times: Timings,
  owner: string,
  batchShards = 4,
): string[][] {
  const batches = executionBatches(files, root, batchShards).map((batch) => ({
    files: batch.files,
    seconds: estimateBatch(times, timingProfile("linux", "x64"), owner, batch.files, batchKind(batch.files, root)),
  }))
  const partitions = Array.from({ length: count }, (_, index) => ({ index, seconds: 0, files: [] as string[] }))
  for (const batch of batches.toSorted((a, b) => b.seconds - a.seconds || a.files[0]!.localeCompare(b.files[0]!))) {
    const target = partitions.toSorted((a, b) => a.seconds - b.seconds || a.index - b.index)[0]!
    target.files.push(...batch.files)
    target.seconds += batch.seconds
  }
  return partitions.map((partition) => partition.files.toSorted()).filter((files) => files.length)
}

export function suiteSeconds(files: string[], root: string, times: Timings, owner: string, batchShards = 4) {
  return executionBatches(files, root, batchShards).reduce(
    (sum, batch) =>
      sum + estimateBatch(times, timingProfile("linux", "x64"), owner, batch.files, batchKind(batch.files, root)),
    0,
  )
}
