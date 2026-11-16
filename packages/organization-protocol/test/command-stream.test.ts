import { expect, test } from "bun:test"
import { OrganizationCommandStream as Stream } from "../src/command-stream"
import { OrganizationCommandProtocol as Command } from "../src/command"
import { OrganizationRuntimeProtocol as Runtime } from "../src/runtime"

const target = {
  schemaVersion: 1,
  orgID: "org-one",
  requestID: "logical-one",
  sessionID: "session-one",
  projectID: "project-one",
  runtimeID: "runtime-one",
} as const
test("desktop command chunks keep their IPC nonce separate from the original logical command and preserve UTF-8 bytes", () => {
  const request = {
    ...target,
    decision: {
      operation: "decision",
      kind: "question",
      requestID: "native-one",
      reply: "answer",
      answers: [["汉字🙂".repeat(20_000)]],
    },
  } satisfies Command.DecisionRequest
  const encoded = Stream.serialize(request)
  expect(encoded.payload.byteLength).toBeGreaterThan(65_536)
  expect(encoded.header.requestID).toBe("logical-one")
  const begin = Stream.Begin.parse({
    type: "begin",
    requestID: "ipc-one",
    connectionID: "a".repeat(64),
    operation: encoded.operation,
    header: encoded.header,
    bytes: encoded.payload.byteLength,
    sha256: "b".repeat(64),
  })
  expect(begin.requestID).toBe("ipc-one")
  const collected: number[] = []
  for (let offset = 0; offset < encoded.payload.byteLength; offset += Runtime.commandChunkBytes) {
    const frame = Stream.Chunk.parse({
      type: "chunk",
      requestID: begin.requestID,
      connectionID: begin.connectionID,
      offset,
      data: Stream.encodeChunk(encoded.payload.subarray(offset, offset + Runtime.commandChunkBytes)),
    })
    expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThan(65_536)
    collected.push(...Buffer.from(frame.data, "base64url"))
  }
  expect(new Uint8Array(collected)).toEqual(encoded.payload)
})
test("only canonical input or decision payloads can use the typed stream", () => {
  const encoded = Stream.serialize({
    ...target,
    input: { operation: "input", mode: "task", parts: [{ type: "text", text: "x".repeat(100_000) }] },
  })
  expect(encoded.operation).toBe("input")
  expect(
    Stream.Frame.safeParse({
      type: "begin",
      requestID: "ipc-one",
      connectionID: "a".repeat(64),
      operation: "pause",
      header: target,
      bytes: 1,
      sha256: "b".repeat(64),
    }).success,
  ).toBe(false)
  expect(
    Stream.Begin.safeParse({
      type: "begin",
      requestID: "ipc-one",
      connectionID: "a".repeat(64),
      operation: "decision",
      header: target,
      bytes: Command.decisionByteLimit + 1,
      sha256: "b".repeat(64),
    }).success,
  ).toBe(false)
  expect(() =>
    Stream.serialize({
      ...target,
      decision: {
        operation: "decision",
        kind: "question",
        requestID: "native-one",
        reply: "answer",
        answers: [["x".repeat(Command.decisionByteLimit)]],
      },
    }),
  ).toThrow()
})
