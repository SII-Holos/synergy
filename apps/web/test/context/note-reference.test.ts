import { describe, expect, test } from "bun:test"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { noteReferenceExcerpt, resolveNoteReference } from "../../src/context/note-reference"

function clientFor(active: unknown[], archived: unknown[]) {
  const requests: Request[] = []
  const client = createSynergyClient({
    baseUrl: "http://notes.test",
    fetch: Object.assign(
      async (input: RequestInfo | URL) => {
        const request = input as Request
        requests.push(request)
        const url = new URL(request.url)
        return Response.json(url.searchParams.get("archived") === "true" ? archived : active)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  return { client, requests }
}

const group = (scopeID: string, ...ids: string[]) => ({ scopeID, notes: ids.map((id) => ({ id })) })
const paragraph = (text: string, blockId?: string) => ({
  type: "paragraph",
  ...(blockId ? { attrs: { blockId } } : {}),
  content: [{ type: "text", text }],
})

describe("Note reference resolution", () => {
  test("finds the current Scope after a move without fetching document bodies", async () => {
    const { client, requests } = clientFor([group("original", "other"), group("moved", "note")], [])
    const signal = new AbortController().signal
    expect(await resolveNoteReference(client, "original", "note", signal)).toEqual({ id: "note", scopeID: "moved" })
    expect(requests).toHaveLength(2)
    expect(requests.every((request) => new URL(request.url).pathname === "/note/meta")).toBe(true)
    expect(requests.every((request) => new URL(request.url).searchParams.get("scopeID") === "original")).toBe(true)
  })

  test("includes archived and Home notes and deduplicates one Scope", async () => {
    const { client } = clientFor([group("home", "note")], [group("home", "note")])
    expect(await resolveNoteReference(client, undefined, "note")).toEqual({ id: "note", scopeID: "home" })
    const archived = clientFor([], [group("archived-project", "note")])
    expect(await resolveNoteReference(archived.client, "home", "note")).toEqual({
      id: "note",
      scopeID: "archived-project",
    })
  })

  test("reports missing and ambiguous references instead of choosing a Scope", async () => {
    const missing = clientFor([group("home", "other")], [])
    await expect(resolveNoteReference(missing.client, "home", "note")).rejects.toThrow("not found")
    const ambiguous = clientFor([group("home", "note")], [group("project", "note")])
    await expect(resolveNoteReference(ambiguous.client, "home", "note")).rejects.toThrow("multiple Scopes")
  })

  test("does not resolve an already cancelled request", async () => {
    const { client, requests } = clientFor([group("home", "note")], [])
    const controller = new AbortController()
    controller.abort()
    await expect(resolveNoteReference(client, "home", "note", controller.signal)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })

  test("preserves metadata request failures instead of reporting a missing note", async () => {
    const client = createSynergyClient({
      baseUrl: "http://notes.test",
      fetch: Object.assign(async () => Response.json({ message: "Metadata unavailable" }, { status: 503 }), {
        preconnect: fetch.preconnect,
      }),
    })
    await expect(resolveNoteReference(client, "home", "note")).rejects.toMatchObject({
      message: "Metadata unavailable",
    })
  })

  test("rejects late metadata after cancellation even when the transport finishes", async () => {
    const replies: Array<(response: Response) => void> = []
    const requests: Request[] = []
    const client = createSynergyClient({
      baseUrl: "http://notes.test",
      fetch: Object.assign(
        (input: RequestInfo | URL) =>
          new Promise<Response>((resolve) => {
            requests.push(input as Request)
            replies.push(resolve)
          }),
        { preconnect: fetch.preconnect },
      ),
    })
    const controller = new AbortController()
    const pending = resolveNoteReference(client, "home", "note", controller.signal)
    await Bun.sleep(0)
    expect(replies).toHaveLength(2)
    controller.abort()
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
    replies.forEach((reply) => reply(Response.json([group("home", "note")])))
    await expect(pending).rejects.toThrow()
  })
})

describe("Note reference excerpts", () => {
  const content = {
    type: "doc",
    content: [
      paragraph("Opening text"),
      { type: "heading", attrs: { level: 2, blockId: "blk_goal" }, content: [{ type: "text", text: "Goal" }] },
      { type: "blockquote", attrs: { blockId: "blk_quote" }, content: [paragraph("Draft target text", "blk_nested")] },
      paragraph("Related detail"),
      {
        type: "heading",
        attrs: { level: 2, blockId: "blk_other" },
        content: [{ type: "text", text: "Other section" }],
      },
    ],
  }

  test("extracts plain text around a stable heading and nested block without mutating the draft", () => {
    const before = structuredClone(content)
    const heading = noteReferenceExcerpt(content, "blk_goal")
    expect(heading.found).toBe(true)
    expect(heading.text).toContain("Goal")
    expect(heading.text).toContain("Draft target text")
    expect(heading.text).not.toContain("Opening text")
    expect(heading.text).not.toContain("Other section")
    expect(noteReferenceExcerpt(content, "blk_nested")).toEqual({ text: "Draft target text", found: true })
    expect(content).toEqual(before)
  })

  test("does not guess a heading slug or display an unrelated excerpt for a missing block", () => {
    expect(noteReferenceExcerpt(content, "goal")).toEqual({ text: "", found: false })
    expect(noteReferenceExcerpt(content, "blk_deleted")).toEqual({ text: "", found: false })
    expect(noteReferenceExcerpt(content).text).toContain("Opening text")
    expect(noteReferenceExcerpt(content).found).toBe(true)
  })

  test("handles empty or unsupported content and bounds a long plain-text preview", () => {
    expect(noteReferenceExcerpt(null)).toEqual({ text: "", found: false })
    expect(noteReferenceExcerpt({ type: "doc", content: "malformed" })).toEqual({ text: "", found: false })
    expect(noteReferenceExcerpt({ type: "doc", content: [] })).toEqual({ text: "", found: true })
    const excerpt = noteReferenceExcerpt(
      { type: "doc", content: [paragraph("text ".repeat(1000), "blk_long")] },
      "blk_long",
    )
    expect(excerpt.found).toBe(true)
    expect(excerpt.text.length).toBeLessThanOrEqual(481)
    expect(excerpt.text.endsWith("…")).toBe(true)
  })
})
