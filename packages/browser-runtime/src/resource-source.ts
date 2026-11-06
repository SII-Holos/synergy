import { ResourceSources } from "@ericsanchezok/synergy-harness/observability/resource-sources"
import { BrowserRuntime } from "./runtime"

async function snapshot(): Promise<ResourceSources.Snapshot> {
  const browser = BrowserRuntime.resourceStats()
  return {
    owner: "browser",
    ...browser,
    source: "browser_runtime",
    completeness:
      browser.processCount === 0 || browser.measuredProcessCount === browser.processCount ? "full" : "partial",
    attributes: {
      owners: browser.ownerCount,
      sessionOwners: browser.sessionOwnerCount,
      scopeOwners: browser.scopeOwnerCount,
      activePages: browser.activePageCount,
      hostPages: browser.hostPageCount,
      headlessPages: browser.headlessPageCount,
      suspendedPages: browser.suspendedPageCount,
    },
  }
}

export function registerResourceSource() {
  ResourceSources.register("browser", snapshot)
}
