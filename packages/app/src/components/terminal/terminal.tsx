import type { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"
import { ComponentProps, Show, createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { useSDK } from "@/context/sdk"
import { SerializeAddon } from "@/addons/serialize"
import { LocalPTY } from "@/context/terminal"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { resolveThemeColor, useTheme, withAlpha } from "@ericsanchezok/synergy-ui/theme"

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  onSubmit?: () => void
  onCleanup?: (pty: LocalPTY) => void
  onConnectError?: (error: unknown) => void
  onGone?: (ptyID: string) => void
}

const MAX_RECONNECT_ATTEMPTS = 5

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

export const Terminal = (props: TerminalProps) => {
  const sdk = useSDK()
  const theme = useTheme()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, ["pty", "class", "classList", "onConnectError", "onGone"])
  let ws: WebSocket | undefined
  let term: Term | undefined
  let ghostty: Ghostty
  let serializeAddon: SerializeAddon
  let fitAddon: FitAddon
  let handleResize: () => void
  let handleTextareaFocus: () => void
  let handleTextareaBlur: () => void
  let reconnect: number | undefined
  let disposed = false
  let reconnectDelay = 1000
  let reconnectAttempts = 0
  const [connected, setConnected] = createSignal(false)
  const [gone, setGone] = createSignal(false)

  const getTerminalColors = (): TerminalColors => {
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

  const [terminalColors, setTerminalColors] = createSignal<TerminalColors>(getTerminalColors())

  createEffect(() => {
    const colors = getTerminalColors()
    setTerminalColors(colors)
    if (!term) return
    const setOption = (term as unknown as { setOption?: (key: string, value: TerminalColors) => void }).setOption
    if (!setOption) return
    setOption("theme", colors)
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
    ghostty = await mod.Ghostty.load()

    const t = new mod.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 14,
      fontFamily: "IBM Plex Mono, monospace",
      allowTransparency: true,
      theme: terminalColors(),
      scrollback: 2_000,
      ghostty,
    })
    term = t

    const copy = () => {
      const selection = t.getSelection()
      if (!selection) return false

      void copyTextToClipboard(selection, {
        label: "Copy terminal selection",
        failureDescription: "Unable to copy the terminal selection.",
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

    fitAddon = new mod.FitAddon()
    serializeAddon = new SerializeAddon()
    t.loadAddon(serializeAddon)
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
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    })
    t.onKey((key) => {
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
        setConnected(true)
        reconnectDelay = 1000
        reconnectAttempts = 0
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
        t.write(event.data)
      })
      socket.addEventListener("error", (error) => {
        console.error("WebSocket error:", error)
        props.onConnectError?.(error)
      })
      socket.addEventListener("close", () => {
        setConnected(false)
        if (disposed) return
        reconnectAttempts++
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          setGone(true)
          local.onGone?.(local.pty.id)
          return
        }
        reconnect = window.setTimeout(async () => {
          if (disposed) return
          try {
            const res = await sdk.client.pty.get({ ptyID: local.pty.id })
            if (!res.data?.id) {
              setGone(true)
              local.onGone?.(local.pty.id)
              return
            }
          } catch {
            setGone(true)
            local.onGone?.(local.pty.id)
            return
          }
          reconnectDelay = Math.min(reconnectDelay * 2, 10_000)
          connect()
        }, reconnectDelay)
      })
    }

    connect()
  })

  onCleanup(() => {
    disposed = true
    if (reconnect) {
      clearTimeout(reconnect)
    }
    if (handleResize) {
      window.removeEventListener("resize", handleResize)
    }
    container.removeEventListener("pointerdown", handlePointerDown)
    term?.textarea?.removeEventListener("focus", handleTextareaFocus)
    term?.textarea?.removeEventListener("blur", handleTextareaBlur)

    const t = term
    if (serializeAddon && props.onCleanup && t) {
      const buffer = serializeAddon.serialize()
      props.onCleanup({
        ...local.pty,
        buffer,
        rows: t.rows,
        cols: t.cols,
        scrollY: t.getViewportY(),
      })
    }

    ws?.close()
    t?.dispose()
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
          <span class="text-muted-foreground text-sm">{gone() ? "Session lost" : "Reconnecting..."}</span>
        </div>
      </Show>
    </div>
  )
}
