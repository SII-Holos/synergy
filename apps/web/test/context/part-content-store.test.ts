import { expect, test } from "bun:test"
import type { SessionPartSummary, TextPart } from "@ericsanchezok/synergy-sdk"
import { createPartContentStore } from "../../src/context/part-content-store"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { createPartMaterializer } from "../../src/context/part-materializer"

const key = { url: "http://fixture", scopeKey: "scope", partID: "part", version: "one" }
const body = (): TextPart => ({
  id: "part",
  sessionID: "session",
  messageID: "message",
  type: "text",
  text: "Original body",
  metadata: { nested: { title: "Original metadata" } },
})

test("version cache snapshots are isolated from writes and returned bodies", () => {
  const store = createPartContentStore()
  const part = body()
  store.put({ ...key, part })
  part.text = "Changed source"
  const first = store.get(key)!
  expect(first).toEqual(body())
  if (first.type !== "text") throw new Error("Text fixture required")
  first.text = "Changed consumer"
  const nested = first.metadata!.nested as { title: string }
  nested.title = "Changed nested metadata"
  expect(store.get(key)).toEqual(body())
})

test("Solid replacement and cache-hit mutation preserve the old version snapshot and budget", () => {
  const cache = createPartContentStore(1024)
  const original = body()
  const originalBytes = JSON.stringify(original).length * 2
  cache.put({ ...key, part: original })
  const [part, setPart] = createStore(original)
  setPart(reconcile({ ...body(), type: "text", text: "checkpoint" }))
  expect(part.type === "text" && part.text).toBe("checkpoint")
  setPart(
    produce((draft) => {
      if (draft.type === "text") draft.text = "new bytes".repeat(2500)
    }),
  )
  expect(JSON.stringify(part).length * 2).toBeGreaterThan(20000)
  expect(cache.get(key)).toEqual(body())
  expect(cache.bytes).toBe(originalBytes)
  expect(cache.bytes).toBeLessThanOrEqual(1024)
  const hit = cache.get(key)!
  const [returned, setReturned] = createStore(hit)
  setReturned(reconcile({ ...body(), type: "text", text: "replaced hit" }))
  setReturned(
    produce((draft) => {
      if (draft.type === "text") draft.text = "mutated hit".repeat(2500)
    }),
  )
  expect(JSON.stringify(returned).length * 2).toBeGreaterThan(20000)
  expect(cache.get(key)).toEqual(body())
  expect(cache.bytes).toBe(originalBytes)
  cache.put({ ...key, part: returned })
  expect(cache.get(key)).toBeUndefined()
  expect(cache.bytes).toBe(0)
  cache.put({ ...key, part: body() })
  expect(cache.get(key)).toEqual(body())
  expect(cache.bytes).toBe(originalBytes)
})

test("cache budget measures the retained snapshot and bounds oversized bodies", () => {
  const part = body()
  const bytes = JSON.stringify(part).length * 2
  const store = createPartContentStore(bytes)
  store.put({ ...key, part })
  expect(store.bytes).toBe(bytes)
  store.put({ ...key, version: "two", part })
  expect(store.bytes).toBe(bytes)
  expect(store.get(key)).toBeUndefined()
  expect(store.get({ ...key, version: "two" })).toEqual(part)
  store.invalidate("message")
  expect(store.bytes).toBe(0)
  const undersized = createPartContentStore(bytes - 1)
  undersized.put({ ...key, part })
  expect(undersized.size()).toBe(0)
  expect(undersized.bytes).toBe(0)
})

function contentTransportFixture() {
  const cache = createPartContentStore()
  const transports: Array<{ request: Request; finish: (response: Response) => void }> = []
  const client = createSynergyClient({
    baseUrl: key.url,
    fetch: Object.assign(
      (requestInput: RequestInfo | URL, init?: RequestInit) => {
        const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
        return new Promise<Response>((finish) => transports.push({ request, finish }))
      },
      { preconnect() {} },
    ),
  })
  const summary = (version = "one"): SessionPartSummary => ({
    id: key.partID,
    sessionID: "session",
    messageID: "message",
    type: "text",
    preview: "Original body",
    content: { version, bytes: 93 },
  })
  const owner = () => {
    const lifetime = new AbortController()
    const applied: string[] = []
    let version = "one"
    const materializer = createPartMaterializer({
      wait: async () => {},
      read: (part) =>
        cache.read(
          { ...key, version: part.content.version },
          async (signal) => {
            const response = await client.session.partContent(
              { sessionID: part.sessionID, messageID: part.messageID, partID: part.id, version: part.content.version },
              { signal, throwOnError: true },
            )
            if (!response.data) throw new Error("Missing content fixture")
            return response.data
          },
          lifetime.signal,
        ),
      isCurrent: (part) => part.content.version === version,
      apply: (_, part) => applied.push(part.content.version),
      evict: () => {},
    })
    return {
      materializer,
      lifetime,
      applied,
      setVersion: (next: string) => {
        version = next
      },
    }
  }
  return { cache, transports, summary, owner }
}

test("four released materializer reads share one generated SDK transport across provider owners", async () => {
  const fixture = contentTransportFixture()
  const first = fixture.owner(),
    peer = fixture.owner()
  const released: Promise<void>[] = []
  for (let index = 0; index < 4; index++) {
    const lease = first.materializer.retain(fixture.summary())
    lease.release()
    released.push(lease.ready)
  }
  const kept = peer.materializer.retain(fixture.summary())
  await Bun.sleep(0)
  expect(fixture.transports).toHaveLength(1)
  expect(fixture.cache.size()).toBe(0)
  expect(new URL(fixture.transports[0].request.url).searchParams.get("version")).toBe("one")
  first.lifetime.abort()
  expect(fixture.transports[0].request.signal.aborted).toBe(false)
  fixture.transports[0].finish(Response.json({ part: body(), version: "one" }))
  await Promise.all([...released, kept.ready])
  expect(first.applied).toEqual([])
  expect(peer.applied).toEqual(["one"])
  expect(fixture.cache.get(key)).toEqual(body())
  kept.release()
  peer.materializer.invalidate("message")
  const cached = peer.materializer.retain(fixture.summary())
  await cached.ready
  expect(fixture.transports).toHaveLength(1)
  expect(peer.applied).toEqual(["one", "one"])
  cached.release()
  first.materializer.dispose()
  peer.materializer.dispose()
})

test("failed and provider-aborted SDK transports leave the same version retryable without obsolete publication", async () => {
  const fixture = contentTransportFixture()
  const owner = fixture.owner()
  const failed = owner.materializer.retain(fixture.summary())
  const failure = failed.ready.catch(() => "failed")
  await Bun.sleep(0)
  fixture.transports[0].finish(Response.json({ message: "storage busy" }, { status: 503 }))
  expect(await failure).toBe("failed")
  expect(fixture.cache.size()).toBe(0)
  failed.release()
  const obsolete = owner.materializer.retain(fixture.summary())
  await Bun.sleep(0)
  expect(fixture.transports).toHaveLength(2)
  owner.setVersion("two")
  const current = owner.materializer.retain(fixture.summary("two"))
  await Bun.sleep(0)
  fixture.transports[1].finish(Response.json({ part: body(), version: "one" }))
  await Bun.sleep(0)
  expect(fixture.transports).toHaveLength(3)
  fixture.transports[2].finish(Response.json({ part: { ...body(), text: "New body" }, version: "two" }))
  await Promise.all([obsolete.ready, current.ready])
  expect(owner.applied).toEqual(["two"])
  expect(fixture.cache.get(key)).toEqual(body())
  expect(fixture.cache.get({ ...key, version: "two" })).toEqual({ ...body(), text: "New body" })
  obsolete.release()
  current.release()
  owner.materializer.dispose()
  const cancelledOwner = fixture.owner()
  cancelledOwner.setVersion("three")
  const cancelled = cancelledOwner.materializer.retain(fixture.summary("three"))
  const aborted = cancelled.ready.catch(() => "aborted")
  await Bun.sleep(0)
  cancelledOwner.lifetime.abort()
  expect(await aborted).toBe("aborted")
  expect(fixture.transports[3].request.signal.aborted).toBe(true)
  const successor = fixture.owner()
  successor.setVersion("three")
  const retry = successor.materializer.retain(fixture.summary("three"))
  await Bun.sleep(0)
  fixture.transports[3].finish(Response.json({ part: { ...body(), text: "Cancelled body" }, version: "three" }))
  await Bun.sleep(0)
  expect(fixture.cache.get({ ...key, version: "three" })).toBeUndefined()
  const peer = fixture.owner()
  peer.setVersion("three")
  const shared = peer.materializer.retain(fixture.summary("three"))
  await Bun.sleep(0)
  expect(fixture.transports).toHaveLength(5)
  fixture.transports[4].finish(Response.json({ part: { ...body(), text: "Retry body" }, version: "three" }))
  await Promise.all([retry.ready, shared.ready])
  expect(successor.applied).toEqual(["three"])
  expect(peer.applied).toEqual(["three"])
  expect(cancelledOwner.applied).toEqual([])
  expect(fixture.cache.get({ ...key, version: "three" })).toEqual({ ...body(), text: "Retry body" })
  cancelled.release()
  retry.release()
  shared.release()
  cancelledOwner.materializer.dispose()
  successor.materializer.dispose()
  peer.materializer.dispose()
})
