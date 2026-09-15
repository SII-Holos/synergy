import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, WebContents } from "electron"
import {
  parseSelectDirectoryDialogRequest,
  parseSelectDirectoryDialogResponse,
  type SelectDirectoryDialogResponse,
} from "./ipc-contract.js"
import { probePortalFileAccess, type PortalFileAccessProbe } from "./portal-probe.js"
import type { DesktopServerStatus } from "./server-manager.js"

export const PORTAL_DENIED_MESSAGE = "Portal file dialogs are not allowed for this process"

export type PortalDeniedDialogResponse = {
  denied: true
  message: string
}

export type SelectDirectoryDialogBridgeResponse = SelectDirectoryDialogResponse | PortalDeniedDialogResponse

type NativeDirectoryDialog = (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>
type PortalProbe = () => Promise<PortalFileAccessProbe>

export interface SelectDirectoryWithNativeDialogOptions {
  mainWindow: BrowserWindow | null
  sender: WebContents
  serverStatus: DesktopServerStatus | null | undefined
  showOpenDialog: NativeDirectoryDialog
  rawRequest: unknown
  probePortalFileAccess?: PortalProbe
}

let cachedProbeResult: Exclude<PortalFileAccessProbe, "unavailable"> | null = null

// Process credentials are fixed at exec time, so an allowed or denied verdict
// stays valid for the whole desktop run; only unavailable probes are retried.
function cachedPortalProbe(): Promise<PortalFileAccessProbe> {
  if (cachedProbeResult) return Promise.resolve(cachedProbeResult)
  return probePortalFileAccess().then((result) => {
    if (result !== "unavailable") cachedProbeResult = result
    return result
  })
}

export async function selectDirectoryWithNativeDialog(
  options: SelectDirectoryWithNativeDialogOptions,
): Promise<SelectDirectoryDialogBridgeResponse> {
  if (!options.mainWindow || options.sender !== options.mainWindow.webContents) {
    throw new Error("Native directory picker is only available to the main desktop window")
  }

  if (options.serverStatus?.mode !== "managed" || options.serverStatus.state !== "running") {
    throw new Error("Native directory picker is only available with the managed local server")
  }

  const request = parseSelectDirectoryDialogRequest(options.rawRequest)
  const probe = options.probePortalFileAccess ?? cachedPortalProbe
  if ((await probe()) === "denied") {
    return { denied: true, message: PORTAL_DENIED_MESSAGE }
  }
  const result = await options.showOpenDialog(options.mainWindow, {
    title: request.title,
    properties: request.multiple ? ["openDirectory", "multiSelections"] : ["openDirectory"],
  })
  const directoryPaths = result.canceled ? [] : result.filePaths
  if (!request.multiple && directoryPaths.length > 1) {
    throw new Error("Native directory picker returned multiple paths for a single-selection request")
  }

  return parseSelectDirectoryDialogResponse({
    canceled: result.canceled,
    directoryPaths,
  })
}

export function mapSelectDirectoryDialogResponse(
  response: SelectDirectoryDialogBridgeResponse,
  multiple: boolean,
): string | string[] | null {
  if ("denied" in response) {
    const error = new Error(response.message)
    error.name = "PortalPermissionError"
    throw error
  }
  const directoryPaths = response.canceled ? [] : response.directoryPaths
  if (response.canceled) return null
  return multiple ? directoryPaths : (directoryPaths[0] ?? null)
}
