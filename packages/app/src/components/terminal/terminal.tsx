import type { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"
import { ComponentProps, Show, createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { useLingui } from "@lingui/solid"
import { useSDK } from "@/context/sdk"
import { LocalPTY } from "@/context/terminal"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { resolveThemeColor, useTheme, withAlpha } from "@ericsanchezok/synergy-ui/theme"
import { terminal as T } from "@/locales/messages"
import { applyTerminalTheme, type TerminalTheme } from "./terminal-theme"
import { textSelectionController } from "@/context/text-selection"
import { ReconnectController } from "./reconnect"

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onConnectError?: (error: unknown) => void
  onGone?: (ptyID: string) => void
}

const MAX_RECONNECT_ATTEMPTS = 5

function isPtyNotFoundError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  return (
    (error as { name?: string }).name === "APIError" &&
    (error as { data?: { statusCode?: number } }).data?.statusCode === 404
  )
}

// ghostty-web 0.3.0 only applies fontFamily at construction time;
// runtime option changes are logged as unsupported and never re-render.
// New terminal instances pick up the configured font via this helper.
function getTerminalFontFamily(): string {
  if (typeof document === "undefined") return '"IBM Plex Mono", monospace'
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim() ||
    '"IBM Plex Mono", monospace'
  )
}

export const Terminal = (props: TerminalProps) => {
  const sdk = useSDK()
  const theme = useTheme()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["pty", "class", "classList", "onConnectError", "onGone"])
  let ws: WebSocket | undefined
  let term: Term | undefined
  let ghostty: Ghostty
  let fitAddon: FitAddon
  let handleResize: () => void
  let handleTextareaFocus: () => void
  let handleTextareaBlur: () => void
  let reconnectController: ReconnectController | undefined
  let disposed = false
  let cleanupRan = false
  const [connected, setConnected] = createSignal(false)
  const [gone, setGone] = createSignal(false)
  const lingui = useLingui()

  const getTerminalColors = (): TerminalTheme => {
    const mode = theme.mode()
    const tokens = theme.tokens()
    const text = resolveThemeColor(tokens, "text-stronger")
    const background = resolveThemeColor(tokens, "background-stronger")
    const alpha = mode === "dark" ? 0.25 : 0.2
    const selectionBackground = withAlpha(text, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const [terminalColors, setTerminalColors] = createSignal<TerminalTheme>(getTerminalColors())

  createEffect(() => {
    const colors = getTerminalColors()
    setTerminalColors(colors)
    if (!term) return
    applyTerminalTheme(term, colors)
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container) {
      activeElement.blur()
    }
    focusTerminal()
  }

  onMount(async () => {
    const mod = await import("ghostty-web")
    if (disposed) return
    ghostty = await mod.Ghostty.load()
    if (disposed) return

    const t = new mod.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: getTerminalFontFamily(),
      allowTransparency: true,
      theme: terminalColors(),
      scrollback: 2_000,
      ghostty,
    })
    term = t

    // No font-change listener: ghostty-web cannot re-render with a new
    // fontFamily at runtime, so updating options would be a silent no-op.

    const copy = () => {
      const selection = t.getSelection()
      if (!selection) return false

      void copyTextToClipboard(selection, {
        label: lingui._(T.copySelection.id),
        failureDescription: lingui._(T.copyFailed.id),
      })
      return true
    }

    t.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase()

      if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
        copy()
        return true
      }

      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "c") {
        if (!t.hasSelection()) return true
        copy()
        return true
      }

      // allow for ctrl-` to toggle terminal in parent
      if (event.ctrlKey && key === "`") {
        return true
      }

      return false
    })
    t.onSelectionChange(() => {
      if (disposed) return
      const rect = container.getBoundingClientRect()
      textSelectionController.update(t.getSelection() || undefined, {
        source: "terminal",
        origin: "other",
        editable: false,
        wholeContainer: false,
        owner: container,
        anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      })
    })

    fitAddon = new mod.FitAddon()
    t.loadAddon(fitAddon)

    t.open(container)
    container.addEventListener("pointerdown", handlePointerDown)

    handleTextareaFocus = () => {
      t.options.cursorBlink = true
    }
    handleTextareaBlur = () => {
      t.options.cursorBlink = false
    }

    t.textarea?.addEventListener("focus", handleTextareaFocus)
    t.textarea?.addEventListener("blur", handleTextareaBlur)

    focusTerminal()

    if (local.pty.buffer) {
      if (local.pty.rows && local.pty.cols) {
        t.resize(local.pty.cols, local.pty.rows)
      }
      t.write(local.pty.buffer, () => {
        if (local.pty.scrollY) {
          t.scrollToLine(local.pty.scrollY)
        }
        fitAddon.fit()
      })
    }

    fitAddon.observeResize()
    handleResize = () => fitAddon.fit()
    window.addEventListener("resize", handleResize)
    t.onResize(async (size) => {
      if (disposed) return
      if (ws?.readyState === WebSocket.OPEN) {
        await sdk.client.pty
          .update({
            ptyID: local.pty.id,
            size: {
              cols: size.cols,
              rows: size.rows,
            },
          })
          .catch(() => {})
      }
    })
    t.onData((data) => {
      if (disposed) return
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })
    t.onKey((key) => {
      if (disposed) return
      if (key.key == "Enter") {
        props.onSubmit?.()
      }
    })

    const connect = () => {
      const params = new URLSearchParams()
      if (sdk.directory) {
        params.set("directory", sdk.directory)
      } else if (sdk.scopeID) {
        params.set("scopeID", sdk.scopeID)
      }
      const socket = new WebSocket(sdk.url + `/pty/${local.pty.id}/connect?${params.toString()}`)
      ws = socket

      socket.addEventListener("open", () => {
        if (disposed) return
        reconnectController?.onOpen()
        sdk.client.pty
          .update({
            ptyID: local.pty.id,
            size: {
              cols: t.cols,
              rows: t.rows,
            },
          })
          .catch(() => {})
      })
      socket.addEventListener("message", (event) => {
        if (disposed) return
        t.write(event.data)
      })
      socket.addEventListener("error", (error) => {
        if (disposed) return
        console.error("WebSocket error:", error)
        props.onConnectError?.(error)
      })
      socket.addEventListener("close", () => {
        // The server closes the socket while closeTab is still awaiting
        // pty.remove, i.e. before this panel subtree is unmounted. A
        // synchronous setConnected(false) enqueues computations that the same
        // flush is about to clean, double-cleaning them (cleanNode on a
        // nulled owned array -> "Cannot read properties of null (reading
        // '1')"). Defer past the dispose flush (macrotask, not microtask:
        // the fetch resolve that continues closeTab is also a microtask), so
        // the subtree is disposed first and the guard drops the write.
        setTimeout(() => {
          if (disposed) return
          setConnected(false)
          reconnectController?.onClose()
        }, 0)
      })
    }

    reconnectController = new ReconnectController({
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      quickCycleMs: 5_000,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      timer: {
        setTimeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id),
        now: () => Date.now(),
      },
      validate: async () => {
        try {
          const res = await sdk.client.pty.get({ ptyID: local.pty.id })
          return !!res.data?.id
        } catch (error) {
          if (isPtyNotFoundError(error)) return false
          // Network/unknown errors leave the PTY's existence unconfirmed:
          // surface them as exhaustion instead of claiming the session is gone,
          // so a flaky connection cannot trigger the destructive close path.
          throw error
        }
      },
      connect,
      onConnected: () => setConnected(true),
      onGiveUp: (reason) => {
        setGone(true)
        // Only a confirmed-missing PTY may close the tab (which removes the
        // server session). Exhaustion with a live PTY must keep the process.
        if (reason === "missing") {
          local.onGone?.(local.pty.id)
        }
      },
      isDisposed: () => disposed,
    })

    connect()
  })

  onCleanup(() => {
    if (cleanupRan) return
    cleanupRan = true
    disposed = true
    reconnectController?.dispose()
    if (handleResize) {
      window.removeEventListener("resize", handleResize)
    }
    container.removeEventListener("pointerdown", handlePointerDown)
    term?.textarea?.removeEventListener("focus", handleTextareaFocus)
    term?.textarea?.removeEventListener("blur", handleTextareaBlur)
    try {
      ws?.close()
    } catch {}
    textSelectionController.update(undefined)
    try {
      term?.dispose()
    } catch {}
  })

  return (
    <div
      data-component="terminal"
      data-prevent-autofocus
      classList={{
        ...(local.classList ?? {}),
        "select-text": true,
        "size-full font-mono relative": true,
        [local.class ?? ""]: !!local.class,
      }}
      style={{ "background-color": terminalColors().background }}
      {...others}
    >
      <div ref={container} class="size-full px-6 py-3" />
      <Show when={!connected()}>
        <div class="absolute inset-0 z-50 flex items-center justify-center bg-background-base/80 pointer-events-none">
          <span class="text-muted-foreground text-sm">
            {gone() ? lingui._(T.sessionLost.id) : lingui._(T.reconnecting.id)}
          </span>
        </div>
      </Show>
    </div>
  )
}
