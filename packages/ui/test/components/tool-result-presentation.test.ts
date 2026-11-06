import { describe, expect, test } from "bun:test"
import {
  isMediaGenerationToolPart,
  isToolCardHidden,
  toolDisplayMetadata,
  toolFeatureAvailable,
  toolRequiredFeatures,
} from "../../src/components/tool-result-presentation"

describe("tool result display metadata", () => {
  test("reads declarative display metadata from tool state", () => {
    const display = {
      kind: "media-generation" as const,
      toolCard: "hidden" as const,
      media: { type: "image" as const, aspectRatio: "1:1" as const, size: "small" as const },
    }

    expect(
      toolDisplayMetadata({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display },
        },
      }),
    ).toEqual(display)
  })

  test("recognizes declarative media generation throughout its lifecycle", () => {
    for (const status of ["pending", "generating", "running", "completed", "error"]) {
      const part = {
        type: "tool",
        state: {
          status,
          input: { prompt: "make a meme" },
          metadata: {
            display: {
              kind: "media-generation",
              media: { type: "image" },
            },
          },
        },
      }

      expect(isMediaGenerationToolPart(part)).toBe(true)
    }
  })

  test("detects explicit hidden tool cards only", () => {
    expect(
      isToolCardHidden({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation", toolCard: "hidden" } },
        },
      }),
    ).toBe(true)

    expect(
      isToolCardHidden({
        type: "tool",
        state: {
          status: "completed",
          metadata: { display: { kind: "media-generation" } },
        },
      }),
    ).toBe(false)
  })
})

test("optional tool presentation requires its independently selected owner", () => {
  expect(toolRequiredFeatures({ tool: "workbench_view" })).toEqual(["workbench"])
  expect(toolFeatureAvailable({ tool: "workbench_view" }, () => false)).toBe(false)
  expect(toolFeatureAvailable({ tool: "workbench_view" }, (id) => id === "workbench")).toBe(true)
  expect(toolFeatureAvailable({ tool: "note_read" })).toBe(false)
  expect(toolFeatureAvailable({ tool: "bash" })).toBe(true)
  const agendaOnly = (feature: string) => feature === "agenda"
  expect(toolFeatureAvailable({ tool: "agenda_list" }, agendaOnly)).toBe(true)
  expect(toolFeatureAvailable({ tool: "note_read" }, agendaOnly)).toBe(false)
  const noteOnly = (feature: string) => feature === "note"
  expect(toolFeatureAvailable({ tool: "note_read", state: { input: null } }, noteOnly)).toBe(true)
  expect(toolFeatureAvailable({ tool: "note_read", state: { metadata: { kind: "blueprint" } } }, noteOnly)).toBe(false)
  expect(toolFeatureAvailable({ tool: "note_list", state: { input: { kind: "blueprint" } } }, noteOnly)).toBe(false)
  expect(toolFeatureAvailable({ tool: "note_read", state: { metadata: { kind: "blueprint" } } }, () => true)).toBe(true)
})

test("media, MCP and plugin tools require their public owner even for historical display", () => {
  for (const [tool, owner] of [
    ["lsp", "lsp"],
    ["look_at", "media"],
    ["mcp__fixture__search", "mcp"],
    ["plugin__fixture__search", "plugin-host"],
  ]) {
    expect(toolFeatureAvailable({ tool }, () => false)).toBe(false)
    expect(toolFeatureAvailable({ tool }, (id) => id === owner)).toBe(true)
  }
})

test("historical tool metadata preserves every source owner without replacing the legacy tool owner", () => {
  const part = {
    tool: "blueprint_loop_approve",
    state: { metadata: { requiredFeatures: ["blueprint", "lattice"] } },
  }
  expect(toolRequiredFeatures(part)).toEqual(["blueprint", "lattice"])
  expect(toolFeatureAvailable(part, (id) => id === "blueprint")).toBe(false)
  expect(toolFeatureAvailable(part, (id) => ["blueprint", "lattice"].includes(id))).toBe(true)
  expect(
    toolFeatureAvailable({ ...part, state: { metadata: { requiredFeatures: ["lattice"] } } }, (id) => id === "lattice"),
  ).toBe(false)
  expect(toolFeatureAvailable({ tool: "blueprint_loop_approve" }, (id) => id === "blueprint")).toBe(true)
  const plugin = {
    tool: "blueprint_loop_stop",
    state: { metadata: { requiredFeatures: ["blueprint", "plugin-host", "plugin-blueprint"] } },
  }
  expect(toolFeatureAvailable(plugin, (id) => ["blueprint", "plugin-host"].includes(id))).toBe(false)
  expect(toolFeatureAvailable(plugin, (id) => ["blueprint", "plugin-host", "plugin-blueprint"].includes(id))).toBe(true)
})
