import { expect, test } from "bun:test"
import {
  OrganizationCommandStream as Stream,
  OrganizationRuntimeProtocol as Runtime,
  type OrganizationDesktop as Desktop,
} from "@ericsanchezok/synergy-organization-protocol"
import { createDesktopOrganizationClient, desktopOrganizationFetch } from "../../src/organization/desktop"

const connection: Desktop.Connection = {
  id: "a".repeat(64),
  issuer: "https://organization.example",
  orgID: "org",
  deploymentIncarnation: "deployment",
  clientID: "desktop",
  state: "ready",
  account: {
    accountID: "account",
    orgID: "org",
    loginName: "owner",
    displayName: "Owner",
    role: "owner",
    state: "active",
    revision: 0,
    authRevision: 0,
    createdAt: 1,
  },
}
function fixture() {
  const requests: Desktop.Request[] = []
  const cancelled: string[] = []
  const bridge: Desktop.Bridge = {
    list: async () => ({ ok: true, value: [connection] }),
    connect: async () => ({ ok: true, value: connection }),
    signOut: async () => ({ ok: true, value: { ...connection, state: "signed_out" } }),
    memberStatus: async () => ({ ok: true, value: { connectionID: connection.id, state: "stopped" } }),
    startMember: async () => ({ ok: false, error: { code: "unavailable" } }),
    download: async () => ({ ok: false, error: { code: "unavailable" } }),
    projectBinding: async () => ({ ok: false, error: { code: "unavailable" } }),
    bindProject: async () => ({ ok: false, error: { code: "unavailable" } }),
    memberRequest: async () => ({ ok: false, error: { code: "unavailable" } }),
    downloadContent: async () => ({ ok: false, error: { code: "unavailable" } }),
    downloadAttachment: async () => ({ ok: false, error: { code: "unavailable" } }),
    commandStream: async () => ({ ok: false, error: { code: "unavailable" } }),
    cancel: async (input) => {
      cancelled.push(input.requestID)
      return { ok: true, value: undefined }
    },
    request: async (request) => {
      requests.push(request)
      return { ok: true, value: { status: 200, body: JSON.stringify({ items: [] }) } }
    },
  }
  return { bridge, requests, cancelled }
}

test("the organization SDK uses an identity-bound native fetch without exposing bearer credentials", async () => {
  const f = fixture()
  const client = createDesktopOrganizationClient(f.bridge, connection)
  expect((await client.orgProjects.list({ limit: 10 }, { throwOnError: true })).data).toEqual({ items: [] })
  expect(f.requests[0]).toMatchObject({ connectionID: connection.id, method: "GET", path: "/org/v1/projects?limit=10" })
  await client.orgProjects.create({ orgProjectCreate: { name: "Team project" } })
  expect(f.requests[1]).toMatchObject({ connectionID: connection.id, method: "POST", body: '{"name":"Team project"}' })
  expect(f.requests[0]!.requestID).not.toBe(f.requests[1]!.requestID)
  expect(JSON.stringify(f.requests)).not.toContain("authorization")
})

test("the native fetch rejects cross-organization targets, caller credentials and non-JSON request bodies", async () => {
  const f = fixture()
  const native = desktopOrganizationFetch(f.bridge, connection)
  for (const [url, init] of [
    ["https://other.example/org/v1/projects", undefined],
    ["https://organization.example/org/v1/projects#private", undefined],
    ["https://organization.example/org/v1/projects", { headers: { authorization: "Bearer injected" } }],
    ["https://organization.example/org/v1/projects", { headers: { cookie: "injected" } }],
    ["https://organization.example/org/v1/projects", { method: "POST", body: "x".repeat(65_537) }],
  ] as const)
    await expect(native(url, init), JSON.stringify({ url, init: init && Object.keys(init) })).rejects.toMatchObject({
      code: "invalid_request",
    })
  expect(f.requests).toHaveLength(0)
})

test("native request cancellation reaches main and cannot return a late response to a new view", async () => {
  const f = fixture()
  const started = Promise.withResolvers<void>()
  const result = Promise.withResolvers<Desktop.Result<Desktop.Response>>()
  f.bridge.request = async (request) => {
    f.requests.push(request)
    started.resolve()
    return result.promise
  }
  const native = desktopOrganizationFetch(f.bridge, connection)
  const controller = new AbortController()
  const pending = native(`${connection.issuer}/org/v1/projects`, { signal: controller.signal })
  const failed = pending.catch((error: unknown) => error)
  await started.promise
  controller.abort()
  result.resolve({ ok: true, value: { status: 200, body: "{}" } })
  expect(await failed).toMatchObject({ name: "AbortError" })
  expect(f.cancelled).toEqual([f.requests[0]!.requestID])
})

test("native API errors preserve their status and payload while bridge errors remain structured", async () => {
  const f = fixture()
  const body = {
    code: "PERMISSION_DENIED",
    message: "Permission denied",
    outcome: "not_dispatched",
    retryable: false,
  } as const
  f.bridge.request = async () => ({ ok: true, value: { status: 403, body: JSON.stringify(body) } })
  const client = createDesktopOrganizationClient(f.bridge, connection)
  const response = await client.orgProjects.list()
  expect(response.response.status).toBe(403)
  expect(response.error).toEqual(body)
  f.bridge.request = async () => ({ ok: false, error: { code: "revocation_pending" } })
  await expect(
    desktopOrganizationFetch(f.bridge, connection)(`${connection.issuer}/org/v1/projects`),
  ).rejects.toMatchObject({ code: "revocation_pending" })
})

test("native content transfers preserve binary bytes, bounded ranges and cancellation", async () => {
  const f = fixture()
  const bytes = new Uint8Array([0, 255, 128, 10])
  f.bridge.request = async (request) => {
    f.requests.push(request)
    return {
      ok: true,
      value: { status: 206, bodyBytes: bytes, contentType: "application/octet-stream", contentRange: "bytes 0-3/8" },
    }
  }
  const native = desktopOrganizationFetch(f.bridge, connection)
  const response = await native(`${connection.issuer}/org/v1/sessions/session/blobs/${"b".repeat(64)}/content`, {
    headers: { Range: "bytes=0-3" },
  })
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(response.headers.get("content-range")).toBe("bytes 0-3/8")
  expect(f.requests[0]?.range).toBe("bytes=0-3")
  await native(`${connection.issuer}/org/v1/sessions/session/blobs/${"b".repeat(64)}?offset=0&totalBytes=4`, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "application/octet-stream" },
  })
  expect(f.requests[1]?.bodyBytes).toEqual(bytes)
  expect(f.requests[1]?.body).toBeUndefined()
  await expect(
    native(`${connection.issuer}/org/v1/projects`, { headers: { Range: "bytes=0-4194304" } }),
  ).rejects.toMatchObject({ code: "invalid_request" })
})

test("the generated SDK streams canonical command bodies beyond one IPC frame while keeping the original logical identity", async () => {
  const f = fixture()
  const frames: Stream.Frame[] = []
  const chunks: Uint8Array[] = []
  f.bridge.commandStream = async (frame) => {
    frames.push(frame)
    if (frame.type === "finish")
      return {
        ok: true,
        value: {
          kind: "response",
          requestID: frame.requestID,
          response: { status: 202, body: JSON.stringify({ original: true }) },
        },
      }
    if (frame.type === "chunk") {
      const bytes = new Uint8Array(Buffer.from(frame.data, "base64url"))
      chunks.push(bytes)
      return {
        ok: true,
        value: { kind: "progress", requestID: frame.requestID, nextOffset: frame.offset + bytes.byteLength },
      }
    }
    return { ok: true, value: { kind: "progress", requestID: frame.requestID, nextOffset: 0 } }
  }
  const command = {
    schemaVersion: 1,
    orgID: connection.orgID,
    requestID: "logical-one",
    sessionID: "session-one",
    projectID: "project-one",
    runtimeID: "runtime-one",
    input: { operation: "input", mode: "task", parts: [{ type: "text", text: "汉字🙂".repeat(20_000) }] },
  } as const
  const client = createDesktopOrganizationClient(f.bridge, connection)
  const result = await client.orgCommands.input(
    {
      sessionID: command.sessionID,
      orgCommandInputRequest: { ...command, input: { ...command.input, parts: [...command.input.parts] } },
    },
    { throwOnError: true },
  )
  const responseBody: unknown = result.data
  expect(responseBody).toEqual({ original: true })
  expect(frames[0]).toMatchObject({ type: "begin", header: { requestID: "logical-one" } })
  expect(frames[0]?.requestID).not.toBe("logical-one")
  expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(command.input)
  expect(
    frames
      .filter((frame) => frame.type === "chunk")
      .every((frame) => Buffer.from(frame.data, "base64url").byteLength <= Runtime.commandChunkBytes),
  ).toBe(true)
  expect(f.requests).toHaveLength(0)
})
