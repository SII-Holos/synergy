import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { OrganizationReadProtocol as Read } from "@ericsanchezok/synergy-organization-protocol"
import { createOrganizationAttachmentDirectory } from "../../src/organization/attachment-directory"

const binding = {
  schemaVersion: 1,
  orgID: "org-one",
  projectID: "project-one",
  creatorID: "account-one",
  driverRuntimeID: "runtime-one",
  bindingEpoch: 1,
} as const
const target = { sessionID: "root", sourceSessionID: "child", messageID: "message", partID: "tool", binding }
const page = (ordinal?: number, cursor?: string, version = "tool-v1"): Read.Result => ({
  operation: "attachments",
  rootSessionID: "root",
  sourceSessionID: "child",
  binding,
  messageID: "message",
  partID: "tool",
  version,
  total: 1001,
  items:
    ordinal === undefined ? [] : [{ ordinal, filename: `result-${ordinal}.txt`, mediaType: "text/plain", bytes: 2 }],
  cursor,
})
test("tool files stay lazy and finite while empty raw pages preserve access to the tail and first page", async () => {
  const requests: Read.Input[] = []
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationAttachmentDirectory({
      ...target,
      signal: new AbortController().signal,
      async read(query) {
        requests.push(query)
        return query.operation === "attachments" && query.cursor ? page(1000) : page(undefined, "tail")
      },
    }),
  }))
  try {
    expect(requests).toHaveLength(0)
    await scope.directory.load()
    expect(scope.directory.loaded()).toBe(true)
    expect(scope.directory.cursor()).toBe("tail")
    expect(scope.directory.state.items).toHaveLength(0)
    await scope.directory.load(true)
    expect(scope.directory.state.items.map((item) => item.ordinal)).toEqual([1000])
    expect(scope.directory.earlier()).toBe(true)
    expect(scope.directory.cursor()).toBeUndefined()
    expect(scope.directory.version()).toBe("tool-v1")
    expect(scope.directory.total()).toBe(1001)
    expect(requests[1]).toEqual({
      operation: "attachments",
      rootSessionID: "root",
      sourceSessionID: "child",
      messageID: "message",
      partID: "tool",
      limit: 32,
      cursor: "tail",
    })
    await scope.directory.load()
    expect(scope.directory.earlier()).toBe(false)
    expect(scope.directory.cursor()).toBe("tail")
  } finally {
    scope.dispose()
  }
})
test("file pages reject a changed producer version, repeated cursor and a different authorized target", async () => {
  for (const invalid of [page(32, "tail", "tool-v2"), page(32, "tail"), { ...page(32), messageID: "foreign" }]) {
    let calls = 0
    const scope = createRoot((dispose) => ({
      dispose,
      directory: createOrganizationAttachmentDirectory({
        ...target,
        signal: new AbortController().signal,
        async read() {
          return ++calls === 1 ? page(0, "tail") : invalid
        },
      }),
    }))
    try {
      await scope.directory.load()
      await scope.directory.load(true)
      expect(scope.directory.error()).toMatchObject({ code: "invalid_response" })
      expect(scope.directory.state.items.map((item) => item.ordinal)).toEqual([0])
    } finally {
      scope.dispose()
    }
  }
})
test("revocation discards filenames and versions while cancellation cannot publish a late page", async () => {
  let calls = 0
  let invalidated = 0
  const controller = new AbortController()
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationAttachmentDirectory({
      ...target,
      signal: controller.signal,
      async read() {
        if (++calls === 2) throw { code: "permission_denied" }
        return page(0, "tail")
      },
      invalidated() {
        invalidated++
      },
    }),
  }))
  try {
    await scope.directory.load()
    await scope.directory.load(true)
    expect(scope.directory.state.items).toHaveLength(0)
    expect(scope.directory.version()).toBeUndefined()
    expect(scope.directory.cursor()).toBeUndefined()
    expect(invalidated).toBe(1)
  } finally {
    scope.dispose()
  }
  const reply = Promise.withResolvers<Read.Result>()
  const started = Promise.withResolvers<void>()
  const delayed = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationAttachmentDirectory({
      ...target,
      signal: controller.signal,
      async read() {
        started.resolve()
        return reply.promise
      },
      invalidated() {
        invalidated++
      },
    }),
  }))
  try {
    const load = delayed.directory.load()
    await started.promise
    controller.abort()
    reply.resolve(page(0))
    await load
    expect(delayed.directory.state.items).toHaveLength(0)
    expect(delayed.directory.version()).toBeUndefined()
    expect(invalidated).toBe(1)
  } finally {
    delayed.dispose()
  }
})

test("closing a file disclosure cancels its pending page and discards an uncooperative late reply", async () => {
  const reply = Promise.withResolvers<Read.Result>()
  const started = Promise.withResolvers<AbortSignal>()
  const scope = createRoot((dispose) => ({
    dispose,
    directory: createOrganizationAttachmentDirectory({
      ...target,
      signal: new AbortController().signal,
      async read(_query, signal) {
        started.resolve(signal!)
        return reply.promise
      },
    }),
  }))
  const loading = scope.directory.load()
  const signal = await started.promise
  scope.dispose()
  expect(signal.aborted).toBe(true)
  reply.resolve(page(1000))
  await loading
  expect(scope.directory.state.items).toHaveLength(0)
  expect(scope.directory.loaded()).toBe(false)
  expect(scope.directory.loading()).toBe(false)
  expect(scope.directory.error()).toBeUndefined()
})
