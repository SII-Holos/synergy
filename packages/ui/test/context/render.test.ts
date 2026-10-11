import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { RenderArtifact } from "@ericsanchezok/synergy-util/render-artifact"
import { readRenderState } from "../../src/context/render"

describe("render state from the conversation store", () => {
  test("preserves JSON content and tracks reconciled updates as independent snapshots", () => {
    createRoot((dispose) => {
      try {
        const initial: RenderArtifact.State = {
          revision: 1,
          updatedAt: 1,
          content: { modelContent: { workers: 4 }, uiContent: { controls: { workers: "4" } } },
        }
        const [metadata, setMetadata] = createStore({ visualState: structuredClone(initial) })
        const state = createMemo(() => readRenderState(metadata))
        const first = state()
        expect(first).toEqual(initial)
        expect(structuredClone(first)).toEqual(initial)

        const updated: RenderArtifact.State = {
          revision: 2,
          updatedAt: 2,
          content: { modelContent: { workers: 8 }, uiContent: { controls: { workers: "8" } } },
        }
        setMetadata("visualState", reconcile(updated))
        expect(state()).toEqual(updated)
        expect(first.content.uiContent).toEqual({ controls: { workers: "4" } })

        setMetadata("visualState", reconcile({ revision: 3, updatedAt: 3, content: {} }))
        expect(state().content).toEqual({})
        expect(state().revision).toBe(3)
      } finally {
        dispose()
      }
    })
  })

  test("keeps the canonical fallback for missing or invalid state", () => {
    expect(readRenderState(undefined)).toEqual(RenderArtifact.emptyState())
    expect(readRenderState({ visualState: { revision: -1, updatedAt: 1, content: {} } })).toEqual(
      RenderArtifact.emptyState(),
    )
  })
})
