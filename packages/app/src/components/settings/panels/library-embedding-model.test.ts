import { describe, expect, test } from "bun:test"
import type { EmbeddingStatus } from "@ericsanchezok/synergy-sdk/client"
import { pollEmbeddingStatus } from "./library-embedding-model"

function localStatus(asset: "missing" | "downloading" | "cached" | "failed"): EmbeddingStatus {
  return {
    mode: "local",
    model: "Xenova/all-MiniLM-L6-v2",
    source: "huggingface",
    asset,
    runtime: asset === "cached" ? "ready" : asset === "downloading" ? "loading" : "unloaded",
  }
}

describe("library embedding model", () => {
  test("polls sequentially until the local model download reaches a terminal state", async () => {
    const states = [localStatus("downloading"), localStatus("downloading"), localStatus("cached")]
    const updates: EmbeddingStatus[] = []
    let active = 0
    let peak = 0

    const terminal = await pollEmbeddingStatus({
      signal: new AbortController().signal,
      intervalMs: 0,
      async load() {
        active++
        peak = Math.max(peak, active)
        const state = states.shift()!
        await Promise.resolve()
        active--
        return state
      },
      onUpdate(status) {
        updates.push(status)
      },
    })

    expect(peak).toBe(1)
    expect(updates.map((status) => (status.mode === "local" ? status.asset : status.mode))).toEqual([
      "downloading",
      "downloading",
      "cached",
    ])
    expect(terminal).toEqual(localStatus("cached"))
  })

  test("stops polling after the observer is aborted", async () => {
    const controller = new AbortController()
    let calls = 0

    const terminal = await pollEmbeddingStatus({
      signal: controller.signal,
      intervalMs: 0,
      async load() {
        calls++
        return localStatus("downloading")
      },
      onUpdate() {
        controller.abort()
      },
    })

    expect(calls).toBe(1)
    expect(terminal).toBeUndefined()
  })
})
