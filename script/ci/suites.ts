import { executionBatches } from "../../packages/testing/script/run"

export function partitionSuite(
  files: string[],
  root: string,
  count: number,
  times: Record<string, number>,
  owner: string,
  batchShards = 4,
): string[][] {
  const batches = executionBatches(files, root, batchShards).map((batch) => ({
    files: batch.files,
    seconds: batch.files.reduce((sum, file) => sum + (times[`${owner}/${file}`] ?? 2), 0),
  }))
  const partitions = Array.from({ length: count }, (_, index) => ({ index, seconds: 0, files: [] as string[] }))
  for (const batch of batches.toSorted((a, b) => b.seconds - a.seconds || a.files[0]!.localeCompare(b.files[0]!))) {
    const target = partitions.toSorted((a, b) => a.seconds - b.seconds || a.index - b.index)[0]!
    target.files.push(...batch.files)
    target.seconds += batch.seconds
  }
  return partitions.map((partition) => partition.files.toSorted()).filter((files) => files.length)
}
