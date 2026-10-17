import { expect, test } from "bun:test"
import { RenderArtifact } from "../src/render-artifact"

test("state bounds UTF-8 bytes across both channels and rejects non-JSON values", () => {
  expect(RenderArtifact.Content.safeParse({ modelContent: "中".repeat(6000) }).success).toBe(false)
  expect(
    RenderArtifact.Content.safeParse({ modelContent: "a".repeat(9000), uiContent: "b".repeat(9000) }).success,
  ).toBe(false)
  expect(RenderArtifact.Content.safeParse({ modelContent: { value: Infinity } }).success).toBe(false)
  expect(RenderArtifact.Content.safeParse({ uiContent: { nested: [1, null, true] } }).success).toBe(true)
})

test("render identity cannot be granted by MIME or malformed metadata", () => {
  expect(RenderArtifact.descriptor({ mime: RenderArtifact.MIME })).toBeUndefined()
  expect(RenderArtifact.descriptor({ visual: { source: "https://example.com/page.html" } })).toBeUndefined()
  expect(RenderArtifact.Target.safeParse({ sessionID: "ses_a", messageID: "msg_b", partID: "../c" }).success).toBe(
    false,
  )
  expect(RenderArtifact.FollowUp.safeParse({ requestID: "one", text: " ", tool: "bash" }).success).toBe(false)
})

test("structured-clone cycles are rejected without throwing out of validation", () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  expect(RenderArtifact.Content.safeParse({ modelContent: cycle }).success).toBe(false)
})

test("native sources retain a static fallback and cannot acquire script-library authority", () => {
  const source = {
    format: "synergy.visual",
    version: 1,
    id: "00000000-0000-4000-8000-000000000000",
    mode: "interactive",
    title: "Estimate",
    layout: "normal",
    libraries: [],
    html: "<p>Fallback</p>",
    renderer: "native",
  }
  expect(RenderArtifact.Source.safeParse(source).success).toBe(false)
  const ui = { nodes: [{ id: "summary", type: "text", text: "Estimate" }] }
  expect(RenderArtifact.Source.safeParse({ ...source, ui }).success).toBe(true)
  expect(RenderArtifact.Source.safeParse({ ...source, ui, libraries: ["chart"] }).success).toBe(false)
})
