import { expect, test } from "bun:test"
import { parseSkin, resolveSkinAppearance } from "../src/skin"

const skin = {
  version: 1,
  id: "studio",
  assets: { texture: { kind: "image", path: "assets/paper.webp" } },
  light: { parts: { workbench: { background: { asset: "texture" }, radius: 12 } } },
  dark: { parts: { workbench: { radius: 8 } } },
  narrow: { parts: { workbench: { radius: 0 } } },
  reducedMotion: { decorations: "hide" },
}

test("Skin validates its public visual parts and applies explicit mode and narrow defaults", () => {
  const parsed = parseSkin(skin)
  expect(resolveSkinAppearance(parsed, "light", false).parts.workbench?.radius).toBe(12)
  expect(resolveSkinAppearance(parsed, "dark", true).parts.workbench?.radius).toBe(0)
  expect(parsed.reducedMotion.decorations).toBe("hide")
})

test("Skin rejects escaping assets, undeclared images, global selectors and a second color system", () => {
  expect(() => parseSkin({ ...skin, assets: { texture: { kind: "image", path: "../secret" } } })).toThrow()
  expect(() => parseSkin({ ...skin, assets: {} })).toThrow("texture")
  expect(() => parseSkin({ ...skin, light: { parts: { body: {} } } })).toThrow()
  expect(() => parseSkin({ ...skin, light: { parts: { workbench: { color: "red" } } } })).toThrow()
  expect(() => parseSkin({ ...skin, css: "body{display:none}" })).toThrow()
})
