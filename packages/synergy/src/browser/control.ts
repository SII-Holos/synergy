import { normalizeBrowserURL } from "@ericsanchezok/synergy-util/browser-protocol"
import type { BrowserAnnotation, BrowserSession } from "./types.js"
import { BrowserAssets } from "./assets.js"
import type {
  BrowserTab,
  BrowserUploadFile,
  ConsoleMessage,
  NetworkRequest,
  BrowserDownloadEntry,
  AccessibilityElement,
} from "./tab.js"
import type { BrowserKeyInput, BrowserMouseInput } from "./input.js"

export namespace BrowserControl {
  export interface PageState {
    id: string
    url: string
    title: string
    isLoading: boolean
    lastActiveAt: number | null
  }

  export interface SessionState {
    page: PageState | null
  }

  export type Command =
    | { type: "navigate"; pageId?: string; url: string; source?: "agent" | "user"; policyOverride?: boolean }
    | { type: "reload"; pageId?: string; ignoreCache?: boolean }
    | { type: "stop"; pageId?: string }
    | { type: "history"; pageId?: string; direction: "back" | "forward" }
    | { type: "setViewport"; pageId?: string; width: number; height: number; deviceScaleFactor?: number }
    | { type: "click"; pageId?: string; x: number; y: number }
    | { type: "typeText"; pageId?: string; text: string }
    | { type: "scroll"; pageId?: string; deltaX: number; deltaY: number }
    | { type: "mouse"; pageId?: string; action: "move" | "down" | "up" | "wheel"; input: BrowserMouseInput }
    | { type: "key"; pageId?: string; action: "down" | "up"; input: BrowserKeyInput }
    | { type: "insertText"; pageId?: string; text: string }
    | { type: "evaluate"; pageId?: string; expression: string; throwOnSideEffect?: boolean }
    | { type: "cdp"; pageId?: string; method: string; params?: Record<string, unknown> }
    | { type: "resolveRef"; pageId?: string; ref: string }
    | { type: "console"; pageId?: string; maxEntries?: number }
    | { type: "network"; pageId?: string; maxEntries?: number }
    | { type: "snapshot"; pageId?: string }
    | { type: "assets"; pageId?: string; maxEntries?: number }
    | {
        type: "screenshot"
        pageId?: string
        format?: "jpeg" | "png"
        quality?: number
        fullPage?: boolean
        clip?: { x: number; y: number; width: number; height: number; scale?: number }
      }
    | { type: "filechooser.select"; pageId?: string; requestId: string; files: BrowserUploadFile[] }
    | { type: "dialog.respond"; pageId?: string; requestId: string; accept: boolean; promptText?: string }
    | {
        type: "createAnnotation"
        pageId?: string
        comment: string
        styleFeedback?: Record<string, string>
      }
    | { type: "clearDiagnostics"; pageId?: string }

  export type Result =
    | { type: "page"; page: PageState }
    | { type: "navigation"; page: PageState; url: string; title: string }
    | { type: "session"; session: SessionState }
    | { type: "console"; pageId: string; entries: ConsoleMessage[] }
    | { type: "network"; pageId: string; requests: NetworkRequest[] }
    | { type: "snapshot"; pageId: string; elements: AccessibilityElement[]; truncated: boolean }
    | { type: "assets"; pageId: string; assets: BrowserAssets.PageAsset[] }
    | { type: "screenshot"; pageId: string; dataUrl: string; width: number; height: number }
    | { type: "evaluation"; pageId: string; value: unknown }
    | { type: "cdp"; pageId: string; value: unknown }
    | {
        type: "resolvedRef"
        pageId: string
        ref: string
        box: { backendNodeId: number; x: number; y: number; width: number; height: number } | null
      }
    | { type: "annotation"; annotation: BrowserAnnotation }
    | { type: "diagnostics.cleared"; pageId: string }
    | { type: "void" }

  export class PageMissingError extends Error {
    constructor(pageId?: string) {
      super(pageId ? `Browser page not found: ${pageId}` : "No browser page is open")
      this.name = "BrowserControlPageMissingError"
    }
  }

  export function pageState(page: BrowserTab): PageState {
    return {
      id: page.id,
      url: page.url,
      title: page.title,
      isLoading: page.loading,
      lastActiveAt: page.lastActiveAt,
    }
  }

  export function sessionState(session: BrowserSession): SessionState {
    return {
      page: session.page ? pageState(session.page) : null,
    }
  }

  export function normalizeCommand(command: Command): Command {
    if (command.type === "navigate") return { ...command, url: normalizeBrowserURL(command.url) }
    return command
  }

  export function resolvePage(session: Pick<BrowserSession, "page" | "getPage">, pageId?: string): BrowserTab {
    if (pageId) {
      const page = session.getPage(pageId)
      if (!page) throw new PageMissingError(pageId)
      return page
    }
    if (!session.page) throw new PageMissingError()
    return session.page
  }

  export async function resolveOrCreatePage(
    session: Pick<BrowserSession, "page" | "ensurePage" | "getPage">,
    pageId?: string,
  ): Promise<BrowserTab> {
    if (pageId) {
      const page = session.getPage(pageId)
      if (!page) throw new PageMissingError(pageId)
      return page
    }
    return session.page ?? session.ensurePage()
  }

  export async function execute(session: BrowserSession, command: Command): Promise<Result> {
    switch (command.type) {
      case "navigate": {
        const page = await resolveOrCreatePage(session, command.pageId)
        const result = command.policyOverride
          ? await page.navigateWithOverride(command.url)
          : command.source === "user"
            ? await page.navigateForUser(command.url)
            : await page.navigate(command.url)
        await session.save()
        await session.notifyPageNavigated(page)
        return { type: "navigation", page: pageState(page), url: result.url, title: result.title }
      }
      case "reload": {
        const page = resolvePage(session, command.pageId)
        await page.reload(command.ignoreCache)
        await session.save()
        return { type: "void" }
      }
      case "stop": {
        const page = resolvePage(session, command.pageId)
        await page.stop()
        return { type: "void" }
      }
      case "history": {
        const page = resolvePage(session, command.pageId)
        if (command.direction === "back") await page.goBack()
        else await page.goForward()
        await session.save()
        return { type: "void" }
      }
      case "setViewport": {
        const page = resolvePage(session, command.pageId)
        await page.setViewport(command.width, command.height, command.deviceScaleFactor ?? 1)
        return { type: "page", page: pageState(page) }
      }
      case "click": {
        const page = resolvePage(session, command.pageId)
        await page.click(command.x, command.y)
        return { type: "void" }
      }
      case "typeText": {
        const page = resolvePage(session, command.pageId)
        await page.type(command.text)
        return { type: "void" }
      }
      case "scroll": {
        const page = resolvePage(session, command.pageId)
        await page.scroll(command.deltaX, command.deltaY)
        return { type: "void" }
      }
      case "mouse": {
        const page = resolvePage(session, command.pageId)
        await page.dispatchMouse(command.action, command.input)
        return { type: "void" }
      }
      case "key": {
        const page = resolvePage(session, command.pageId)
        await page.dispatchKey(command.action, command.input)
        return { type: "void" }
      }
      case "insertText": {
        const page = resolvePage(session, command.pageId)
        await page.insertText(command.text)
        return { type: "void" }
      }
      case "evaluate": {
        const page = resolvePage(session, command.pageId)
        return {
          type: "evaluation",
          pageId: page.id,
          value: await page.evaluate(command.expression, { throwOnSideEffect: command.throwOnSideEffect }),
        }
      }
      case "cdp": {
        const page = resolvePage(session, command.pageId)
        const cdp = await page.ensureCDP()
        return {
          type: "cdp",
          pageId: page.id,
          value: await cdp.send(command.method, command.params),
        }
      }
      case "resolveRef": {
        const page = resolvePage(session, command.pageId)
        return { type: "resolvedRef", pageId: page.id, ref: command.ref, box: await page.resolveRef(command.ref) }
      }
      case "console": {
        const page = resolvePage(session, command.pageId)
        return { type: "console", pageId: page.id, entries: await page.consoleEntries(command.maxEntries ?? 50) }
      }
      case "network": {
        const page = resolvePage(session, command.pageId)
        return { type: "network", pageId: page.id, requests: await page.networkRequests(command.maxEntries ?? 100) }
      }
      case "snapshot": {
        const page = resolvePage(session, command.pageId)
        const snapshot = await page.snapshot()
        return { type: "snapshot", pageId: page.id, elements: snapshot.elements, truncated: snapshot.truncated }
      }
      case "assets": {
        const page = resolvePage(session, command.pageId)
        const requests = await page.networkRequests(command.maxEntries ?? 200)
        return { type: "assets", pageId: page.id, assets: BrowserAssets.fromNetworkBuffer(requests, page.id) }
      }
      case "screenshot": {
        const page = resolvePage(session, command.pageId)
        const shot = await page.screenshot(command.format, command.quality, command.fullPage, command.clip)
        const mime = command.format === "jpeg" ? "image/jpeg" : "image/png"
        return {
          type: "screenshot",
          pageId: page.id,
          dataUrl: `data:${mime};base64,${shot.buffer.toString("base64")}`,
          width: shot.width,
          height: shot.height,
        }
      }
      case "filechooser.select": {
        const page = resolvePage(session, command.pageId)
        await page.respondToFileChooser(command.requestId, command.files)
        return { type: "void" }
      }
      case "dialog.respond": {
        const page = resolvePage(session, command.pageId)
        await page.respondToDialog(command.requestId, command.accept, command.promptText)
        return { type: "void" }
      }
      case "createAnnotation": {
        const annotation = session.addAnnotation({
          comment: command.comment,
          styleFeedback: command.styleFeedback,
          createdBy: "user",
          pageID: command.pageId,
        })
        return { type: "annotation", annotation }
      }
      case "clearDiagnostics": {
        const page = resolvePage(session, command.pageId)
        await page.clearDiagnostics()
        return { type: "diagnostics.cleared", pageId: page.id }
      }
    }
  }
}
