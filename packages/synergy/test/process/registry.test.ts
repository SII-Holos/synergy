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

  test("markExited removes non-backgrounded process", () => {
    const proc = ProcessRegistry.create({ command: "echo hi" })
    // Don't call markBackgrounded
    ProcessRegistry.markExited(proc, 0, null)
    expect(ProcessRegistry.get(proc.id)).toBeUndefined()
    expect(ProcessRegistry.getFinished(proc.id)).toBeUndefined()
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
})
