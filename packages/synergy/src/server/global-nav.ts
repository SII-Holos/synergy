import { Hono } from "hono"
import { SessionNav } from "../session/nav"

export const GlobalNavRoute = new Hono()
  .get("/recent", async (c) => {
    const raw = c.req.query()
    const parentOnly = raw.parentOnly === undefined || raw.parentOnly === "true"
    const includeArchived = raw.includeArchived === "true"
    const search = raw.search

    let limit = 20
    if (raw.limit !== undefined) {
      const parsed = Number(raw.limit)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
        return c.json({ message: "limit must be between 1 and 200" }, 400)
      }
      limit = Math.floor(parsed)
    }

    let cursor: { lastActivityAt: number; id: string } | undefined
    if (raw.cursorLastActivityAt !== undefined && raw.cursorId !== undefined) {
      cursor = { lastActivityAt: Number(raw.cursorLastActivityAt), id: raw.cursorId }
    }

    const result = await SessionNav.queryGlobal({ parentOnly, includeArchived, search, cursor, limit })
    return c.json(result)
  })
  .get("/pinned", async (c) => {
    const raw = c.req.query()
    let limit: number | undefined
    if (raw.limit !== undefined) {
      const parsed = Number(raw.limit)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
        return c.json({ message: "limit must be between 1 and 200" }, 400)
      }
      limit = Math.floor(parsed)
    }

    const result = await SessionNav.queryPinned({ limit })
    return c.json(result)
  })
