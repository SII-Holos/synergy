import { expect, test } from "bun:test"
import { randomBytes, createHash } from "node:crypto"
import { DesktopOrganizationAuthorization } from "../src/organization/authorization"
import { DesktopOrganizationIPC } from "../src/organization/ipc"
import { organizationFixture } from "./fixture/organization"
import { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"

async function setup(
  options: {
    content?: Uint8Array
    attachment?: Uint8Array
    remote?: boolean
    nativeDelayMs?: number
    requestTimeoutMs?: number
    transferIdleMs?: number
    saveFile?: ConstructorParameters<typeof DesktopOrganizationIPC>[0]["saveFile"]
  } = {},
) {
  const f = await organizationFixture()
  try {
    const verifier = randomBytes(32).toString("base64url")
    const request = {
      issuer: f.info.issuer,
      orgID: f.info.orgID,
      deploymentIncarnation: f.info.deploymentIncarnation,
      clientID: "desktop",
      redirectUri: "synergy://organization-auth/callback",
      state: randomBytes(32).toString("base64url"),
      codeChallengeMethod: "S256" as const,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    }
    const code = await f.consent(request)
    const exchanged = await f.api.orgAuth.exchange(
      {
        orgCodeExchangeInput: {
          issuer: f.info.issuer,
          orgID: f.info.orgID,
          deploymentIncarnation: f.info.deploymentIncarnation,
          clientID: "desktop",
          redirectUri: request.redirectUri,
          code: code.code,
          verifier,
        },
      },
      { throwOnError: true },
    )
    const connection = await f.accounts.accept(exchanged.data)
    const state = { epoch: 1, nativeEpoch: 1, creatorID: connection.account.accountID, conflict: false, hold: false }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const queries: Read.Query[] = []
    const binding = () => ({
      schemaVersion: 1 as const,
      orgID: connection.orgID,
      projectID: "project-a",
      creatorID: state.creatorID,
      driverRuntimeID: "runtime-a",
      bindingEpoch: state.epoch,
    })
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        if (url.origin === "http://127.0.0.1:43210" || url.pathname === "/org/v1/sessions/session-a/read") {
          if (options.remote) {
            expect(url.origin).toBe(f.info.issuer)
            expect(request.headers.get("authorization")).toMatch(/^Bearer /)
            expect(request.headers.get("authorization")).not.toBe("Bearer private-member-credential")
          } else {
            expect(request.headers.get("authorization")).toBe("Bearer private-member-credential")
            expect(url.pathname).toBe("/organization/session/read")
          }
          const query = Read.Query.parse(await request.json())
          queries.push(query)
          if (options.nativeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.nativeDelayMs))
          const content = options.content
          const contentHash = content && createHash("sha256").update(content).digest("hex")
          const attachment = options.attachment
          const attachmentHash = attachment && createHash("sha256").update(attachment).digest("hex")
          const value = Read.Result.parse(
            attachment && query.operation === "attachmentContent"
              ? {
                  operation: "attachmentContent",
                  state: "ready",
                  rootSessionID: query.rootSessionID,
                  sourceSessionID: query.sourceSessionID ?? query.rootSessionID,
                  binding: { ...binding(), bindingEpoch: state.nativeEpoch },
                  messageID: query.messageID,
                  partID: query.partID,
                  reference: {
                    kind: "attachment",
                    version: "attachment-v1",
                    filename: "evidence.bin",
                    mediaType: "application/octet-stream",
                    bytes: attachment.length,
                    sha256: attachmentHash,
                  },
                  chunk: {
                    offset: query.offset,
                    nextOffset: Math.min(attachment.length, query.offset + query.length),
                    totalBytes: attachment.length,
                    sha256: attachmentHash,
                    data: Buffer.from(attachment.slice(query.offset, query.offset + query.length)).toString(
                      "base64url",
                    ),
                    complete: query.offset + query.length >= attachment.length,
                  },
                }
              : content && query.operation === "partContent"
                ? {
                    operation: "partContent",
                    state: "ready",
                    rootSessionID: query.rootSessionID,
                    sourceSessionID: query.sourceSessionID ?? query.rootSessionID,
                    binding: { ...binding(), bindingEpoch: state.nativeEpoch },
                    value: {
                      messageID: query.messageID,
                      partID: query.partID,
                      version: "native-v1",
                      part: {
                        type: "text",
                        content: {
                          kind: "native",
                          version: "native-v1",
                          field: "text",
                          bytes: content.length,
                          sha256: contentHash,
                          original: "partial",
                        },
                      },
                    },
                    chunk: {
                      field: "text",
                      offset: query.offset,
                      nextOffset: Math.min(content.length, query.offset + query.length),
                      totalBytes: content.length,
                      sha256: contentHash,
                      original: "partial",
                      data: Buffer.from(content.slice(query.offset, query.offset + query.length)).toString("base64url"),
                      complete: query.offset + query.length >= content.length,
                    },
                  }
                : {
                    operation: "status",
                    rootSessionID: "session-a",
                    sourceSessionID: "session-a",
                    binding: { ...binding(), bindingEpoch: state.nativeEpoch },
                    status: { type: "idle", observedAt: 1, controlVersion: 0 },
                  },
          )
          if (state.hold) {
            entered.resolve()
            await release.promise
          }
          return state.conflict
            ? Response.json(
                {
                  code: "REVISION_CONFLICT",
                  message: "/private/path changed",
                  outcome: "not_dispatched",
                  retryable: false,
                },
                { status: 409 },
              )
            : Response.json(value)
        }
        if (url.pathname === "/org/v1/sessions/session-a")
          return Response.json({
            sessionID: "session-a",
            projectID: "project-a",
            creatorID: state.creatorID,
            driverRuntimeID: "runtime-a",
            bindingEpoch: state.epoch,
            createdAt: 0,
            shareState: "private",
            resourceIDs: [],
            permissions: { read: true, execute: false, stop: false },
          })
        if (url.pathname === "/org/v1/runtimes/runtime-a")
          return Response.json({
            runtimeID: "runtime-a",
            orgID: f.info.orgID,
            deploymentIncarnation: f.info.deploymentIncarnation,
            accountID: connection.account.accountID,
            runtimeKind: "member",
            deviceID: "device-a",
            publicKey: "a".repeat(64),
            state: "active",
            revision: 1,
            connectionEpoch: 1,
            createdAt: 0,
          })
        return f.transport(request)
      },
      { preconnect() {} },
    )
    const trusted = {}
    const authorization = new DesktopOrganizationAuthorization({
      accounts: f.accounts,
      fetch: transport,
      openExternal: async () => {},
    })
    const ipc = new DesktopOrganizationIPC({
      accounts: f.accounts,
      authorization,
      fetch: transport,
      saveFile: options.saveFile,
      requestTimeoutMs: options.requestTimeoutMs,
      transferIdleMs: options.transferIdleMs,
      trusted: (event) => event === trusted,
      members: {
        running: () =>
          options.remote
            ? []
            : [
                {
                  connectionID: connection.id,
                  runtimeID: "runtime-a",
                  connection: {
                    url: "http://127.0.0.1:43210",
                    headers: { authorization: "Bearer private-member-credential" },
                  },
                },
              ],
        status: () => {
          throw new Error("Unused status")
        },
        start: async () => {
          throw new Error("Unused start")
        },
      },
    })
    const input = {
      requestID: "native-read",
      connectionID: connection.id,
      query: { rootSessionID: "session-a", operation: "status" },
    }
    return {
      f,
      ipc,
      trusted,
      input,
      state,
      entered,
      release,
      queries,
      binding,
      async [Symbol.asyncDispose]() {
        release.resolve()
        ipc.dispose()
        await f[Symbol.asyncDispose]()
      },
    }
  } catch (error) {
    await f[Symbol.asyncDispose]()
    throw error
  }
}

test("main reads private native status through its fixed generated API for a creator without execute permission", async () => {
  await using f = await setup()
  const result = await f.ipc.handle(f.trusted, "memberRequest", f.input)
  expect(result).toMatchObject({
    ok: true,
    value: { kind: "result", result: { operation: "status", binding: f.binding() } },
  })
  expect(f.queries).toEqual([{ rootSessionID: "session-a", operation: "status" }])
  expect(JSON.stringify(result)).not.toMatch(/private-member|43210|scope|directory|path/)
})

test("organization administration cannot read a different creator's native private Session", async () => {
  await using f = await setup()
  f.state.creatorID = "another-account"
  expect(await f.ipc.handle(f.trusted, "memberRequest", f.input)).toMatchObject({
    ok: false,
    error: { code: "permission_denied" },
  })
  expect(f.queries).toHaveLength(0)
})

test("changed service or native binding evidence rejects a late native read without changing organization identity", async () => {
  await using f = await setup()
  f.state.nativeEpoch = 2
  expect(await f.ipc.handle(f.trusted, "memberRequest", f.input)).toMatchObject({
    ok: true,
    value: { kind: "binding_changed" },
  })
  f.state.nativeEpoch = 1
  f.state.hold = true
  const result = f.ipc.handle(f.trusted, "memberRequest", f.input)
  await f.entered.promise
  f.state.epoch = 2
  f.release.resolve()
  expect(await result).toMatchObject({ ok: true, value: { kind: "binding_changed" } })
})

test("native conflicts expose a fixed outcome without native error data", async () => {
  await using f = await setup()
  f.state.conflict = true
  const result = await f.ipc.handle(f.trusted, "memberRequest", f.input)
  expect(result).toEqual({ ok: true, value: { kind: "revision_conflict" } })
})

test("the native content IPC saves only the creator's exact bound field in verified bounded chunks", async () => {
  const content = Buffer.from("Private content 内容\n".repeat(15000))
  const chunks: Uint8Array[] = []
  await using f = await setup({
    content,
    saveFile: async (_fileName, write) => ({
      saved: true,
      bytes: await write(async (chunk) => {
        chunks.push(chunk.slice())
      }),
    }),
  })
  const input = {
    ...f.input,
    fileName: "result.txt",
    binding: f.binding(),
    query: {
      operation: "partContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "native-v1",
      field: "text",
      offset: 0,
      length: 131072,
    },
    reference: {
      kind: "native",
      version: "native-v1",
      field: "text",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      original: "partial",
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadContent", input)).toEqual({
    ok: true,
    value: { kind: "result", result: { saved: true, bytes: content.length }, original: "partial" },
  })
  expect(Buffer.concat(chunks)).toEqual(content)
  expect(chunks.every((chunk) => chunk.byteLength <= 131072)).toBe(true)
  expect(f.queries.length).toBeGreaterThan(3)
})

test("a binding change while the native save picker is open cannot publish field bytes", async () => {
  const content = new TextEncoder().encode("Private content")
  let writes = 0
  let picked = false
  let changed: () => void = () => {}
  await using f = await setup({
    content,
    saveFile: async (_fileName, write) => {
      changed()
      return {
        saved: true,
        bytes: await write(async () => {
          writes++
        }),
      }
    },
  })
  changed = () => {
    picked = true
    f.state.epoch = 2
  }
  const input = {
    ...f.input,
    fileName: "result.txt",
    binding: f.binding(),
    query: {
      operation: "partContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "native-v1",
      field: "text",
      offset: 0,
      length: 131072,
    },
    reference: {
      kind: "native",
      version: "native-v1",
      field: "text",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      original: "partial",
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadContent", input)).toMatchObject({ ok: false })
  expect(writes).toBe(0)
  expect(picked).toBe(true)
})

test("ordinary reads keep their total deadline while a progressing content save can outlive it", async () => {
  const content = Buffer.from("Progress 内容\n".repeat(20000))
  await using f = await setup({
    content,
    nativeDelayMs: 100,
    requestTimeoutMs: 50,
    transferIdleMs: 600,
    saveFile: async (_name, write) => ({ saved: true, bytes: await write(async () => {}) }),
  })
  expect(await f.ipc.handle(f.trusted, "memberRequest", f.input)).toEqual({ ok: false, error: { code: "cancelled" } })
  const input = {
    ...f.input,
    requestID: "download-progress",
    fileName: "result.txt",
    binding: f.binding(),
    query: {
      operation: "partContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "native-v1",
      field: "text",
      offset: 0,
      length: 131072,
    },
    reference: {
      kind: "native",
      version: "native-v1",
      field: "text",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      original: "partial",
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadContent", input)).toMatchObject({
    ok: true,
    value: { kind: "result", result: { saved: true, bytes: content.length } },
  })
})

test("an idle native field request finishes before its held response and never opens a save picker", async () => {
  const content = Buffer.from("Private content")
  let saves = 0
  await using f = await setup({
    content,
    transferIdleMs: 30,
    saveFile: async () => {
      saves++
      return { saved: false }
    },
  })
  f.state.hold = true
  const input = {
    ...f.input,
    requestID: "idle-download",
    fileName: "result.txt",
    binding: f.binding(),
    query: {
      operation: "partContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "native-v1",
      field: "text",
      offset: 0,
      length: 131072,
    },
    reference: {
      kind: "native",
      version: "native-v1",
      field: "text",
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      original: "partial",
    },
  }
  const pending = f.ipc.handle(f.trusted, "downloadContent", input)
  await f.entered.promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    pending,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 500)
    }),
  ])
  clearTimeout(timer)
  f.release.resolve()
  expect(result).toEqual({ ok: false, error: { code: "cancelled" } })
  expect(saves).toBe(0)
})

test("the attachment IPC derives its immutable descriptor through the captured member and rejects foreign creators before the picker", async () => {
  const attachment = Uint8Array.from({ length: 150001 }, (_, index) => index % 256)
  const chunks: Uint8Array[] = []
  let saves = 0
  await using f = await setup({
    attachment,
    saveFile: async (name, write) => {
      saves++
      expect(name).toBe("evidence.bin")
      return {
        saved: true,
        bytes: await write(async (chunk) => {
          chunks.push(chunk.slice())
        }),
      }
    },
  })
  const input = {
    ...f.input,
    requestID: "attachment-save",
    binding: f.binding(),
    query: {
      operation: "attachmentContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "attachment-v1",
      offset: 0,
      length: 65536,
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadAttachment", input)).toEqual({
    ok: true,
    value: { kind: "result", result: { saved: true, bytes: attachment.length } },
  })
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(attachment)
  expect(chunks.every((chunk) => chunk.byteLength <= 65536)).toBe(true)
  expect(f.queries).toHaveLength(4)
  f.state.creatorID = "foreign-creator"
  expect(await f.ipc.handle(f.trusted, "downloadAttachment", { ...input, requestID: "attachment-foreign" })).toEqual({
    ok: false,
    error: { code: "permission_denied" },
  })
  expect(saves).toBe(1)
  expect(f.queries).toHaveLength(4)
})

test("the attachment IPC revalidates the current binding after a native save picker", async () => {
  const attachment = new Uint8Array([0, 255, 128])
  let changed: () => void = () => {}
  let writes = 0
  await using f = await setup({
    attachment,
    saveFile: async (_name, write) => {
      changed()
      return {
        saved: true,
        bytes: await write(async () => {
          writes++
        }),
      }
    },
  })
  changed = () => {
    f.state.epoch = 2
  }
  const input = {
    ...f.input,
    requestID: "attachment-binding",
    binding: f.binding(),
    query: {
      operation: "attachmentContent",
      rootSessionID: "session-a",
      messageID: "message-a",
      partID: "part-a",
      version: "attachment-v1",
      offset: 0,
      length: 65536,
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadAttachment", input)).toMatchObject({ ok: false })
  expect(writes).toBe(0)
})

test("remote attachment saving stays on the generated organization read route with captured source and binding", async () => {
  const attachment = Uint8Array.from({ length: 70003 }, (_, index) => index % 256)
  const chunks: Uint8Array[] = []
  await using f = await setup({
    attachment,
    remote: true,
    saveFile: async (_name, write) => ({
      saved: true,
      bytes: await write(async (chunk) => {
        chunks.push(chunk.slice())
      }),
    }),
  })
  const input = {
    ...f.input,
    requestID: "attachment-remote",
    binding: f.binding(),
    query: {
      operation: "attachmentContent",
      rootSessionID: "session-a",
      sourceSessionID: "child-a",
      messageID: "message-a",
      partID: "part-a",
      version: "attachment-v1",
      offset: 0,
      length: 65536,
    },
  }
  expect(await f.ipc.handle(f.trusted, "downloadAttachment", input)).toEqual({
    ok: true,
    value: { kind: "result", result: { saved: true, bytes: attachment.length } },
  })
  expect(new Uint8Array(Buffer.concat(chunks))).toEqual(attachment)
  expect(f.queries).toHaveLength(3)
  expect(
    f.queries.every(
      (query) =>
        query.sourceSessionID === "child-a" &&
        query.operation === "attachmentContent" &&
        query.version === "attachment-v1",
    ),
  ).toBe(true)
  f.state.nativeEpoch = 2
  expect(
    await f.ipc.handle(f.trusted, "downloadAttachment", { ...input, requestID: "attachment-remote-changed" }),
  ).toEqual({ ok: false, error: { code: "invalid_response" } })
})
