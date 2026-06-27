import { normalizeBrowserURL } from "@ericsanchezok/synergy-util/browser-protocol"
import { BrowserHostDiagnostics, type BrowserHostUploadFile } from "./browser-host-diagnostics.js"
import { inputModifiers } from "./browser-input.js"

export interface BrowserWebContentsPageState {
  id: string
  url: string
  title: string
  isLoading: boolean
  lastActiveAt: number | null
}

export interface BrowserWebContentsControlTarget {
  pageId: string
  contents(): Electron.WebContents | undefined
  diagnostics?(): BrowserHostDiagnostics | undefined
  resize?(width: number, height: number): void
  pageState(): BrowserWebContentsPageState
}

export class UnsupportedBrowserWebContentsCommandError extends Error {
  constructor(command: string) {
    super(command)
    this.name = "UnsupportedBrowserWebContentsCommandError"
  }
}

export class BrowserWebContentsControl {
  private refMap = new Map<string, { backendNodeId: number; x: number; y: number; width: number; height: number }>()

  constructor(private target: BrowserWebContentsControlTarget) {}

  dispatchInput(payload: Record<string, unknown>): void {
    if (payload.type === "input.resize") {
      this.resize(payload.width, payload.height)
      return
    }

    const contents = this.requireContents()
    contents.focus()

    if (payload.type === "input.text") {
      const text = typeof payload.text === "string" ? payload.text : ""
      if (text) void contents.insertText(text)
      return
    }

    if (payload.type === "input.mouse") {
      this.dispatchMouse(payload, contents)
      return
    }

    if (payload.type === "input.key") {
      this.dispatchKey(payload, contents)
    }
  }

  async execute(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const contents = this.requireContents()
    const diagnostics = this.target.diagnostics?.()
    const pageId = this.target.pageId

    switch (command.type) {
      case "navigate": {
        const url = normalizeBrowserURL(String(command.url ?? "about:blank"))
        await contents.loadURL(url)
        return {
          type: "navigation",
          page: this.target.pageState(),
          url: contents.getURL(),
          title: contents.getTitle(),
        }
      }
      case "reload":
        if (command.ignoreCache) contents.reloadIgnoringCache()
        else contents.reload()
        return { type: "void" }
      case "stop":
        contents.stop()
        return { type: "void" }
      case "history":
        if (command.direction === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        if (command.direction === "forward" && contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward()
        }
        return { type: "void" }
      case "setViewport":
        this.resize(command.width, command.height)
        return { type: "page", page: this.target.pageState() }
      case "click":
        contents.focus()
        this.dispatchMouse({ action: "down", x: command.x, y: command.y, button: "left" }, contents)
        this.dispatchMouse({ action: "up", x: command.x, y: command.y, button: "left" }, contents)
        return { type: "void" }
      case "typeText":
        contents.focus()
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "scroll":
        contents.focus()
        this.dispatchMouse({ action: "wheel", deltaX: command.deltaX, deltaY: command.deltaY }, contents)
        return { type: "void" }
      case "mouse":
        contents.focus()
        this.dispatchMouse((command.input as Record<string, unknown>) ?? command, contents)
        return { type: "void" }
      case "key":
        contents.focus()
        this.dispatchKey((command.input as Record<string, unknown>) ?? command, contents)
        return { type: "void" }
      case "insertText":
        contents.focus()
        await contents.insertText(String(command.text ?? ""))
        return { type: "void" }
      case "evaluate":
        return {
          type: "evaluation",
          pageId,
          value: await contents.executeJavaScript(String(command.expression ?? ""), true),
        }
      case "cdp":
        return {
          type: "cdp",
          pageId,
          value: await this.sendCDP(contents, String(command.method ?? ""), command.params as Record<string, unknown>),
        }
      case "snapshot": {
        const snapshot = await this.snapshot(contents)
        return { type: "snapshot", pageId, elements: snapshot.elements, truncated: snapshot.truncated }
      }
      case "resolveRef": {
        const ref = String(command.ref ?? "")
        return { type: "resolvedRef", pageId, ref, box: this.refMap.get(ref) ?? null }
      }
      case "console":
        return {
          type: "console",
          pageId,
          entries: diagnostics?.consoleEntries(Number(command.maxEntries ?? 50)) ?? [],
        }
      case "network":
        return {
          type: "network",
          pageId,
          requests: diagnostics?.networkRequests(Number(command.maxEntries ?? 100)) ?? [],
        }
      case "assets":
        return {
          type: "assets",
          pageId,
          assets: diagnostics?.pageAssets(pageId, Number(command.maxEntries ?? 100)) ?? [],
        }
      case "filechooser.select":
        await diagnostics?.respondToFileChooser(
          String(command.requestId ?? ""),
          (command.files as BrowserHostUploadFile[]) ?? [],
        )
        return { type: "void" }
      case "dialog.respond":
        await diagnostics?.respondToDialog(
          String(command.requestId ?? ""),
          Boolean(command.accept),
          typeof command.promptText === "string" ? command.promptText : undefined,
        )
        return { type: "void" }
      case "screenshot": {
        const image = await contents.capturePage()
        const size = image.getSize()
        return {
          type: "screenshot",
          pageId,
          dataUrl: image.toDataURL(),
          width: size.width,
          height: size.height,
        }
      }
      case "clearDiagnostics":
        diagnostics?.clear()
        return { type: "diagnostics.cleared", pageId }
      default:
        throw new UnsupportedBrowserWebContentsCommandError(String(command.type ?? "unknown"))
    }
  }

  private resize(widthInput: unknown, heightInput: unknown): void {
    if (!this.target.resize) return
    const width = Math.max(1, Math.round(Number(widthInput ?? 1280)))
    const height = Math.max(1, Math.round(Number(heightInput ?? 720)))
    this.target.resize(width, height)
  }

  private requireContents(): Electron.WebContents {
    const contents = this.target.contents()
    if (!contents || contents.isDestroyed()) throw new Error("Browser webContents is unavailable")
    return contents
  }

  private dispatchMouse(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    if (action === "wheel") {
      contents.sendInputEvent({
        type: "mouseWheel",
        x: Number(payload.x ?? 0),
        y: Number(payload.y ?? 0),
        deltaX: Number(payload.deltaX ?? 0),
        deltaY: Number(payload.deltaY ?? 0),
        modifiers: inputModifiers(payload.modifiers),
      } as Electron.MouseWheelInputEvent)
      return
    }

    const type = action === "down" ? "mouseDown" : action === "up" ? "mouseUp" : action === "move" ? "mouseMove" : null
    if (!type) return

    contents.sendInputEvent({
      type,
      x: Number(payload.x ?? 0),
      y: Number(payload.y ?? 0),
      button: this.mouseButton(payload.button),
      clickCount: Number(payload.clickCount ?? 1),
      modifiers: inputModifiers(payload.modifiers),
    } as Electron.MouseInputEvent)
  }

  private dispatchKey(payload: Record<string, unknown>, contents: Electron.WebContents): void {
    const action = payload.action
    const type = action === "down" ? "keyDown" : action === "up" ? "keyUp" : null
    if (!type) return
    contents.sendInputEvent({
      type,
      keyCode: String(payload.key ?? payload.code ?? ""),
      modifiers: inputModifiers(payload.modifiers, { autoRepeat: payload.autoRepeat }),
    } as Electron.KeyboardInputEvent)
  }

  private mouseButton(button: unknown): "left" | "middle" | "right" {
    if (button === "middle") return "middle"
    if (button === "right") return "right"
    return "left"
  }

  private async sendCDP(
    contents: Electron.WebContents,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!method) throw new Error("Missing CDP method")
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
    return contents.debugger.sendCommand(method, params)
  }

  private async snapshot(contents: Electron.WebContents): Promise<{
    elements: { ref: string; role: string; name: string; value?: string; children: never[] }[]
    truncated: boolean
  }> {
    const result = (await contents.executeJavaScript(
      `(() => {
        const selector = [
          "a[href]",
          "button",
          "input",
          "textarea",
          "select",
          "[role]",
          "[contenteditable='true']",
          "[tabindex]:not([tabindex='-1'])"
        ].join(",")
        const roleFor = (element) => {
          const explicit = element.getAttribute("role")
          if (explicit) return explicit
          const tag = element.tagName.toLowerCase()
          if (tag === "a") return "link"
          if (tag === "button") return "button"
          if (tag === "textarea") return "textbox"
          if (tag === "select") return "combobox"
          if (tag === "input") {
            const type = (element.getAttribute("type") || "text").toLowerCase()
            if (type === "checkbox") return "checkbox"
            if (type === "radio") return "radio"
            if (type === "search") return "searchbox"
            if (type === "range") return "slider"
            return "textbox"
          }
          return "generic"
        }
        const nameFor = (element) => {
          return element.getAttribute("aria-label")
            || element.getAttribute("title")
            || element.getAttribute("placeholder")
            || element.innerText
            || element.value
            || element.textContent
            || ""
        }
        const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 300)
        return nodes.map((element, index) => {
          const rect = element.getBoundingClientRect()
          return {
            ref: "@n" + (index + 1),
            role: roleFor(element),
            name: String(nameFor(element)).replace(/\\s+/g, " ").trim().slice(0, 200),
            value: "value" in element && typeof element.value === "string" ? element.value : undefined,
            box: {
              backendNodeId: index + 1,
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            }
          }
        }).filter((item) => item.box.width > 0 && item.box.height > 0 && item.name)
      })()`,
      true,
    )) as {
      ref: string
      role: string
      name: string
      value?: string
      box: { backendNodeId: number; x: number; y: number; width: number; height: number }
    }[]

    this.refMap.clear()
    const elements = result.map((item) => {
      this.refMap.set(item.ref, item.box)
      return {
        ref: item.ref,
        role: item.role,
        name: item.name,
        value: item.value,
        children: [],
      }
    })
    return { elements, truncated: result.length >= 300 }
  }
}
