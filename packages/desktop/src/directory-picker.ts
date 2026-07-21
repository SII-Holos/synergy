import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue, WebContents } from "electron"
import {
  parseSelectDirectoryDialogRequest,
  parseSelectDirectoryDialogResponse,
  type SelectDirectoryDialogResponse,
} from "./ipc-contract.js"
import type { DesktopServerStatus } from "./server-manager.js"

type NativeDirectoryDialog = (window: BrowserWindow, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>

export interface SelectDirectoryWithNativeDialogOptions {
  mainWindow: BrowserWindow | null
  sender: WebContents
  serverStatus: DesktopServerStatus | null | undefined
  showOpenDialog: NativeDirectoryDialog
  rawRequest: unknown
}

export async function selectDirectoryWithNativeDialog(
  options: SelectDirectoryWithNativeDialogOptions,
): Promise<SelectDirectoryDialogResponse> {
  if (!options.mainWindow || options.sender !== options.mainWindow.webContents) {
    throw new Error("Native directory picker is only available to the main desktop window")
  }

  if (options.serverStatus?.mode !== "managed" || options.serverStatus.state !== "running") {
    throw new Error("Native directory picker is only available with the managed local server")
  }

  const request = parseSelectDirectoryDialogRequest(options.rawRequest)
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

export type SelectDirectoryDialogBridgeResponse = SelectDirectoryDialogResponse

export function mapSelectDirectoryDialogResponse(
  response: SelectDirectoryDialogBridgeResponse,
  multiple: boolean,
): string | string[] | null {
  const directoryPaths = response.canceled ? [] : response.directoryPaths
  if (response.canceled) return null
  return multiple ? directoryPaths : (directoryPaths[0] ?? null)
}
