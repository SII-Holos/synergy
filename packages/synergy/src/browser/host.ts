import {
  selectBrowserPresentation,
  type BrowserPresentationCapabilities,
  type BrowserPresentationEnvironment,
  type BrowserPresentationSelection,
} from "@ericsanchezok/synergy-browser"
import { BrowserBroker } from "./broker.js"

export namespace BrowserHost {
  export function capabilities(): BrowserPresentationCapabilities {
    return BrowserBroker.capabilities()
  }

  export function presentation(
    input: Omit<BrowserPresentationEnvironment, "capabilities">,
  ): BrowserPresentationSelection {
    return selectBrowserPresentation({ ...input, capabilities: capabilities() })
  }
}
