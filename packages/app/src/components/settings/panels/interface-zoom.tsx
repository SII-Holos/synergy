import { useLingui } from "@lingui/solid"
import { SettingRow } from "../components/SettingRow"
import { createZoomSliderModel } from "./zoom-slider-model"

const copy = {
  zoomTitle: { id: "settings.general.zoom.title", message: "Interface zoom" },
  zoomDescription: {
    id: "settings.general.zoom.description",
    message: "Adjust the interface size of the desktop app",
  },
  zoomLow: { id: "settings.general.zoom.low", message: "Smaller" },
  zoomHigh: { id: "settings.general.zoom.high", message: "Larger" },
  zoomAria: { id: "settings.general.zoom.aria", message: "Interface zoom" },
} as const

export function InterfaceZoom(props: { zoom: number; onZoomChange: (factor: number) => void }) {
  const { _ } = useLingui()
  // Zoom rescales the whole page, so it is committed only on pointer release;
  // while dragging, the slider and percentage label stay local to avoid
  // rescaling the settings page under the pointer.
  const model = createZoomSliderModel(() => props.zoom, props.onZoomChange)
  const percent = () => Math.round(model.preview() * 100)

  return (
    <SettingRow
      title={_(copy.zoomTitle)}
      description={_(copy.zoomDescription)}
      trailing={
        <div class="settings-step-scale">
          <div class="settings-step-scale-header">
            <span>{percent()}%</span>
          </div>
          <input
            class="settings-step-scale-slider"
            type="range"
            min="50"
            max="200"
            step="1"
            value={percent()}
            aria-label={_(copy.zoomAria)}
            onInput={(event) => model.setPreview(Number(event.currentTarget.value) / 100)}
            onChange={(event) => model.commit(Number(event.currentTarget.value) / 100)}
          />
          <div class="settings-step-scale-meta">
            <span>{_(copy.zoomLow)}</span>
            <span />
            <span>{_(copy.zoomHigh)}</span>
          </div>
        </div>
      }
    />
  )
}
