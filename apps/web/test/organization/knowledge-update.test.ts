import { expect, test } from "bun:test"
import { createOrganizationClient } from "@ericsanchezok/synergy-sdk/organization"
import { createKnowledgeUpdate } from "../../src/organization/knowledge-update"

test("an explicit knowledge change resumes its original staged update after a lost commit response", async () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const changes: unknown[] = []
  const begins: unknown[] = []
  const summary = {
    revision: 5,
    manifestHash: "f".repeat(64),
    releaseCount: 1001,
    updatedBy: "account-a",
    updatedAt: 5,
  }
  const target = { kind: "member", projectID: "project-a" } as const
  let committed = false
  let commits = 0
  const api = createOrganizationClient({
    baseUrl: "https://org.example",
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        const body = request.method === "POST" ? await request.json() : undefined
        const update = {
          updateID: "update-a",
          target,
          baseRevision: 4,
          nextSequence: changes.length ? 1 : 0,
          state: committed ? "committed" : "draft",
          ...(committed ? { committed: summary } : {}),
        }
        if (url.pathname.endsWith("/selection-updates")) {
          begins.push(body)
          return Response.json(update)
        }
        if (url.pathname.endsWith("/pages")) {
          changes.push(body)
          return Response.json({ ...update, nextSequence: 1 })
        }
        if (url.pathname.endsWith("/commit")) {
          commits++
          committed = true
          throw new Error("lost response")
        }
        return Response.json(update)
      },
      { preconnect() {} },
    ),
  })
  const first = createKnowledgeUpdate(storage, "account-a", "project-a")
  first.begin({
    requestID: "logical-a",
    target,
    expectedRevision: 4,
    change: { itemID: "guide", reference: { itemID: "guide", version: 2, manifestHash: "2".repeat(64) } },
  })
  await expect(first.execute(api, new AbortController().signal)).rejects.toThrow("lost response")
  expect(first.pending()?.requestID).toBe("logical-a")
  const restored = createKnowledgeUpdate(storage, "account-a", "project-a")
  expect(await restored.execute(api, new AbortController().signal)).toEqual(summary)
  expect(begins).toEqual([{ requestID: "logical-a", target, expectedRevision: 4 }])
  expect(changes).toEqual([
    {
      sequence: 0,
      changes: [{ itemID: "guide", reference: { itemID: "guide", version: 2, manifestHash: "2".repeat(64) } }],
    },
  ])
  expect(commits).toBe(1)
  expect(restored.pending()).toBeUndefined()
})

test("storage failure prevents staging a knowledge mutation", () => {
  const ledger = createKnowledgeUpdate(
    {
      getItem: () => null,
      setItem() {
        throw new Error("disk full")
      },
      removeItem() {},
    },
    "account-a",
    "project-a",
  )
  expect(() =>
    ledger.begin({
      requestID: "a",
      target: { kind: "member", projectID: "project-a" },
      expectedRevision: 0,
      change: { itemID: "guide" },
    }),
  ).toThrow("disk full")
})
