import { expect, test } from "bun:test"
import { projectOrganizationMessage, projectOrganizationPart } from "../../src/organization/transcript"
import type { OrganizationSyncProtocol as Sync } from "@ericsanchezok/synergy-organization-protocol"
import type { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"

const base = {
  type: "message",
  sequence: 1,
  messageID: "message-one",
  sessionID: "session-one",
  role: "assistant",
  createdAt: 42,
  summary: "Metadata",
  integrity: "a".repeat(64),
} as const
test("shared messages preserve actual actor, model and accounting without inventing legacy values", () => {
  expect(projectOrganizationMessage(base, "session-one")).toBeUndefined()
  const event = {
    ...base,
    parentID: "user-one",
    model: { providerID: "team", modelID: "model" },
    agent: "coding",
    mode: "coding",
    cost: 0.25,
    tokens: { input: 11, output: 22, reasoning: 3, cache: { read: 4, write: 5 } },
    completedAt: 84,
  }
  expect(projectOrganizationMessage(event, "session-one")).toMatchObject({
    id: "message-one",
    parentID: "user-one",
    providerID: "team",
    modelID: "model",
    time: { created: 42, completed: 84 },
    cost: 0.25,
    tokens: event.tokens,
  })
})
test("ordinary tool parts retain identity, non-truncated bodies and observed timing", () => {
  const event: Extract<Sync.Event, { type: "part" }> = {
    type: "part",
    sequence: 2,
    messageID: "message-one",
    partID: "part-one",
    integrity: "a".repeat(64),
    part: {
      type: "tool",
      tool: "organization_knowledge",
      callID: "call-one",
      status: "completed",
      input: { kind: "inline", text: '{"input":{"operation":"read","version":3}}' },
      output: { kind: "inline", text: "Complete output" },
      startedAt: 43,
      completedAt: 80,
      title: "Read guidelines",
      metadata: { operation: "read", itemID: "guidelines", version: 3, path: "notes/guide.md", bytes: 15 },
    },
  }
  const part = projectOrganizationPart(event, "session-one", () => undefined)
  expect(part).toMatchObject({
    id: "part-one",
    messageID: "message-one",
    callID: "call-one",
    tool: "organization_knowledge",
    state: {
      status: "completed",
      input: { input: { operation: "read", version: 3 } },
      output: "Complete output",
      time: { start: 43, end: 80 },
      metadata: { operation: "read", itemID: "guidelines", version: 3, path: "notes/guide.md", bytes: 15 },
    },
  })
  expect(
    projectOrganizationPart(
      {
        ...event,
        part: {
          ...event.part!,
          type: "text",
          content: { kind: "blob", blobID: "body", hash: "b".repeat(64), bytes: 80000, mediaType: "text/plain" },
        },
      },
      "session-one",
      () => undefined,
    ),
  ).toBeUndefined()
  const complete = "z".repeat(80000)
  expect(
    projectOrganizationPart(
      {
        ...event,
        part: {
          type: "text",
          content: { kind: "blob", blobID: "body", hash: "b".repeat(64), bytes: 80000, mediaType: "text/plain" },
        },
      },
      "session-one",
      () => complete,
    ),
  ).toMatchObject({ type: "text", text: complete })
})
test("system text remains system text and removals never become fabricated content", () => {
  const event: Extract<Sync.Event, { type: "part" }> = {
    type: "part",
    sequence: 2,
    messageID: "message-one",
    partID: "part-one",
    integrity: "a".repeat(64),
    part: { type: "text", content: { kind: "inline", text: "System context" }, origin: "system" },
  }
  expect(projectOrganizationPart(event, "session-one", () => undefined)).toMatchObject({
    type: "text",
    origin: "system",
    text: "System context",
  })
  expect(
    projectOrganizationPart({ ...event, part: undefined, removed: true }, "session-one", () => undefined),
  ).toBeUndefined()
})

test("reasoning and step accounting require actual observations and retain their original values", () => {
  const event: Extract<Sync.Event, { type: "part" }> = {
    type: "part",
    sequence: 2,
    messageID: "message-one",
    partID: "part-one",
    integrity: "a".repeat(64),
    part: { type: "reasoning", content: { kind: "inline", text: "Reasoning" } },
  }
  expect(projectOrganizationPart(event, "session-one", () => undefined)).toBeUndefined()
  expect(
    projectOrganizationPart(
      {
        ...event,
        part: { type: "reasoning", content: { kind: "inline", text: "Reasoning" }, time: { start: 5, end: 9 } },
      },
      "session-one",
      () => undefined,
    ),
  ).toMatchObject({ type: "reasoning", text: "Reasoning", time: { start: 5, end: 9 } })
  const tokens = { input: 11, output: 22, reasoning: 3, cache: { read: 4, write: 5 } }
  expect(
    projectOrganizationPart(
      { ...event, part: { type: "step-finish", reason: "stop", cost: 0.25, tokens } },
      "session-one",
      () => undefined,
    ),
  ).toMatchObject({ type: "step-finish", reason: "stop", cost: 0.25, tokens })
  expect(
    projectOrganizationPart(
      { ...event, part: { type: "step-finish", reason: "stop", cost: 0.25 } },
      "session-one",
      () => undefined,
    ),
  ).toBeUndefined()
})

test("private native headers reuse the message projector and retain partial output provenance", () => {
  const native: Read.Part = {
    partID: "native-part",
    messageID: "native-message",
    version: "native-v1",
    part: {
      type: "tool",
      tool: "organization_knowledge",
      callID: "call-native",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      input: { kind: "inline", text: "{}" },
      output: {
        kind: "native",
        version: "native-v1",
        field: "output",
        bytes: 15,
        sha256: "a".repeat(64),
        original: "partial",
      },
    },
  }
  const part = projectOrganizationPart(native, "native-session", () => "Retained output")
  expect(part).toMatchObject({
    id: "native-part",
    sessionID: "native-session",
    state: { status: "completed", output: "Retained output", outputTruncated: true },
  })
  const nativeMessage: Read.Message = {
    messageID: "native-message",
    version: "message-v1",
    order: "0001",
    role: "user",
    createdAt: 1,
    summary: "",
    model: { providerID: "team", modelID: "model" },
    agent: "general",
  }
  expect(projectOrganizationMessage(nativeMessage, "native-session")).toMatchObject({
    id: "native-message",
    role: "user",
    time: { created: 1 },
  })
})
