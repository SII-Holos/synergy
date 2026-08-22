import { describe, expect, test } from "bun:test"
import { JSDOM } from "jsdom"
import { petPage } from "../src/pet-page.js"
import { PET_ANIMATIONS, type PetSettingsV1, type PetSpriteSheet } from "../src/pet-types.js"

const settings: PetSettingsV1 = {
  version: 1,
  enabled: true,
  spritePath: "",
  width: 160,
  height: 140,
  position: null,
  idleTimeoutMs: 300_000,
  frameMs: 120,
}

const sprite: PetSpriteSheet = {
  dataUrl: "data:image/png;base64,AAAA",
  columns: 8,
  rows: 7,
  frameMs: 120,
}

describe("pet page", () => {
  test("returns a data URL document with a strict CSP", () => {
    const url = petPage({ settings, sprite })
    expect(url).toStartWith("data:text/html,")
    const html = decodeURIComponent(url.slice("data:text/html,".length))
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("script-src 'unsafe-inline'")
  })

  test("embeds the sprite payload and the mood-to-row mapping", () => {
    const html = decodeURIComponent(petPage({ settings, sprite }).slice("data:text/html,".length))
    expect(html).toContain("data:image/png;base64,AAAA")
    expect(html).toContain("MOOD_ROW")
    // All seven animations map to a sprite row.
    for (const animation of PET_ANIMATIONS) {
      expect(html).toContain(animation)
    }
  })

  test("falls back to a CSS-only page when no sprite is configured", () => {
    const html = decodeURIComponent(
      petPage({ settings, sprite: { ...sprite, dataUrl: null } }).slice("data:text/html,".length),
    )
    expect(html).toContain("pet-fallback")
    expect(html).not.toContain("data:image/png;base64,AAAA")
  })

  test("escapes sprite data URLs so quotes cannot break out of the document", () => {
    const malicious: PetSpriteSheet = { ...sprite, dataUrl: 'data:image/png;base64,AAAA" onerror="alert(1)' }
    const html = decodeURIComponent(petPage({ settings, sprite: malicious }).slice("data:text/html,".length))
    expect(html).not.toContain('onerror="alert(1)')
  })
})

interface PetBridge {
  poke(): Promise<{ ok: boolean }>
  moveBy(dx: number, dy: number): Promise<{ ok: boolean }>
  dragBy(dx: number, dy: number): Promise<{ ok: boolean }>
  setDragging(dragging: boolean): Promise<{ ok: boolean }>
  getState(): Promise<{ ok: boolean }>
  onState(listener: (state: unknown) => void): () => void
  onSettings(listener: (settings: unknown) => void): () => void
  onSprite(listener: (sprite: unknown) => void): () => void
}

describe("pet page drag gesture", () => {
  function loadPage(bridge: PetBridge): JSDOM {
    const html = decodeURIComponent(
      petPage({ settings, sprite: { ...sprite, dataUrl: null } }).slice("data:text/html,".length),
    )
    return new JSDOM(html, {
      runScripts: "dangerously",
      url: "data:text/html,",
      pretendToBeVisual: true,
      beforeParse(window) {
        ;(window as unknown as { synergyPet: PetBridge }).synergyPet = bridge
        window.Element.prototype.setPointerCapture = () => {}
        // jsdom does not implement PointerEvent; polyfill the minimal surface
        // the page uses (clientX/clientY/pointerId).
        if (typeof window.PointerEvent !== "function") {
          class PointerEventPolyfill extends window.MouseEvent {
            readonly pointerId: number
            constructor(type: string, init: Record<string, unknown> = {}) {
              super(type, init)
              this.pointerId = typeof init.pointerId === "number" ? init.pointerId : 0
            }
          }
          ;(window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
            PointerEventPolyfill as unknown as typeof PointerEvent
        }
      },
    })
  }

  function recordingBridge(calls: string[]): PetBridge {
    return {
      poke: () => {
        calls.push("poke")
        return Promise.resolve({ ok: true })
      },
      moveBy: (dx: number, dy: number) => {
        calls.push(`moveBy:${dx}:${dy}`)
        return Promise.resolve({ ok: true })
      },
      dragBy: (dx: number, dy: number) => {
        calls.push(`dragBy:${dx}:${dy}`)
        return Promise.resolve({ ok: true })
      },
      setDragging: (dragging: boolean) => {
        calls.push(`setDragging:${dragging}`)
        return Promise.resolve({ ok: true })
      },
      getState: () => Promise.resolve({ ok: true }),
      onState: () => () => {},
      onSettings: () => () => {},
      onSprite: () => () => {},
    }
  }

  test("a drag past the threshold moves the window through the dragBy bridge", () => {
    const calls: string[] = []
    const dom = loadPage(recordingBridge(calls))
    try {
      const window = dom.window as unknown as {
        document: Document
        PointerEvent: typeof PointerEvent
      }
      const stage = window.document.getElementById("stage")!
      stage.dispatchEvent(
        new window.PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, pointerId: 1 }),
      )
      stage.dispatchEvent(
        new window.PointerEvent("pointermove", { bubbles: true, clientX: 20, clientY: 15, pointerId: 1 }),
      )
      stage.dispatchEvent(
        new window.PointerEvent("pointermove", { bubbles: true, clientX: 25, clientY: 20, pointerId: 1 }),
      )
      stage.dispatchEvent(
        new window.PointerEvent("pointerup", { bubbles: true, clientX: 25, clientY: 20, pointerId: 1 }),
      )
      expect(calls).toContain("setDragging:true")
      expect(calls).toContain("setDragging:false")
      expect(calls).toContain("dragBy:5:5")
      expect(calls).not.toContain("moveBy:5:5")
    } finally {
      dom.window.close()
    }
  })

  test("hover movement without a pressed pointer never enters drag", () => {
    const calls: string[] = []
    const dom = loadPage(recordingBridge(calls))
    try {
      const window = dom.window as unknown as {
        document: Document
        PointerEvent: typeof PointerEvent
      }
      const stage = window.document.getElementById("stage")!
      // No pointerdown: moving the cursor across the pet is hover, not drag.
      stage.dispatchEvent(
        new window.PointerEvent("pointermove", { bubbles: true, clientX: 120, clientY: 120, pointerId: 1 }),
      )
      stage.dispatchEvent(
        new window.PointerEvent("pointermove", { bubbles: true, clientX: 150, clientY: 140, pointerId: 1 }),
      )
      expect(calls).toEqual([])
    } finally {
      dom.window.close()
    }
  })
})
