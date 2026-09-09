import z from "zod"
import { EOL } from "os"
import { NamedError } from "@ericsanchezok/synergy-util/error"

export namespace UI {
  const LOGO = [
    [`█░░█ █▀▀█ █░░ █▀▀█ █▀▀  `, `█▀▀ █░░█ █▀▀▄ █▀▀ █▀▀█ █▀▀▀ █░░█`],
    [`█▀▀█ █░░█ █░░ █░░█ ▀▀█  `, `▀▀█ █▄▄█ █░░█ █▀▀ █▄▄▀ █░▀█ █▄▄█`],
    [`▀░░▀ ▀▀▀▀ ▀▀▀ ▀▀▀▀ ▀▀▀  `, `▀▀▀ ▄▄▄█ ▀░░▀ ▀▀▀ ▀░▀▀ ▀▀▀▀ ▄▄▄█`],
  ]

  export const CancelledError = NamedError.create("UICancelledError", z.void())

  export const Style = {
    TEXT_HIGHLIGHT: "\x1b[96m",
    TEXT_HIGHLIGHT_BOLD: "\x1b[96m\x1b[1m",
    TEXT_DIM: "\x1b[90m",
    TEXT_DIM_BOLD: "\x1b[90m\x1b[1m",
    TEXT_NORMAL: "\x1b[0m",
    TEXT_NORMAL_BOLD: "\x1b[1m",
    TEXT_WARNING: "\x1b[93m",
    TEXT_WARNING_BOLD: "\x1b[93m\x1b[1m",
    TEXT_DANGER: "\x1b[91m",
    TEXT_DANGER_BOLD: "\x1b[91m\x1b[1m",
    TEXT_SUCCESS: "\x1b[92m",
    TEXT_SUCCESS_BOLD: "\x1b[92m\x1b[1m",
    TEXT_INFO: "\x1b[94m",
    TEXT_INFO_BOLD: "\x1b[94m\x1b[1m",
  }

  export function println(...message: string[]) {
    print(...message)
    Bun.stderr.write(EOL)
  }

  export function print(...message: string[]) {
    blank = false
    Bun.stderr.write(message.join(" "))
  }

  let blank = false
  export function empty() {
    if (blank) return
    println("" + Style.TEXT_NORMAL)
    blank = true
  }

  export function logo(pad?: string) {
    const result = []
    for (const row of LOGO) {
      if (pad) result.push(pad)
      result.push(Bun.color("gray", "ansi"))
      result.push(row[0])
      result.push("\x1b[0m")
      result.push(row[1])
      result.push(EOL)
    }
    return result.join("").trimEnd()
  }

  export async function input(prompt: string): Promise<string> {
    const readline = require("readline")
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(prompt, (answer: string) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }

  export function error(message: string) {
    println(Style.TEXT_DANGER_BOLD + "Error: " + Style.TEXT_NORMAL + message)
  }

  export function markdown(text: string): string {
    return text
  }

  export function progressBar(opts: {
    ratio: number
    width?: number
    filledChar?: string
    emptyChar?: string
    filledStyle?: string
    emptyStyle?: string
    brackets?: boolean
  }) {
    const width = opts.width ?? 24
    const ratio = Math.max(0, Math.min(1, Number.isFinite(opts.ratio) ? opts.ratio : 0))
    const filled = Math.round(ratio * width)
    const empty = Math.max(0, width - filled)
    const filledChar = opts.filledChar ?? "■"
    const emptyChar = opts.emptyChar ?? "·"
    const filledStyle = opts.filledStyle ?? Style.TEXT_INFO_BOLD
    const emptyStyle = opts.emptyStyle ?? Style.TEXT_DIM
    const body = filledStyle + filledChar.repeat(filled) + emptyStyle + emptyChar.repeat(empty) + Style.TEXT_NORMAL
    if (opts.brackets === false) return body
    return Style.TEXT_DIM + "[" + Style.TEXT_NORMAL + body + Style.TEXT_DIM + "]" + Style.TEXT_NORMAL
  }

  export interface CardRow {
    label: string
    value: string
    valueStyle?: string
  }

  export function card(opts: {
    title: string
    titleStyle?: string
    description?: string
    rows: CardRow[]
    footer?: string
    minWidth?: number
  }): string {
    const DIM = Style.TEXT_DIM
    const RESET = Style.TEXT_NORMAL
    const ts = opts.titleStyle ?? Style.TEXT_HIGHLIGHT_BOLD
    const labelCol = 3 + Math.max(...opts.rows.map((r) => r.label.length)) + 2
    const widths = [opts.minWidth ?? 0, 1 + opts.title.length, ...opts.rows.map((r) => labelCol + r.value.length)]
    if (opts.description) widths.push(1 + opts.description.length)
    if (opts.footer) widths.push(1 + opts.footer.length)
    const w = Math.max(...widths)

    const fill = (n: number) => " ".repeat(Math.max(0, n))
    const blank = DIM + "│" + fill(w) + "│"
    const lines: string[] = []

    lines.push(DIM + "┌" + "─".repeat(w) + "┐")
    lines.push(DIM + "│" + ts + " " + opts.title + fill(w - 1 - opts.title.length) + DIM + "│")
    if (opts.description) {
      lines.push(DIM + "│" + RESET + " " + opts.description + fill(w - 1 - opts.description.length) + DIM + "│")
    }
    lines.push(blank)
    for (const r of opts.rows) {
      const vs = r.valueStyle ?? RESET
      const gap = fill(labelCol - 3 - r.label.length)
      lines.push(
        DIM + "│" + RESET + "   " + r.label + gap + vs + r.value + fill(w - labelCol - r.value.length) + DIM + "│",
      )
    }
    lines.push(blank)
    if (opts.footer) {
      lines.push(DIM + "│" + RESET + " " + opts.footer + fill(w - 1 - opts.footer.length) + DIM + "│")
    }
    lines.push(DIM + "└" + "─".repeat(w) + "┘" + RESET)

    return lines.join("\n")
  }
}
