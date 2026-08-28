import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("GeneralPanel toast mute markup", () => {
  test("does not nest Kobalte Switch inside a native label", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain('<div class="settings-muted-toggle">')
    expect(source).not.toMatch(/<label class="settings-muted-toggle">/)
    expect(source).toContain('props.onGeneralChange("mutedToasts"')
    expect(source).toContain("nextMutedToasts")
  })
})

describe("GeneralPanel activity display markup", () => {
  test("renders the activity display preference as a SegmentPill row in Appearance", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain("activityDisplayTitle")
    expect(source).toContain("activityDisplayDescription")
    expect(source).toContain("props.general.activityDisplay")
    expect(source).toContain('value: "full"')
    expect(source).toContain('value: "balanced"')
    expect(source).toContain('value: "minimal"')
  })

  test("uses statically extractable Lingui descriptors for activity display copy", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain('activityDisplayTitle: { id: "settings.general.activityDisplay.title"')
    expect(source).toContain('id: "settings.general.activityDisplay.description"')
    expect(source).toContain('id: "settings.general.activityDisplay.full"')
    expect(source).toContain('id: "settings.general.activityDisplay.balanced"')
    expect(source).toContain('id: "settings.general.activityDisplay.minimal"')
  })
})

describe("GeneralPanel new session workspace markup", () => {
  test("exposes the workspace selection to assistive technology", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain('id: "settings.general.workspace.title"')
    expect(source).toContain("ariaLabel={_(copy.workspaceTitle)}")
    const segmentSource = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/components/SegmentPill.tsx"),
      "utf8",
    )
    expect(segmentSource).toContain('role="group"')
    expect(segmentSource).toContain("aria-pressed={props.value === option.value}")
  })
})

describe("GeneralPanel interface zoom markup", () => {
  test("gates the zoom row behind the desktop zoom bridge", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/GeneralPanel.tsx"),
      "utf8",
    )
    expect(source).toContain("<Show when={platform.desktopZoom}>")
    expect(source).toMatch(/<InterfaceZoom\s+zoom=/)
  })

  test("renders a continuous zoom slider spanning the desktop shell range", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/interface-zoom.tsx"),
      "utf8",
    )
    expect(source).toMatch(/type="range"/)
    expect(source).toMatch(/min="50"/)
    expect(source).toMatch(/max="200"/)
    expect(source).toMatch(/step="1"/)
    expect(source).toMatch(/onChange=\{\(event\) => model\.commit\(Number\(event\.currentTarget\.value\) \/ 100\)\}/)
  })

  test("previews on input and commits on pointer release", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/interface-zoom.tsx"),
      "utf8",
    )
    expect(source).toMatch(/onInput=\{\(event\) => model\.setPreview\(Number\(event\.currentTarget\.value\) \/ 100\)\}/)
    expect(source).toMatch(/onChange=\{\(event\) => model\.commit\(Number\(event\.currentTarget\.value\) \/ 100\)\}/)
  })

  test("uses statically extractable Lingui descriptors for zoom copy", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../../src/components/settings/panels/interface-zoom.tsx"),
      "utf8",
    )
    expect(source).toContain('zoomTitle: { id: "settings.general.zoom.title"')
    expect(source).toContain('id: "settings.general.zoom.description"')
    expect(source).toContain('id: "settings.general.zoom.low"')
    expect(source).toContain('id: "settings.general.zoom.high"')
    expect(source).toContain('id: "settings.general.zoom.aria"')
  })
})
