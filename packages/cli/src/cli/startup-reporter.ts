import boxen from "boxen"
import gradient from "gradient-string"
import figlet from "figlet"
import { EOL } from "os"

type StatusKind = "success" | "warning" | "error" | "pending" | "muted"

export namespace StartupReporter {
  export interface Capabilities {
    fancy: boolean
    color: boolean
    width: number
  }

  export interface Row {
    label: string
    value: string
  }

  export interface StatusRow {
    label: string
    value: string
    kind?: StatusKind
  }

  export interface Panel {
    title: string
    rows?: Row[]
    statuses?: StatusRow[]
    notes?: string[]
    next?: string[]
  }

  export interface Reporter {
    migration(summary: {
      totalDomains: number
      upToDateDomains: number
      completed: number
      dryRun: number
      failed: number
    }): void
    warning(message: string): void
    render(panel: Panel): void
    warnings(): string[]
  }

  const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
  export function stripAnsi(value: string): string {
    return value.replace(ANSI_RE, "")
  }

  export function capabilities(): Capabilities {
    const color = !process.env.NO_COLOR && process.env.TERM !== "dumb"
    const interactive = Boolean(process.stderr.isTTY && process.stdout.isTTY)
    const fancy = Boolean(
      interactive &&
        color &&
        process.env.CI !== "true" &&
        process.env.SYNERGY_DAEMON !== "1" &&
        process.env.TERM !== "dumb",
    )
    return {
      fancy,
      color,
      width: Math.max(60, Math.min(process.stderr.columns || process.stdout.columns || 88, 120)),
    }
  }

  export function create(): Reporter {
    const warningMessages: string[] = []
    let migrationStatus: StatusRow | undefined

    return {
      migration(summary) {
        const failed = summary.failed > 0
        const changed = summary.completed > 0 || summary.dryRun > 0
        const count = failed ? summary.failed : changed ? summary.completed + summary.dryRun : summary.upToDateDomains
        migrationStatus = {
          label: "Data",
          value: failed
            ? `${count} migration failure${count === 1 ? "" : "s"}`
            : changed
              ? `${count} migration${count === 1 ? "" : "s"} ${summary.dryRun > 0 ? "pending" : "applied"}`
              : `${summary.totalDomains} migration domains current`,
          kind: failed ? "error" : "success",
        }
      },
      warning(message) {
        warningMessages.push(message)
      },
      render(panel) {
        print({
          ...panel,
          statuses: [...(migrationStatus ? [migrationStatus] : []), ...(panel.statuses ?? [])],
          notes: [...warningMessages, ...(panel.notes ?? [])],
        })
      },
      warnings() {
        return [...warningMessages]
      },
    }
  }

  export function print(panel: Panel): void {
    process.stderr.write(render(panel) + EOL)
  }

  export function render(panel: Panel, caps = capabilities()): string {
    if (!caps.fancy) return renderPlain(panel)

    const title = renderTitle(panel.title, caps)
    const sections = [
      renderRows(panel.rows ?? [], caps),
      renderStatuses(panel.statuses ?? [], caps),
      renderNotes(panel.notes ?? [], caps),
      renderNext(panel.next ?? [], caps),
    ].filter(Boolean)

    return boxen(sections.join(EOL + dim("─".repeat(Math.min(44, caps.width - 12)), caps) + EOL), {
      title,
      titleAlignment: "left",
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: 0,
      borderStyle: "round",
      borderColor: "cyan",
      width: Math.min(caps.width, 96),
    })
  }

  function renderTitle(title: string, caps: Capabilities) {
    const clean = stripAnsi(title)
    if (caps.width >= 110) {
      try {
        const banner = figlet.textSync(clean.split(/\s+/)[0] ?? "Synergy", {
          font: "Small",
          horizontalLayout: "fitted",
        })
        const first = banner
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim())
          .at(0)
        if (first) return gradient(["#66e3ff", "#9f8cff"])(first)
      } catch {}
    }
    return gradient(["#66e3ff", "#9f8cff"])(clean)
  }

  function renderRows(rows: Row[], caps: Capabilities) {
    if (rows.length === 0) return ""
    const width = Math.max(7, ...rows.map((row) => row.label.length)) + 2
    return rows.map((row) => dim(row.label.padEnd(width), caps) + row.value).join(EOL)
  }

  function renderStatuses(statuses: StatusRow[], caps: Capabilities) {
    if (statuses.length === 0) return ""
    const width = Math.max(7, ...statuses.map((row) => row.label.length)) + 2
    return statuses.map((row) => `${icon(row.kind ?? "muted", caps)} ${row.label.padEnd(width)}${row.value}`).join(EOL)
  }

  function renderNotes(notes: string[], caps: Capabilities) {
    if (notes.length === 0) return ""
    return notes.map((note) => `${color("!", "yellow", caps)} ${note}`).join(EOL)
  }

  function renderNext(next: string[], caps: Capabilities) {
    if (next.length === 0) return ""
    return next.map((line, index) => `${dim(index === 0 ? "Next: " : "      ", caps)}${line}`).join(EOL)
  }

  function renderPlain(panel: Panel) {
    const lines: string[] = [stripAnsi(panel.title)]
    if (panel.rows?.length) {
      lines.push("")
      for (const row of panel.rows) lines.push(`  ${row.label}: ${stripAnsi(row.value)}`)
    }
    if (panel.statuses?.length) {
      lines.push("")
      for (const status of panel.statuses)
        lines.push(`  ${plainIcon(status.kind ?? "muted")} ${status.label}: ${stripAnsi(status.value)}`)
    }
    if (panel.notes?.length) {
      lines.push("")
      for (const note of panel.notes) lines.push(`  ! ${stripAnsi(note)}`)
    }
    if (panel.next?.length) {
      lines.push("")
      lines.push("  Next:")
      for (const line of panel.next) lines.push(`    ${stripAnsi(line)}`)
    }
    return lines.join(EOL)
  }

  function icon(kind: StatusKind, caps: Capabilities) {
    switch (kind) {
      case "success":
        return color("✓", "green", caps)
      case "warning":
        return color("!", "yellow", caps)
      case "error":
        return color("×", "red", caps)
      case "pending":
        return color("◌", "cyan", caps)
      case "muted":
        return dim("○", caps)
    }
  }

  function plainIcon(kind: StatusKind) {
    if (kind === "success") return "ok"
    if (kind === "warning") return "warn"
    if (kind === "error") return "error"
    if (kind === "pending") return "pending"
    return "-"
  }

  function dim(value: string, caps: Capabilities) {
    return caps.color ? `\x1b[90m${value}\x1b[0m` : value
  }

  function color(value: string, name: "cyan" | "green" | "red" | "yellow", caps: Capabilities) {
    if (!caps.color) return value
    const code = name === "cyan" ? 96 : name === "green" ? 92 : name === "red" ? 91 : 93
    return `\x1b[${code}m${value}\x1b[0m`
  }
}
