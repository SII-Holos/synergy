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
import { BrowserHostControl } from "./host-control.js"

export namespace BrowserHost {
  export interface RuntimeAdapter {
    ensure(): Promise<unknown>
    health(): Promise<BrowserInstall.Health>
    getOrCreateSession(owner: BrowserOwner.Info): Promise<BrowserSession>
    state?(): { sessions: Map<string, BrowserSession> }
  }

  const hostCapabilities: BrowserPresentationCapabilities = {
    native: true,
    webrtc: true,
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
      },
    })
  }

  export async function ensure(): Promise<void> {
    await runtime.ensure()
  }

  export async function health(): Promise<BrowserInstall.Health> {
    return runtime.health()
  }

  export async function ensureSession(owner: BrowserOwner.Info): Promise<BrowserSession> {
    BrowserOwner.assertValid(owner)
    await ensure()
    return runtime.getOrCreateSession(owner)
  }

  export async function executeAttached(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
    options: BrowserHostControl.ExecuteOptions = {},
  ): Promise<BrowserControl.Result> {
    const normalizedCommand = BrowserControl.normalizeCommand(command)
    return BrowserHostControl.execute(owner, normalizedCommand, options)
  }

  export async function executeRuntime(
    owner: BrowserOwner.Info,
    command: BrowserControl.Command,
  ): Promise<BrowserControl.Result> {
    const normalizedCommand = BrowserControl.normalizeCommand(command)
    const session = await ensureSession(owner)
    return BrowserControl.execute(session, normalizedCommand)
  }

  export function sessions(): Map<string, BrowserSession> {
    return new Map((runtime.state?.() ?? BrowserRuntime.state()).sessions)
  }

  export function useRuntimeForTest(adapter: RuntimeAdapter): () => void {
    const previous = runtime
    runtime = adapter
    return () => {
      runtime = previous
    }
  }
}
