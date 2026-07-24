import { describe, expect, test, beforeEach } from "bun:test"
import { ProcessRegistry } from "../../src/process/registry"

beforeEach(() => {
  ProcessRegistry.reset()
})

describe("ProcessRegistry.appendOutput", () => {
  test("accumulates chunks into output", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    ProcessRegistry.appendOutput(proc, "hello ")
    ProcessRegistry.appendOutput(proc, "world")
    expect(proc.output).toBe("hello world")
    expect(proc.truncated).toBe(false)
  })

  test("truncates to last MAX_OUTPUT_CHARS when exceeded", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    // MAX_OUTPUT_CHARS is 200_000
    const chunk = "x".repeat(150_000)
    ProcessRegistry.appendOutput(proc, chunk)
    expect(proc.output.length).toBe(150_000)
    expect(proc.truncated).toBe(false)

    // Append another chunk that pushes over the limit
    ProcessRegistry.appendOutput(proc, chunk)
    expect(proc.output.length).toBeLessThanOrEqual(200_000)
    expect(proc.truncated).toBe(true)
    // The kept output should be the tail (most recent data)
    expect(proc.output.endsWith("x")).toBe(true)
  })

  test("tail stays within TAIL_CHARS limit", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    ProcessRegistry.appendOutput(proc, "a".repeat(5000))
    expect(proc.tail.length).toBeLessThanOrEqual(2000)
    expect(proc.tail).toBe("a".repeat(2000))
  })

  test("handles many small chunks without data loss before cap", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    const chunkCount = 1000
    for (let i = 0; i < chunkCount; i++) {
      ProcessRegistry.appendOutput(proc, `line ${i}\n`)
    }
    // All lines should be present (total is well under 200K)
    const lines = proc.output.trim().split("\n")
    expect(lines.length).toBe(chunkCount)
    expect(lines[0]).toBe("line 0")
    expect(lines[chunkCount - 1]).toBe(`line ${chunkCount - 1}`)
  })

  test("sliding window preserves most recent data", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    // Fill to near capacity with "old" data
    ProcessRegistry.appendOutput(proc, "OLD_".repeat(50_000)) // 200K chars
    // Now append "new" data that pushes old data out
    const newData = "NEW_DATA_MARKER"
    ProcessRegistry.appendOutput(proc, newData)
    expect(proc.output).toContain(newData)
    expect(proc.truncated).toBe(true)
  })

  test("coalesces micro-chunks into a bounded number of output segments", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    for (let index = 0; index < 50_000; index++) ProcessRegistry.appendOutput(proc, "x")

    expect(proc.output).toBe("x".repeat(50_000))
    expect(ProcessRegistry.outputBufferStats(proc).segments).toBeLessThan(32)
  })

  test("releases fully consumed output segments", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    proc.maxOutputChars = 0

    ProcessRegistry.appendOutput(proc, "x".repeat(4096))

    expect(ProcessRegistry.outputBufferStats(proc).allocatedSegments).toBe(0)
  })

  test("maintains the exact retained window and tail after micro-chunks exceed capacity", () => {
    const proc = ProcessRegistry.create({ command: "test" })
    const chunks: string[] = []
    for (let index = 0; index < 2_500; index++) {
      const chunk = `line_${String(index).padStart(6, "0")}_${"x".repeat(84)}\n`
      chunks.push(chunk)
      ProcessRegistry.appendOutput(proc, chunk)
    }
    const expected = chunks.join("").slice(-200_000)

    expect(proc.output).toBe(expected)
    expect(proc.tail).toBe(expected.slice(-2_000))
    expect(proc.truncated).toBe(true)
  })
})

describe("ProcessRegistry lifecycle", () => {
  test("create and remove", () => {
    const proc = ProcessRegistry.create({ command: "echo hi" })
    expect(ProcessRegistry.get(proc.id)).toBeDefined()
    ProcessRegistry.remove(proc.id)
    expect(ProcessRegistry.get(proc.id)).toBeUndefined()
  })

  test("markExited moves backgrounded process to finished", () => {
    const proc = ProcessRegistry.create({ command: "echo hi" })
    ProcessRegistry.markBackgrounded(proc)
    ProcessRegistry.markExited(proc, 0, null)
    expect(ProcessRegistry.get(proc.id)).toBeUndefined()
    const finished = ProcessRegistry.getFinished(proc.id)
    expect(finished).toBeDefined()
    expect(finished!.status).toBe("completed")
  })

  test("markExited always persists into the finished registry", () => {
    const proc = ProcessRegistry.create({ command: "echo hi" })
    // Don't call markBackgrounded — a fast-exiting process may finish before
    // the auto-background timer fires. It should still be findable via
    // getFinished so callers don't race the exit.
    ProcessRegistry.markExited(proc, 0, null)
    expect(ProcessRegistry.get(proc.id)).toBeUndefined()
    expect(ProcessRegistry.getFinished(proc.id)!.status).toBe("completed")
  })

  test("failed exit code produces failed status", () => {
    const proc = ProcessRegistry.create({ command: "false" })
    ProcessRegistry.markBackgrounded(proc)
    ProcessRegistry.markExited(proc, 1, null)
    const finished = ProcessRegistry.getFinished(proc.id)
    expect(finished!.status).toBe("failed")
  })

  test("SIGKILL produces killed status", () => {
    const proc = ProcessRegistry.create({ command: "sleep" })
    ProcessRegistry.markBackgrounded(proc)
    ProcessRegistry.markExited(proc, null, "SIGKILL")
    const finished = ProcessRegistry.getFinished(proc.id)
    expect(finished!.status).toBe("killed")
  })
  test("uses an owned process-tree terminator before the child fallback", async () => {
    const proc = ProcessRegistry.create({ command: "owned child" })
    let terminated = 0
    ProcessRegistry.setTerminator(proc, () => {
      terminated++
    })

    await ProcessRegistry.terminate(proc)

    expect(terminated).toBe(1)
  })

  test("resource snapshot reports inspected child process RSS", () => {
    const restore = ProcessRegistry.setProcessInspector(() => ({ alive: true, rssBytes: 4096 }))
    const proc = ProcessRegistry.create({ command: "node server.js" })
    proc.pid = 1234
    ProcessRegistry.markBackgrounded(proc)

    const snapshot = ProcessRegistry.resourceSnapshot({ now: proc.startedAt + 1000 })

    restore()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({
      id: proc.id,
      pid: 1234,
      command: "node server.js",
      backgrounded: true,
      ageMs: 1000,
      alive: true,
      rssBytes: 4096,
    })
  })

  test("settleStaleProcesses moves missing child processes to finished", () => {
    const restore = ProcessRegistry.setProcessInspector(() => ({ alive: false }))
    const proc = ProcessRegistry.create({ command: "missing child" })
    proc.pid = 999999
    ProcessRegistry.markBackgrounded(proc)

    ProcessRegistry.settleStaleProcesses()

    restore()
    expect(ProcessRegistry.get(proc.id)).toBeUndefined()
    expect(ProcessRegistry.getFinished(proc.id)?.status).toBe("failed")
  })
})
