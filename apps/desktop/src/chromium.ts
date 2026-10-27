import type { CommandLine } from "electron"

export function configureDesktopChromium(app: {
  isReady(): boolean
  commandLine: Pick<CommandLine, "getSwitchValue" | "appendSwitch">
}): void {
  if (app.isReady()) throw new Error("Desktop Chromium must be configured before Electron is ready")
  const commandLine = app.commandLine
  const isCaptureFeature = (feature: string) => feature.trim().split(/[<:]/, 1)[0] === "CDPScreenshotNewSurface"
  if (commandLine.getSwitchValue("disable-features").split(",").some(isCaptureFeature)) {
    throw new Error("CDPScreenshotNewSurface cannot be disabled: Desktop requires it for hidden Browser capture")
  }
  const features = commandLine.getSwitchValue("enable-features").split(",").filter(Boolean)
  if (features.some(isCaptureFeature)) return
  // The legacy redraw path can stall without presentation; use Chromium's new-surface capture instead.
  // https://github.com/chromium/chromium/blob/152.0.7977.167/content/common/features.cc#L152-L155
  commandLine.appendSwitch("enable-features", [...features, "CDPScreenshotNewSurface"].join(","))
}
