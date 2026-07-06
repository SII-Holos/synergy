/**
 * Frontend static contract tests for session workspace refactor.
 *
 * These tests assert source-level invariants that implementation agents
 * must satisfy. They are intentionally narrow: they check that specific
 * imports/patterns are removed or replaced with the expected new patterns.
 *
 * These are TEMPORARY source-contract tests because no SolidJS component
 * test harness exists for these components. Once a render-based test harness
 * is available, these should be replaced with behavioral tests.
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"

const APP_SRC = path.join(__dirname, "../../app/src")

describe("Workspace context contract", () => {
  const legacyFiles = [
    "context/workspace.tsx",
    "components/session/workspace-panel.tsx",
    "components/session/workspace-drawer.tsx",
    "components/session/workspace-rail.tsx",
    "components/session/terminal-panel.tsx",
  ]

  test("legacy workspace components must be removed", async () => {
    for (const relative of legacyFiles) {
      const file = Bun.file(path.join(APP_SRC, relative))
      expect(await file.exists()).toBe(false)
    }
  })
})

describe("SessionTopBar contract", () => {
  const topbarPath = path.join(APP_SRC, "components/top-bar/session-top-bar.tsx")

  test("session-top-bar.tsx exposes separate side and bottom toggles", async () => {
    const src = await fs.readFile(topbarPath, "utf-8")

    expect(src).not.toContain("Toggle workspace")
    expect(src).toContain("Open side workspace")
    expect(src).toContain("Open BottomSpace")
  })
})

describe("Workbench surface contract", () => {
  const layoutPath = path.join(APP_SRC, "pages/layout.tsx")
  const sessionPath = path.join(APP_SRC, "pages/session.tsx")
  const surfacePath = path.join(APP_SRC, "components/session/workbench-surface.tsx")

  test("session uses the unified workbench provider and surface", async () => {
    const sessionSrc = await fs.readFile(sessionPath, "utf-8")
    const layoutSrc = await fs.readFile(layoutPath, "utf-8")

    expect(layoutSrc).toContain("WorkbenchPanelsProvider")
    expect(sessionSrc).toContain('<WorkbenchSurface surface="side" />')
    expect(sessionSrc).toContain('<WorkbenchSurface surface="bottom" />')
    expect(sessionSrc).not.toContain("WorkspaceRail")
    expect(sessionSrc).not.toContain("TerminalPanel")
  })

  test("surface content labels come from panel registrations", async () => {
    const src = await fs.readFile(surfacePath, "utf-8")

    expect(src).toContain("panel.label")
    expect(src).toContain("workbench.panelTitle(tab)")
  })
})

describe("NotePanel contract", () => {
  const notePanelPath = path.join(APP_SRC, "components/note-panel.tsx")

  test("NotePanel must not call sdk.client.note.listAll in list fetch path", async () => {
    const src = await fs.readFile(notePanelPath, "utf-8")

    // Must not call listAll — use listMeta instead
    expect(src).not.toContain("note.listAll")
  })

  test("NotePanel list fetch must use listMeta", async () => {
    const src = await fs.readFile(notePanelPath, "utf-8")

    // Must call listMeta for the metadata-based list
    expect(src).toContain("listMeta")
  })

  test("NotePanel must not call NoteMarkdown.toMarkdown(n.content) in displayGroups/search path", async () => {
    const src = await fs.readFile(notePanelPath, "utf-8")

    // Must not call NoteMarkdown.toMarkdown on n.content for search/filter
    // The search should use searchText from metadata
    expect(src).not.toContain("NoteMarkdown.toMarkdown(n.content)")
  })

  test("NotePanel displayGroups search must use searchText instead of content", async () => {
    const src = await fs.readFile(notePanelPath, "utf-8")

    // Search filtering should use searchText (from metadata) not NoteMarkdown.toMarkdown
    const usesSearchText = src.includes(".searchText") || src.includes("searchText")
    expect(usesSearchText).toBe(true)
  })
})
