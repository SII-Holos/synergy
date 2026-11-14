import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { submitPublication } from "../../src/organization/publication-recovery"
import type { createOrganizationPublicationStore } from "../../src/organization/publication-store"
import { expect, test } from "bun:test"
import {
  preparePublicationRecord,
  publicationAttempt,
  publicationFailed,
  publicationConfirmed,
  PublicationRecord,
} from "../../src/organization/publication-record"

export function record() {
  return preparePublicationRecord({
    identity: { kind: "organization", orgID: "org", accountID: "alice", deploymentIncarnation: "deployment" },
    source: { scope: { kind: "project", projectID: "project" } },
    upload: {
      uploadID: "sealed",
      orgID: "org",
      authorID: "alice",
      purpose: "knowledge",
      scope: { kind: "project", projectID: "project" },
      state: "sealed",
      manifestHash: "a".repeat(64),
      fileCount: 1,
      totalBytes: 12,
      createdAt: 1,
    },
    publication: {
      purpose: "knowledge",
      request: {
        requestID: "original",
        itemID: "item",
        expectedRevision: 0,
        uploadID: "sealed",
        title: "Original title",
        kind: "material",
      },
    },
    createdAt: 1,
  })
}

test("a publication with any historical unknown cannot become not dispatched after a later attempt", () => {
  const first = publicationAttempt(record())
  expect(publicationFailed(first, true).state).toBe("not_dispatched")
  const unknown = publicationFailed(first, false)
  expect(unknown.state).toBe("unknown")
  expect(publicationFailed(publicationAttempt(unknown), true).state).toBe("unknown")
  const reloaded = PublicationRecord.parse(JSON.parse(JSON.stringify(first)))
  expect(publicationFailed(publicationAttempt(reloaded), true).state).toBe("unknown")
  expect(publicationAttempt(unknown).request).toEqual(first.request)
})

test("publication metadata captures the exact sealed source without retaining files or credentials", () => {
  const original = record()
  const copied = PublicationRecord.parse(original)
  original.request.title = "Changed caller"
  original.identity.accountID = "bob"
  expect(copied.request.title).toBe("Original title")
  expect(copied.identity.accountID).toBe("alice")
  for (const changed of [
    { request: { ...copied.request, title: "Changed" } },
    { identity: { ...copied.identity, deploymentIncarnation: "other" } },
    { upload: { ...copied.upload, state: "open" } },
    { body: new Uint8Array([1]) },
    { token: "secret" },
  ])
    expect(PublicationRecord.safeParse({ ...copied, ...changed }).success).toBe(false)
})

test("only the exact author, target and sealed file summary can confirm publication", () => {
  const pending = record()
  const release = {
    itemID: "item",
    orgID: "org",
    scope: { kind: "project", projectID: "project" },
    kind: "material",
    title: "Original title",
    version: 1,
    authorID: "alice",
    publishedAt: 2,
    manifestHash: "a".repeat(64),
    fileCount: 1,
    totalBytes: 12,
  } as const
  expect(publicationConfirmed(pending, release)).toEqual(release)
  for (const changed of [
    { itemID: "other" },
    { authorID: "bob" },
    { title: "Later title" },
    { totalBytes: 13 },
    { manifestHash: "b".repeat(64) },
  ])
    expect(() => publicationConfirmed(pending, { ...release, ...changed })).toThrow()
})

function recoveryStore(initial: PublicationRecord) {
  let current: PublicationRecord | undefined = PublicationRecord.parse(initial)
  let disposed = false
  function active() {
    if (disposed) throw new Error("The fixture metadata store has closed")
  }
  function exact(value: PublicationRecord) {
    active()
    if (!current || current.requestHash !== value.requestHash)
      throw new Error("The original publication metadata has changed")
    return current
  }
  const store: ReturnType<typeof createOrganizationPublicationStore> = {
    dispose() {
      disposed = true
    },
    async put(value) {
      active()
      if (current) return exact(value)
      current = PublicationRecord.parse(value)
      return current
    },
    async get(requestID) {
      active()
      return current?.request.requestID === requestID ? PublicationRecord.parse(current) : undefined
    },
    async page() {
      active()
      return { items: current ? [PublicationRecord.parse(current)] : [], cursor: undefined }
    },
    async attempt(value) {
      current = publicationAttempt(exact(value))
      return current
    },
    async failed(value, notDispatched) {
      active()
      if (!current || current.requestHash !== value.requestHash || current.attempt !== value.attempt) return
      current = publicationFailed(current, notDispatched)
      return current
    },
    async confirm(value, result) {
      exact(value)
      const published = publicationConfirmed(value, result)
      current = undefined
      return published
    },
  }
  return { store, read: () => current }
}
function publishedRelease() {
  return {
    itemID: "item",
    orgID: "org",
    scope: { kind: "project", projectID: "project" },
    kind: "material",
    title: "Original title",
    version: 1,
    authorID: "alice",
    publishedAt: 2,
    manifestHash: "a".repeat(64),
    fileCount: 1,
    totalBytes: 12,
  }
}

test("the publication controller reconciles an unknown original request before any repeated write", async () => {
  const initial = record()
  const f = recoveryStore(initial)
  const reads: Array<{ path: string; body: unknown }> = []
  const api = createOrganizationClient({
    baseUrl: "https://organization.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const path = new URL(request.url).pathname
        reads.push({ path, body: await request.json() })
        return path.endsWith("/publication-receipts")
          ? Response.json({ state: "published", release: publishedRelease() })
          : Response.json({ code: "UPSTREAM_TIMEOUT" }, { status: 504 })
      },
      { preconnect() {} },
    ),
  })
  const signal = new AbortController().signal
  try {
    await expect(submitPublication(api, f.store, initial, signal)).rejects.toBeDefined()
    expect(f.read()?.state).toBe("unknown")
    expect(f.read()?.attempt).toBe(1)
    expect(f.read()?.uncertain).toBe(true)
    await submitPublication(api, f.store, initial, signal)
    expect(reads).toHaveLength(2)
    expect(reads[1]!.path).toEndWith("/publication-receipts")
    expect(reads.map((value) => value.body)).toEqual([initial.request, initial.request])
    expect(f.read()).toBeUndefined()
  } finally {
    f.store.dispose()
  }
})

test("an aborted accepted publication keeps its original pending metadata after the late reply", async () => {
  const initial = record()
  const f = recoveryStore(initial)
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  let writes = 0
  const api = createOrganizationClient({
    baseUrl: "https://organization.example",
    fetch: Object.assign(
      async () => {
        writes++
        started.resolve()
        return pending.promise
      },
      { preconnect() {} },
    ),
  })
  const operation = submitPublication(api, f.store, initial, controller.signal)
  const rejected = operation.then(
    () => undefined,
    (error: unknown) => error,
  )
  try {
    await started.promise
    expect(f.read()?.state).toBe("dispatching")
    controller.abort()
    pending.resolve(Response.json(publishedRelease()))
    expect(await rejected).toBe(controller.signal.reason)
    expect(writes).toBe(1)
    expect(f.read()?.request).toEqual(initial.request)
    expect(f.read()?.state).toBe("dispatching")
    expect(f.read()?.attempt).toBe(1)
  } finally {
    controller.abort()
    pending.resolve(Response.json(publishedRelease()))
    await operation.catch(() => {})
    f.store.dispose()
  }
})
