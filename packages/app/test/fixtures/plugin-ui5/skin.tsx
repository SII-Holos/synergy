import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { parseSkin } from "@ericsanchezok/synergy-plugin/skin"
import { skinStyles } from "@ericsanchezok/synergy-ui/plugin/skin"
import font from "@ericsanchezok/synergy-ui/fonts/inter.woff2?url"

const skin = parseSkin({
  version: 1,
  id: "material",
  assets: { font: { kind: "font", path: "assets/inter.woff2" }, texture: { kind: "image", path: "assets/paper.svg" } },
  light: {
    typography: { sans: "font" },
    parts: {
      workbench: {
        radius: 24,
        background: { asset: "texture", opacity: 0.4 },
        decoration: { asset: "texture", width: 30, height: 90 },
      },
    },
  },
  dark: {
    typography: { sans: "font" },
    parts: { workbench: { radius: 8, background: { asset: "texture", opacity: 0.2 } } },
  },
  narrow: { parts: { workbench: { radius: 0 } } },
  reducedMotion: { decorations: "hide" },
})
function Fixture() {
  const [mode, setMode] = createSignal<"light" | "dark">("light")
  const [narrow, setNarrow] = createSignal(false)
  const [reduce, setReduce] = createSignal(false)
  const [custom, setCustom] = createSignal(false)
  const [enabled, setEnabled] = createSignal(true)
  const css = createMemo(() =>
    enabled()
      ? skinStyles({
          id: "test:material",
          skin,
          assets: {
            font,
            texture: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
          },
          mode: mode(),
          narrow: narrow(),
          reducedMotion: reduce(),
          customFonts: { sans: custom(), mono: false },
        })
      : "",
  )
  return (
    <>
      <button id="mode" onClick={() => setMode(mode() === "light" ? "dark" : "light")}>
        Mode
      </button>
      <button id="narrow" onClick={() => setNarrow(!narrow())}>
        Narrow
      </button>
      <button id="motion" onClick={() => setReduce(!reduce())}>
        Motion
      </button>
      <button id="custom" onClick={() => setCustom(!custom())}>
        Custom font
      </button>
      <button id="disable" onClick={() => setEnabled(false)}>
        Disable
      </button>
      <div data-skin-root="test:material" style={{ "--font-family-sans": custom() ? '"Courier New"' : undefined }}>
        <style>{css()}</style>
        <section
          id="surface"
          data-ui-part="workbench"
          style={{ width: "320px", height: "240px", "font-family": "var(--font-family-sans)" }}
        >
          <button id="interaction">Interact</button>
        </section>
      </div>
      <div id="host" data-ui-part="workbench">
        Protected host
      </div>
    </>
  )
}
render(() => <Fixture />, document.getElementById("root")!)
