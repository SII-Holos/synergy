import { describe, expect, test } from "bun:test"
import { serialize } from "v8"
import { PolicyWorkerProtocol } from "../../src/enforcement/policy-worker/protocol"
import type { PolicyClassificationInput } from "../../src/enforcement/policy-worker/protocol"

// The runner registers a process.on("message") listener at import time.
const runner = await import("../../src/enforcement/policy-worker/runner")

function input(): PolicyClassificationInput {
  return {
    context: {
      activeWorkspace: "/tmp/workspace",
      workspaceType: "git",
      registeredMcpTools: [],
      registeredPluginTools: [],
      pluginToolCapabilities: {},
    },
    toolName: "bash",
    args: { command: "echo hello" },
  }
}

function emitMessage(payload: unknown) {
  const emitter = process as unknown as { emit(event: string, payload: unknown): boolean }
  emitter.emit("message", payload)
}
function wireMessages(sent: unknown[]): void {
  process.send = ((message: unknown) => {
    sent.push(message)
  }) as never
}

function unwireMessages() {
  process.send = undefined
}

describe("policy worker runner", () => {
  test("module loads and registers a message handler", () => {
    expect(runner).toBeDefined()
  })

  test("responds pong to ping", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    emitMessage({ type: "ping" })
    expect(sent.some((m) => (m as { type?: string }).type === "pong")).toBe(true)
    unwireMessages()
  })

  test("rejects malformed messages with a serialized error", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    emitMessage({ type: "not-a-real-type", requestId: "r1" })
    const error = sent.find((m) => (m as { type?: string }).type === "error")
    expect(error).toMatchObject({ requestId: "r1" })
    expect((error as { error: { message: string } }).error.message).toContain("Invalid Policy worker protocol message")
    unwireMessages()
  })

  test("rejects an orphan run-chunk with a chunk sequence error", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    emitMessage({ type: "run-chunk", requestId: "r2", index: 0, data: new Uint8Array([1]) })
    const error = sent.find((m) => (m as { type?: string }).type === "error")
    expect(error).toMatchObject({ requestId: "r2" })
    expect((error as { error: { message: string } }).error.message).toContain("chunk sequence")
    unwireMessages()
  })

  test("handles run-start then cancel", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    emitMessage({ type: "run-start", requestId: "r3", totalBytes: 4, chunkCount: 1 })
    expect(sent.some((m) => (m as { type?: string }).type === "run-ready")).toBe(true)
    emitMessage({ type: "cancel", requestId: "r3" })
    const error = sent.find((m) => (m as { type?: string }).type === "error")
    expect((error as { error: { message: string } }).error.message).toContain("aborted")
    unwireMessages()
  })

  test("rejects a run-commit for an incomplete transfer", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    emitMessage({ type: "run-start", requestId: "r4", totalBytes: 8, chunkCount: 2 })
    emitMessage({ type: "run-commit", requestId: "r4" })
    const error = sent.find((m) => (m as { type?: string }).type === "error")
    expect((error as { error: { message: string } }).error.message).toContain("Incomplete Policy request transfer")
    unwireMessages()
  })

  test("classifies a full request transfer in-process", async () => {
    const sent: unknown[] = []
    wireMessages(sent)
    const bytes = PolicyWorkerProtocol.serializeInput(input())
    const chunkCount = Math.ceil(bytes.byteLength / PolicyWorkerProtocol.REQUEST_CHUNK_BYTES)
    const totalBytes = bytes.byteLength
    emitMessage({ type: "run-start", requestId: "r5", totalBytes, chunkCount })
    const buffer = Buffer.from(bytes)
    for (let index = 0; index < chunkCount; index++) {
      const data = new Uint8Array(
        buffer.subarray(
          index * PolicyWorkerProtocol.REQUEST_CHUNK_BYTES,
          (index + 1) * PolicyWorkerProtocol.REQUEST_CHUNK_BYTES,
        ),
      )
      emitMessage({ type: "run-chunk", requestId: "r5", index, data })
    }
    emitMessage({ type: "run-commit", requestId: "r5" })
    await Bun.sleep(50)
    const result = sent.find((m) => (m as { type?: string }).type === "result")
    expect(result).toBeDefined()
    expect((result as { result: { capabilities: unknown[] } }).result.capabilities).toEqual(expect.any(Array))
    unwireMessages()
  })

  test("busy worker rejects a second concurrent transfer", () => {
    const sent: unknown[] = []
    wireMessages(sent)
    const bytes = PolicyWorkerProtocol.serializeInput(input())
    const chunkCount = Math.ceil(bytes.byteLength / PolicyWorkerProtocol.REQUEST_CHUNK_BYTES)
    emitMessage({ type: "run-start", requestId: "busy-1", totalBytes: bytes.byteLength, chunkCount })
    emitMessage({ type: "run-start", requestId: "busy-2", totalBytes: bytes.byteLength, chunkCount })
    const error = sent.find(
      (m) => (m as { type?: string }).type === "error" && (m as { requestId: string }).requestId === "busy-2",
    )
    expect((error as { error: { message: string } }).error.message).toContain("already owns a request transfer")
    unwireMessages()
  })
})

test("serialize and deserialize round-trip through the protocol", () => {
  const bytes = PolicyWorkerProtocol.serializeInput(input())
  const roundTrip = PolicyWorkerProtocol.deserializeInput(bytes)
  expect(roundTrip.toolName).toBe("bash")
  expect(roundTrip.args).toEqual({ command: "echo hello" })
  expect(serialize(roundTrip).byteLength).toBeGreaterThan(0)
})

test("serializeError keeps structured names and truncates non-errors", () => {
  expect(PolicyWorkerProtocol.serializeError(new DOMException("aborted", "AbortError"))).toEqual({
    name: "AbortError",
    message: "aborted",
  })
  expect(PolicyWorkerProtocol.serializeError("plain text")).toEqual({ name: "Error", message: "plain text" })
  expect(PolicyWorkerProtocol.deserializeError({ name: "Custom", message: "m" })).toBeInstanceOf(Error)
})
