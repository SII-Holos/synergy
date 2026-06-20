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
  const workspacePath = path.join(APP_SRC, "context/workspace.tsx")

  test("workspace.tsx must not import usePanel", async () => {
    const src = await fs.readFile(workspacePath, "utf-8")

    // Must not import usePanel from ./panel
    expect(src).not.toContain('import { usePanel } from "./panel"')
    expect(src).not.toMatch(/usePanel/)
  })

  test("workspace.tsx must not intercept panel note toggle", async () => {
    const src = await fs.readFile(workspacePath, "utf-8")

    // Must not have the old intercept effect
    expect(src).not.toContain("panel.active()")
    expect(src).not.toContain("panel.close()")
    expect(src).not.toContain('ws().setActive("notes")')
  })
})

describe("SessionTopBar contract", () => {
  const topbarPath = path.join(APP_SRC, "components/top-bar/session-top-bar.tsx")

  test("session-top-bar.tsx must not use generic Toggle workspace button", async () => {
    const src = await fs.readFile(topbarPath, "utf-8")

    // Must not contain the old generic Toggle workspace tooltip/button
    expect(src).not.toContain("Toggle workspace")
    expect(src).not.toContain("panel-right")
  })
})

describe("WorkspacePanel contract", () => {
  const panelPath = path.join(APP_SRC, "components/session/workspace-panel.tsx")

  test("workspace-panel.tsx header label must be dynamic", async () => {
    const src = await fs.readFile(panelPath, "utf-8")

    // The label in the header should come from the active tool, not hardcoded
    expect(src).toContain("tool()?.label")
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
