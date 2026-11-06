import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ResourceOpenProvider, type ResourceOpenController } from "@ericsanchezok/synergy-ui/context/resource-open"
import { ViewActivityProvider } from "@ericsanchezok/synergy-ui/context/view-activity"
import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme/context"
import { ImagePreview, type ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import { ImageViewer } from "@ericsanchezok/synergy-ui/image-viewer"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { SettingsDialogFrame } from "../../../src/components/settings/settings-dialog-frame"
import { createImageActions } from "../../../src/utils/image-actions"
import "@ericsanchezok/synergy-ui/styles"
import "../../../src/components/settings/settings-panel.css"

const svg = (width: number, height: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="gray"/></svg>`)}`
const initial = [
  { id: "first", src: svg(4000, 3000), filename: "large.svg", mime: "image/svg+xml", sourcePath: "large.svg" },
  { id: "same", src: svg(4000, 3000), filename: "same-source.svg", mime: "image/svg+xml" },
  { id: "small", src: svg(120, 80), filename: "small.svg", mime: "image/svg+xml" },
]
const [active, setActive] = createSignal(true)
let sourceMode = "immediate"
let finishSource = () => {}
const resources: ResourceOpenController = {
  open() {
    if (sourceMode === "throws") throw new Error("Source is unavailable")
    if (sourceMode === "held")
      return new Promise((resolve) => {
        finishSource = () => resolve({ status: "opened" })
      })
    return Promise.resolve({ status: "opened" })
  },
}
function Fixture() {
  const dialog = useDialog()
  const theme = useTheme()
  const [images, setImages] = createSignal<ImagePreviewImage[]>(initial)
  const actions = createImageActions({
    serverUrl: () => location.origin,
    translate: (descriptor) => descriptor.message ?? descriptor.id ?? "",
  })
  let finishCopy = () => {}
  Object.assign(window, {
    imageFixture: {
      setImages,
      setActive,
      theme: theme.setColorScheme,
      holdSource: () => {
        sourceMode = "held"
      },
      failSource: () => {
        sourceMode = "throws"
      },
      finishSource: () => finishSource(),
      holdCopy: () => {
        actions.copy = () =>
          new Promise((resolve) => {
            finishCopy = () => resolve("completed")
          })
      },
      finishCopy: () => finishCopy(),
    },
  })
  if (new URLSearchParams(location.search).has("inline"))
    return (
      <div style={{ height: "600px" }}>
        <ImageViewer images={images()} actions={actions} />
      </div>
    )
  return (
    <>
      <button onClick={() => dialog.show(() => <ImagePreview images={images()} actions={actions} />)}>
        Open images
      </button>
      <button
        onClick={() =>
          dialog.show(() => (
            <SettingsDialogFrame ariaLabel="Reference settings">
              <div class="settings-panel-frame">
                <button
                  class="settings-panel-close"
                  aria-label="Close reference settings"
                  onClick={() => dialog.close()}
                >
                  <Icon name={getSemanticIcon("action.close")} size="small" />
                </button>
              </div>
            </SettingsDialogFrame>
          ))
        }
      >
        Open reference settings
      </button>
    </>
  )
}
const i18n = setupI18n({ locale: "en", messages: {} })
render(
  () => (
    <I18nProvider i18n={i18n}>
      <ThemeProvider>
        <ResourceOpenProvider value={resources}>
          <ViewActivityProvider active={active}>
            <DialogProvider>
              <Fixture />
            </DialogProvider>
          </ViewActivityProvider>
        </ResourceOpenProvider>
      </ThemeProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
