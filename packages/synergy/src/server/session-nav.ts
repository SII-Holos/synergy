import { Hono } from "hono"
import { SessionNav, type NavCategory } from "../session/nav"
import { Instance } from "../scope/instance"

export const SessionNavRoute = new Hono().get("/index", async (c) => {
  const raw = c.req.query()
  const category = raw.category as string | undefined
  const parentOnly = category !== undefined ? false : raw.parentOnly === undefined || raw.parentOnly === "true"
  const includeArchived = raw.includeArchived === "true"

  if (category !== undefined && !["project", "home", "channel", "background"].includes(category)) {
    return c.json({ message: `Invalid category: ${category}` }, 400)
  }

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

  const result = await SessionNav.queryScope(Instance.scope.id, {
    parentOnly,
    category: category as NavCategory | undefined,
    includeArchived,
    cursor,
    limit,
  })
  return c.json(result)
})
