import { ToolRegistry } from "../tool/registry"
import { BrowserAnnotateTool } from "./tools/browser-annotate"
import { BrowserSnapshotTool } from "./tools/browser-snapshot"
import { BrowserScreenshotTool } from "./tools/browser-screenshot"
import { BrowserInspectTool } from "./tools/browser-inspect"
import { BrowserWaitTool } from "./tools/browser-wait"
import { BrowserConsoleTool } from "./tools/browser-console"
import { BrowserNetworkTool } from "./tools/browser-network"
import { BrowserDownloadsTool } from "./tools/browser-downloads"
import { BrowserReadTool } from "./tools/browser-read"
import { BrowserClipboardTool } from "./tools/browser-clipboard"
import { BrowserNavigationTool } from "./tools/browser-navigation"
import { BrowserAssetsTool } from "./tools/browser-assets"
import { BrowserActionTool } from "./tools/browser-action"
import { BrowserEvalTool } from "./tools/browser-eval"
import { BrowserViewTool } from "./tools/browser-view"
import { BrowserPerformanceTool } from "./tools/browser-performance"
import { BrowserAuditTool } from "./tools/browser-audit"
import { BrowserEmulateTool } from "./tools/browser-emulate"
import { BrowserDialogTool } from "./tools/browser-dialog"
import { BrowserUploadTool } from "./tools/browser-upload"

/**
 * Browser domain tool registration. Loaded through src/product-registration.ts.
 */
let registered = false

export function registerBrowserTools(): void {
  if (registered) return
  registered = true

  ToolRegistry.registerToolProvider("browser", () => [
    BrowserAnnotateTool,
    BrowserSnapshotTool,
    BrowserScreenshotTool,
    BrowserInspectTool,
    BrowserWaitTool,
    BrowserConsoleTool,
    BrowserNetworkTool,
    BrowserDownloadsTool,
    BrowserReadTool,
    BrowserClipboardTool,
    BrowserNavigationTool,
    BrowserAssetsTool,
    BrowserActionTool,
    BrowserEvalTool,
    BrowserViewTool,
    BrowserPerformanceTool,
    BrowserAuditTool,
    BrowserEmulateTool,
    BrowserDialogTool,
    BrowserUploadTool,
  ])
}
