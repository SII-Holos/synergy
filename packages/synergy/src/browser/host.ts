import {
  BROWSER_PROTOCOL_VERSION,
  selectBrowserPresentation,
  type BrowserPresentationCapabilities,
  type BrowserPresentationEnvironment,
  type BrowserPresentationSelection,
} from "@ericsanchezok/synergy-util/browser-protocol"
import type { BrowserInstall } from "./install.js"
import { BrowserOwner } from "./owner.js"
import { BrowserRuntime } from "./runtime.js"
import type { BrowserSession } from "./types.js"
import { BrowserControl } from "./control.js"

export namespace BrowserHost {
  export interface RuntimeAdapter {
    ensure(): Promise<unknown>
    health(): Promise<BrowserInstall.Health>
    getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession>
  }

  export interface EnsureSessionOptions {
    createInitialTab?: boolean
  }

  const hostCapabilities: BrowserPresentationCapabilities = {
    native: true,
    webrtc: true,
    screenshotFallback: false,
  }

  let runtime: RuntimeAdapter = BrowserRuntime

  export const protocolVersion = BROWSER_PROTOCOL_VERSION

  export function capabilities(): BrowserPresentationCapabilities {
    return hostCapabilities
  }

  export function presentation(input: BrowserPresentationEnvironment): BrowserPresentationSelection {
    return selectBrowserPresentation({
      ...input,
      capabilities: {
        ...hostCapabilities,
        ...input.capabilities,
        screenshotFallback: false,
      },
    })
  }

  export async function ensure(): Promise<void> {
    await runtime.ensure()
  }

  export async function health(): Promise<BrowserInstall.Health> {
    return runtime.health()
  }

  export async function ensureSession(
    owner: BrowserOwner.Info,
    options: EnsureSessionOptions = {},
  ): Promise<BrowserSession> {
    BrowserOwner.assertValid(owner)
    await ensure()
    const session = await runtime.getOrCreateSession(owner)
    if (options.createInitialTab && session.tabs.length === 0) {
      await BrowserControl.execute(session, { type: "createTab" })
    }
    return session
  }

  export async function execute(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
  ): Promise<BrowserControl.Result> {
    const session = await ensureSession(owner)
    return BrowserControl.execute(session, command)
  }

  export function useRuntimeForTest(adapter: RuntimeAdapter): () => void {
    const previous = runtime
    runtime = adapter
    return () => {
      runtime = previous
    }
  }
}
