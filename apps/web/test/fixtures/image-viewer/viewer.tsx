import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { setupI18n } from "@lingui/core"
import { I18nProvider } from "@lingui/solid"
import { DialogProvider, useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ThemeProvider, useTheme } from "@ericsanchezok/synergy-ui/theme/context"
import { ImagePreview, type ImagePreviewImage } from "@ericsanchezok/synergy-ui/image-preview"
import { createImageActions } from "../../../src/utils/image-actions"
import "@ericsanchezok/synergy-ui/styles"

const svg = (width: number, height: number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="gray"/></svg>`)}`
const initial = [
  { id: "first", src: svg(4000, 3000), filename: "large.svg", mime: "image/svg+xml" },
  { id: "same", src: svg(4000, 3000), filename: "same-source.svg", mime: "image/svg+xml" },
  { id: "small", src: svg(120, 80), filename: "small.svg", mime: "image/svg+xml" },
]
function Fixture() {
  const dialog = useDialog()
  const theme = useTheme()
  const [images, setImages] = createSignal<ImagePreviewImage[]>(initial)
  const actions = createImageActions({
    serverUrl: () => location.origin,
    translate: (descriptor) => descriptor.message ?? descriptor.id ?? "",
  })
  Object.assign(window, { imageFixture: { setImages, theme: theme.setColorScheme } })
  return (
    <button onClick={() => dialog.show(() => <ImagePreview images={images()} actions={actions} />)}>Open images</button>
  )
}
const i18n = setupI18n({ locale: "en", messages: {} })
render(
  () => (
    <I18nProvider i18n={i18n}>
      <ThemeProvider>
        <DialogProvider>
          <Fixture />
        </DialogProvider>
      </ThemeProvider>
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
