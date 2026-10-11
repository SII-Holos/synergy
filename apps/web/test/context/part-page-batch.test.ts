import { describe, expect, spyOn, test } from "bun:test"
import { createSynergyClient, type Message, type SessionPartPage } from "@ericsanchezok/synergy-sdk/client"
import { createPartPageBatchReader, isPlainPartPageQuery } from "../../src/context/part-page-batch"
import { createPartSummaryLoader, partSummaryPageState } from "../../src/context/part-summary-loader"
import { readSessionViewportContent } from "../../src/context/session-viewport-content"

const pageFor = (messageID: string): SessionPartPage => ({
  items: [
    {
      id: `prt_of_${messageID}`,
      sessionID: "session",
      messageID,
      type: "text",
      preview: messageID,
      content: { version: "v", bytes: 4 },
    },
  ],
  nextCursor: null,
  previousCursor: null,
  hasMore: false,
  hasEarlier: false,
})

type BatchTransport = {
  request: Request
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

function controlledBatchReader(honorAbort = false) {
  const requests: BatchTransport[] = []
  const ready: BatchTransport[] = []
  const waiters: ReturnType<typeof Promise.withResolvers<BatchTransport>>[] = []
  const client = createSynergyClient({
    baseUrl: "https://batch.test",
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const request = new Request(input)
        const response = Promise.withResolvers<Response>()
        const transport = { request, resolve: response.resolve, reject: response.reject }
        const onAbort = () => response.reject(new DOMException("The operation was aborted", "AbortError"))
        if (honorAbort) {
          request.signal.addEventListener("abort", onAbort)
          if (request.signal.aborted) onAbort()
        }
        requests.push(transport)
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(transport)
        else ready.push(transport)
        try {
          return await response.promise
        } finally {
          request.signal.removeEventListener("abort", onAbort)
        }
      },
      { preconnect: () => {} },
    ),
  })
  const read = createPartPageBatchReader({
    read: async (sessionID, messageIDs, signal) => {
      const response = await client.session.partPages(
        { sessionID, messageIDs, limit: 100 },
        { signal, throwOnError: true },
      )
      if (!response.data) throw new Error("Missing conversation summaries")
      return response.data
    },
  })
  return {
    read,
    requests,
    next: () => {
      const transport = ready.shift()
      if (transport) return Promise.resolve(transport)
      const waiter = Promise.withResolvers<BatchTransport>()
      waiters.push(waiter)
      return waiter.promise
    },
  }
}

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0))
const batchResponse = (...messageIDs: string[]) =>
  Response.json(Object.fromEntries(messageIDs.map((id) => [id, pageFor(id)])))

describe("isPlainPartPageQuery", () => {
  test("only cursor/partID/older-free queries are plain", () => {
    expect(isPlainPartPageQuery({})).toBe(true)
    expect(isPlainPartPageQuery({ cursor: "c" })).toBe(false)
    expect(isPlainPartPageQuery({ partID: "prt_x" })).toBe(false)
    expect(isPlainPartPageQuery({ older: true })).toBe(false)
  })
})

describe("createPartPageBatchReader", () => {
  test("coalesces same-microtask reads into one batch request", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    const [a, b, c] = await Promise.all([
      read("session", "msg_a", controller.signal),
      read("session", "msg_b", controller.signal),
      read("session", "msg_c", controller.signal),
    ])
    expect(batches).toEqual([["msg_a", "msg_b", "msg_c"]])
    expect(a.items[0].messageID).toBe("msg_a")
    expect(b.items[0].messageID).toBe("msg_b")
    expect(c.items[0].messageID).toBe("msg_c")
  })

  for (const count of [100, 101, 201]) {
    test(`${count} simultaneous message reads respect the 100-ID request limit`, async () => {
      const batch = controlledBatchReader()
      const messageIDs = Array.from({ length: count }, (_, index) => `msg_${index}`)
      const controller = new AbortController()
      const pending = Promise.allSettled(
        messageIDs.map((messageID) => batch.read("session", messageID, controller.signal)),
      )
      await batch.next()
      await nextTurn()
      try {
        const bodies = await Promise.all(batch.requests.map((transport) => transport.request.json()))
        for (const [index, transport] of batch.requests.entries()) {
          const ids: string[] = bodies[index].messageIDs
          transport.resolve(
            ids.length > 100
              ? Response.json({ error: "Too many message IDs" }, { status: 400 })
              : batchResponse(...ids),
          )
        }
        expect(await pending).toEqual(
          messageIDs.map((messageID) => ({ status: "fulfilled", value: pageFor(messageID) })),
        )
        expect(bodies.map((body) => body.messageIDs.length)).toEqual(
          count === 100 ? [100] : count === 101 ? [100, 1] : [100, 100, 1],
        )
        expect(bodies.flatMap((body) => body.messageIDs)).toEqual(messageIDs)
        expect(bodies.every((body) => body.limit === 100)).toBe(true)
      } finally {
        for (const transport of batch.requests) transport.resolve(batchResponse(...messageIDs))
      }
    })
  }

  test("duplicate consumers across the chunk boundary share one message page request", async () => {
    const batch = controlledBatchReader()
    const messageIDs = Array.from({ length: 101 }, (_, index) => `msg_${index}`)
    const controller = new AbortController()
    const pending: Promise<SessionPartPage[]> = Promise.all([
      ...messageIDs.slice(0, 100).map((messageID) => batch.read("session", messageID, controller.signal)),
      batch.read("session", "msg_99", controller.signal),
      batch.read("session", "msg_100", controller.signal),
      batch.read("session", "msg_0", controller.signal),
    ])
    await batch.next()
    await nextTurn()
    try {
      const bodies = await Promise.all(batch.requests.map((transport) => transport.request.json()))
      expect(bodies).toEqual([
        { messageIDs: messageIDs.slice(0, 100), limit: 100 },
        { messageIDs: ["msg_100"], limit: 100 },
      ])
      for (const [index, transport] of batch.requests.entries())
        transport.resolve(batchResponse(...bodies[index].messageIDs))
      const pages = await pending
      expect(pages).toEqual([...messageIDs.slice(0, 100), "msg_99", "msg_100", "msg_0"].map(pageFor))
      expect(pages[100]).toBe(pages[99])
      expect(pages[102]).toBe(pages[0])
    } finally {
      for (const transport of batch.requests) transport.resolve(batchResponse(...messageIDs))
      await pending
    }
  })

  for (const cancelledChunk of [0, 1]) {
    test(`the final consumer of chunk ${cancelledChunk} aborts only that transport`, async () => {
      const batch = controlledBatchReader(true)
      const messageIDs = Array.from({ length: 101 }, (_, index) => `msg_${index}`)
      const drop = new AbortController()
      const last = new AbortController()
      const keep = new AbortController()
      const removed = spyOn(drop.signal, "removeEventListener")
      const lastRemoved = spyOn(last.signal, "removeEventListener")
      const keptRemoved = spyOn(keep.signal, "removeEventListener")
      const droppedIDs = cancelledChunk === 0 ? messageIDs.slice(0, 100) : messageIDs.slice(100)
      const keptIDs = cancelledChunk === 0 ? messageIDs.slice(100) : messageIDs.slice(0, 100)
      const pending = messageIDs.map((messageID) =>
        batch.read("session", messageID, droppedIDs.includes(messageID) ? drop.signal : keep.signal),
      )
      const cancelled: Promise<PromiseSettledResult<SessionPartPage>[]> = Promise.allSettled([
        ...pending.filter((_, index) => droppedIDs.includes(messageIDs[index])),
        batch.read("session", droppedIDs.at(-1)!, last.signal),
      ])
      const kept = Promise.all(pending.filter((_, index) => keptIDs.includes(messageIDs[index])))
      await batch.next()
      await nextTurn()
      try {
        expect(batch.requests).toHaveLength(2)
        const droppedTransport = batch.requests[cancelledChunk]
        const keptTransport = batch.requests[1 - cancelledChunk]
        drop.abort()
        expect(droppedTransport.request.signal.aborted).toBe(false)
        last.abort()
        expect(droppedTransport.request.signal.aborted).toBe(true)
        expect(keptTransport.request.signal.aborted).toBe(false)
        expect(await cancelled).toEqual(
          Array.from({ length: droppedIDs.length + 1 }, () => ({
            status: "rejected",
            reason: expect.objectContaining({ name: "AbortError" }),
          })),
        )
        keptTransport.resolve(batchResponse(...keptIDs))
        expect(await kept).toEqual(keptIDs.map(pageFor))
        expect(removed).toHaveBeenCalledTimes(droppedIDs.length)
        expect(lastRemoved).toHaveBeenCalledTimes(1)
        expect(keptRemoved).toHaveBeenCalledTimes(keptIDs.length)
        droppedTransport.resolve(batchResponse(...droppedIDs))
        keep.abort()
        await nextTurn()
        expect(keptTransport.request.signal.aborted).toBe(false)
        expect(removed).toHaveBeenCalledTimes(droppedIDs.length)
        expect(lastRemoved).toHaveBeenCalledTimes(1)
        expect(keptRemoved).toHaveBeenCalledTimes(keptIDs.length)
      } finally {
        for (const transport of batch.requests) transport.resolve(batchResponse(...messageIDs))
        await Promise.all([cancelled, kept])
        removed.mockRestore()
        lastRemoved.mockRestore()
        keptRemoved.mockRestore()
      }
    })
  }

  for (const failedChunk of [0, 1]) {
    test(`failure of chunk ${failedChunk} settles only its consumers while its peer completes`, async () => {
      const batch = controlledBatchReader()
      const messageIDs = Array.from({ length: 101 }, (_, index) => `msg_${index}`)
      const controller = new AbortController()
      const removed = spyOn(controller.signal, "removeEventListener")
      const pending = messageIDs.map((messageID) => batch.read("session", messageID, controller.signal))
      const failedIDs = failedChunk === 0 ? messageIDs.slice(0, 100) : messageIDs.slice(100)
      const keptIDs = failedChunk === 0 ? messageIDs.slice(100) : messageIDs.slice(0, 100)
      const failed = Promise.allSettled(pending.filter((_, index) => failedIDs.includes(messageIDs[index])))
      const keptOutcomes: SessionPartPage[] = []
      const kept = Promise.all(
        pending
          .filter((_, index) => keptIDs.includes(messageIDs[index]))
          .map((page) => page.then((page) => keptOutcomes.push(page))),
      )
      await batch.next()
      await nextTurn()
      try {
        expect(batch.requests).toHaveLength(2)
        const failure = new Error("storage busy")
        batch.requests[failedChunk].reject(failure)
        expect(await failed).toEqual(failedIDs.map(() => ({ status: "rejected", reason: failure })))
        expect(keptOutcomes).toEqual([])
        expect(removed).toHaveBeenCalledTimes(failedIDs.length)
        const keptTransport = batch.requests[1 - failedChunk]
        expect(keptTransport.request.signal.aborted).toBe(false)
        keptTransport.resolve(batchResponse(...keptIDs))
        await kept
        expect(keptOutcomes).toEqual(keptIDs.map(pageFor))
        expect(removed).toHaveBeenCalledTimes(messageIDs.length)
        controller.abort()
        expect(batch.requests.every((transport) => !transport.request.signal.aborted)).toBe(true)
      } finally {
        for (const transport of batch.requests) transport.resolve(batchResponse(...messageIDs))
        await Promise.all([failed, kept])
        removed.mockRestore()
      }
    })
  }

  test("dedicated reads across microtasks issue separate batches", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    const first = await read("session", "msg_a", controller.signal)
    const second = await read("session", "msg_b", controller.signal)
    expect(batches).toEqual([["msg_a"], ["msg_b"]])
    expect(first.items[0].messageID).toBe("msg_a")
    expect(second.items[0].messageID).toBe("msg_b")
  })

  test("a batch failure rejects every pending read without poisoning later batches", async () => {
    let calls = 0
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        calls += 1
        if (calls === 1) throw new Error("storage busy")
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const controller = new AbortController()
    await expect(read("session", "msg_a", controller.signal)).rejects.toThrow("storage busy")
    const second = await read("session", "msg_b", controller.signal)
    expect(second.items[0].messageID).toBe("msg_b")
    expect(calls).toBe(2)
  })

  test("aborted reads are excluded from the batch and rejected", async () => {
    const batches: string[][] = []
    const read = createPartPageBatchReader({
      read: async (_sessionID, ids) => {
        batches.push(ids)
        return Object.fromEntries(ids.map((id) => [id, pageFor(id)]))
      },
    })
    const keep = new AbortController()
    const drop = new AbortController()
    const dropped = read("session", "msg_dropped", drop.signal)
    drop.abort()
    const kept = await Promise.all([
      read("session", "msg_kept", keep.signal),
      (async () => {
        try {
          await dropped
          return "resolved"
        } catch {
          return "aborted"
        }
      })(),
    ])
    expect(batches).toEqual([["msg_kept"]])
    expect(kept[0].items[0].messageID).toBe("msg_kept")
    expect(kept[1]).toBe("aborted")
  })

  for (const siblingID of ["msg_a", "msg_b"]) {
    for (const outcome of ["resolve", "reject"] as const) {
      test(`cancellation settles once before transport ${outcome} with sibling ${siblingID}`, async () => {
        const batch = controlledBatchReader()
        const drop = new AbortController()
        const keep = new AbortController()
        const removed = spyOn(drop.signal, "removeEventListener")
        const keptRemoved = spyOn(keep.signal, "removeEventListener")
        const outcomes: unknown[] = []
        const dropped = batch.read("session", "msg_a", drop.signal).then(
          (page) => outcomes.push(page),
          (error) => outcomes.push(error),
        )
        const kept = batch.read("session", siblingID, keep.signal).then(
          (page) => page,
          (error: unknown) => error,
        )
        const transport = await batch.next()
        expect(await transport.request.json()).toEqual({ messageIDs: [...new Set(["msg_a", siblingID])], limit: 100 })
        try {
          drop.abort("consumer released")
          await nextTurn()
          expect(outcomes).toEqual([expect.objectContaining({ name: "AbortError" })])
          expect(removed).toHaveBeenCalledTimes(1)
          expect(transport.request.signal.aborted).toBe(false)
          const failure = new Error("storage busy")
          if (outcome === "resolve") transport.resolve(batchResponse("msg_a", siblingID))
          else transport.reject(failure)
          expect(await kept).toEqual(outcome === "resolve" ? pageFor(siblingID) : failure)
          await dropped
          expect(outcomes).toHaveLength(1)
          expect(removed).toHaveBeenCalledTimes(1)
          expect(keptRemoved).toHaveBeenCalledTimes(1)
          keep.abort()
          expect(transport.request.signal.aborted).toBe(false)
        } finally {
          transport.resolve(batchResponse("msg_a", siblingID))
          removed.mockRestore()
          keptRemoved.mockRestore()
        }
      })
    }
  }

  test("an abort-aware SDK transport preserves a healthy sibling", async () => {
    const batch = controlledBatchReader(true)
    const drop = new AbortController()
    const keep = new AbortController()
    const outcomes: unknown[] = []
    void batch.read("session", "msg_a", drop.signal).catch((error) => outcomes.push(error))
    const kept = batch.read("session", "msg_b", keep.signal).catch((error: unknown) => error)
    const transport = await batch.next()
    try {
      drop.abort()
      await nextTurn()
      expect(transport.request.signal.aborted).toBe(false)
      expect(outcomes).toEqual([expect.objectContaining({ name: "AbortError" })])
      transport.resolve(batchResponse("msg_a", "msg_b"))
      expect(await kept).toEqual(pageFor("msg_b"))
    } finally {
      transport.resolve(batchResponse("msg_a", "msg_b"))
    }
  })

  test("the last cancelled consumer aborts transport and releases all listeners for later reads", async () => {
    const batch = controlledBatchReader(true)
    const first = new AbortController()
    const second = new AbortController()
    const firstRemoved = spyOn(first.signal, "removeEventListener")
    const secondRemoved = spyOn(second.signal, "removeEventListener")
    const outcomes: unknown[] = []
    const cancelled = [first, second].map((controller) =>
      batch.read("session", "msg_a", controller.signal).catch((error) => outcomes.push(error)),
    )
    const transport = await batch.next()
    try {
      first.abort()
      expect(transport.request.signal.aborted).toBe(false)
      second.abort()
      await nextTurn()
      expect(outcomes).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ name: "AbortError" })))
      expect(transport.request.signal.aborted).toBe(true)
      await Promise.all(cancelled)
      expect(firstRemoved).toHaveBeenCalledTimes(1)
      expect(secondRemoved).toHaveBeenCalledTimes(1)
      const subsequent = batch.read("session", "msg_a", new AbortController().signal)
      const next = await batch.next()
      next.resolve(batchResponse("msg_a"))
      expect(await subsequent).toEqual(pageFor("msg_a"))
      expect(batch.requests).toHaveLength(2)
    } finally {
      transport.resolve(batchResponse("msg_a"))
      firstRemoved.mockRestore()
      secondRemoved.mockRestore()
    }
  })

  test("all consumers cancelled before dispatch settle without a request", async () => {
    const batch = controlledBatchReader()
    const controller = new AbortController()
    const removed = spyOn(controller.signal, "removeEventListener")
    const cancelled = Promise.allSettled([
      batch.read("session", "msg_a", controller.signal),
      batch.read("session", "msg_b", controller.signal),
    ])
    controller.abort()
    try {
      expect(await cancelled).toEqual([
        { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
        { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
      ])
      expect(batch.requests).toHaveLength(0)
      expect(removed).toHaveBeenCalledTimes(2)
      expect(batch.read("session", "msg_a", controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    } finally {
      removed.mockRestore()
    }
  })

  test("a forced summary load proceeds after a dispatched read is cancelled", async () => {
    const batch = controlledBatchReader(true)
    let current: ReturnType<typeof partSummaryPageState> | undefined
    const applied: SessionPartPage[] = []
    const loader = createPartSummaryLoader({
      page: () => current,
      summaries: () => applied.at(-1)?.items ?? [],
      read: async (request, _cursor, signal) => {
        const page = await batch.read(request.sessionID, request.messageID, signal)
        return { page: { ...page, ranges: partSummaryPageState(page).ranges }, action: "apply" }
      },
      apply: (_request, page) => {
        current = partSummaryPageState(page)
        applied.push(page)
      },
    })
    const drop = new AbortController()
    const target = { sessionID: "session", messageID: "msg_a" }
    const outcomes: unknown[] = []
    const first = loader.load(target, drop.signal).catch((error) => outcomes.push(error))
    const transport = await batch.next()
    const forced = loader.load({ ...target, force: true }, new AbortController().signal)
    try {
      drop.abort()
      await nextTurn()
      expect(outcomes).toEqual([expect.objectContaining({ name: "AbortError" })])
      const next = await batch.next()
      next.resolve(batchResponse("msg_a"))
      await Promise.all([first, forced])
      expect(applied).toEqual([expect.objectContaining(pageFor("msg_a"))])
      await loader.load(target, new AbortController().signal)
      expect(batch.requests).toHaveLength(2)
      const subsequent = loader.load({ ...target, force: true }, new AbortController().signal)
      const last = await batch.next()
      last.resolve(batchResponse("msg_a"))
      await subsequent
      expect(applied).toHaveLength(2)
    } finally {
      transport.resolve(batchResponse("msg_a"))
    }
  })

  test("viewport cancellation finishes allSettled and its finally while a sibling read stays live", async () => {
    const batch = controlledBatchReader(true)
    const controller = new AbortController()
    const outcomes: unknown[] = []
    let released = false
    let bodies = 0
    const viewport = readSessionViewportContent({
      messages: [
        { id: "msg_a", role: "user" },
        { id: "msg_b", role: "assistant" },
      ] as Message[],
      signal: controller.signal,
      page: (messageID) => batch.read("session", messageID, controller.signal),
      body: async () => {
        bodies++
        throw new Error("Cancelled viewport must not load bodies")
      },
    })
      .catch((error) => outcomes.push(error))
      .finally(() => {
        released = true
      })
    const sibling = batch.read("session", "msg_b", new AbortController().signal).catch((error: unknown) => error)
    const transport = await batch.next()
    try {
      controller.abort()
      await nextTurn()
      expect(outcomes).toEqual([expect.objectContaining({ name: "AbortError" })])
      expect(released).toBe(true)
      expect(bodies).toBe(0)
      expect(transport.request.signal.aborted).toBe(false)
      transport.resolve(batchResponse("msg_a", "msg_b"))
      expect(await sibling).toEqual(pageFor("msg_b"))
      await viewport
    } finally {
      transport.resolve(batchResponse("msg_a", "msg_b"))
    }
  })
})
