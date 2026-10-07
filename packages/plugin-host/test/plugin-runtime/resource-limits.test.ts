import { expect, spyOn, test } from "bun:test"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"
import { getProcessMemoryMb, startMemoryMonitor } from "../../src/plugin-runtime/resource-limits"

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "memory sampling uses the real asynchronous process inspector and preserves missing samples",
  async () => {
    expect(await getProcessMemoryMb(process.pid)).toBeGreaterThan(0)
    expect(await getProcessMemoryMb(-1)).toBeUndefined()
  },
)

test("memory monitoring skips overlapping queries and cancels its pending sample on stop", async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const pending = Promise.withResolvers<number | undefined>()
  const inspect = spyOn(ProcessInspection, "rssBytes").mockImplementation((_pid, opts) => {
    started.resolve(opts!.signal!)
    return pending.promise
  })
  const samples: number[] = []
  const exceeded: number[] = []
  const monitor = startMemoryMonitor({
    pluginId: "pending-memory-sample",
    pid: process.pid,
    maxMb: 1,
    intervalMs: 5,
    onSample: (currentMb) => samples.push(currentMb),
    onExceed: (currentMb) => exceeded.push(currentMb),
  })
  try {
    const signal = await started.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(inspect).toHaveBeenCalledTimes(1)
    monitor.stop()
    expect(signal.aborted).toBe(true)
    pending.resolve(8 * 1024 * 1024)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(samples).toEqual([])
    expect(exceeded).toEqual([])
  } finally {
    monitor.stop()
    pending.resolve(undefined)
    inspect.mockRestore()
  }
})
