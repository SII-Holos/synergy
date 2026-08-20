import { describe, expect, test } from "bun:test"
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
