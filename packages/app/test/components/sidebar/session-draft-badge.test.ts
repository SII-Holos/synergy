import { describe, expect, test } from "bun:test"

const sidebar = await Bun.file(new URL("../../../src/components/sidebar/sidebar.tsx", import.meta.url)).text()
const badge = await Bun.file(new URL("../../../src/components/sidebar/session-draft-badge.tsx", import.meta.url)).text()

describe("sidebar session draft badge wiring", () => {
  test("session rows render the draft badge before the title", () => {
    const rowStart = sidebar.indexOf("function SidebarSessionRow")

    expect(rowStart).toBeGreaterThanOrEqual(0)

    const row = sidebar.slice(rowStart)
    const badgeIndex = row.indexOf("<SessionDraftBadge sessionID={props.entry.id} />")
    const titleIndex = row.indexOf('class={props.flyout ? "sb-flyout-session-title" : "sb-session-title"}')

    expect(badgeIndex).toBeGreaterThanOrEqual(0)
    expect(titleIndex).toBeGreaterThan(badgeIndex)
  })

  test("badge renders the bracketed localized label only for drafted sessions", () => {
    expect(badge).toContain("hasDraftSession(props.sessionID)")
    expect(badge).toContain("sb-session-draft-badge")
    expect(badge).toContain("sidebar.draftBadge")
  })
})
