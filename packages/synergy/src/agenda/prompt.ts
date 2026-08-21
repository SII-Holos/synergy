import { AgendaTypes } from "./types"
import { formatLocalDateTime } from "../util/time-format"

export namespace AgendaPrompt {
  export function build(item: AgendaTypes.Item, signal: AgendaTypes.FiredSignal): string {
    const prompt = item.prompt

    const sections = [
      "<agenda-context>",
      `<title>${item.title}</title>`,
      formatDescription(item.description),
      `<trigger>${formatTriggers(item.triggers, signal)}</trigger>`,
      formatSignalPayload(signal),
      `<run number="${item.state.runCount + 1}" />`,
      formatLastRun(item.state),
      formatSessionRefs(item.sessionRefs),
      "</agenda-context>",
      "",
      "<task>",
      prompt,
      "</task>",
    ]
    return sections.filter((s) => s !== undefined).join("\n")
  }

  function formatDescription(description: string | undefined): string | undefined {
    if (!description) return undefined
    return `<description>${description}</description>`
  }

  function formatTriggers(triggers: AgendaTypes.Trigger[], signal: AgendaTypes.FiredSignal): string {
    const parts: string[] = []
    for (const trigger of triggers) {
      switch (trigger.type) {
        case "cron":
          parts.push(`cron "${trigger.expr}"${trigger.tz ? ` (${trigger.tz})` : ""}`)
          break
        case "every":
          parts.push(
            `every ${trigger.interval}${trigger.anchor !== undefined ? ` from anchor ${formatLocalDateTime(trigger.anchor)}` : ""}`,
          )
          break
        case "at":
          parts.push(`at ${formatLocalDateTime(trigger.at)}`)
          break
        case "delay":
          parts.push(`delay ${trigger.delay}`)
          break
        case "watch": {
          const w = trigger.watch
          if (w.kind === "file") {
            const filter = w.event ? ` on ${w.event}` : ""
            const debounce = w.debounce ? ` (debounce ${w.debounce})` : ""
            parts.push(`file watch "${w.glob}"${filter}${debounce}`)
          } else {
            parts.push(`watch (${w.kind})`)
          }
          break
        }
        case "webhook":
          parts.push("webhook")
          break
        case "session": {
          const filter = [trigger.agent && ` agent=${trigger.agent}`, trigger.finish && ` finish=${trigger.finish}`]
            .filter(Boolean)
            .join("")
          parts.push(`session "${trigger.sessionID}" on ${trigger.event}${filter}`)
          break
        }
        case "github": {
          const target = trigger.number !== undefined ? ` #${trigger.number}` : ""
          const states = trigger.states?.length ? ` on states [${trigger.states.join("|")}]` : ""
          parts.push(`github ${trigger.resource} ${trigger.repository}${target}${states}`)
          break
        }
      }
    }
    const triggerDesc = parts.length > 0 ? parts.join(", ") : "manual"
    return `${triggerDesc} — fired at ${formatLocalDateTime(signal.timestamp)}`
  }

  function formatSignalPayload(signal: AgendaTypes.FiredSignal): string | undefined {
    if (!signal.payload) return undefined

    if (signal.type === "watch") {
      const p = signal.payload
      if (typeof p.file === "string" && typeof p.event === "string") {
        return `<watch-event type="file" file="${p.file}" event="${p.event}" />`
      }
      if (typeof p.output === "string") {
        const output = p.output as string
        const truncated = output.length > 4096 ? output.slice(0, 4096) + "\n…(truncated)" : output
        return `<watch-event type="poll">\n${truncated}\n</watch-event>`
      }
    }

    if (signal.type === "webhook") {
      const json = JSON.stringify(signal.payload, null, 2)
      const truncated = json.length > 4096 ? json.slice(0, 4096) + "\n…(truncated)" : json
      return `<webhook-payload>\n${truncated}\n</webhook-payload>`
    }

    if (signal.type === "session") {
      const p = signal.payload
      const finish = typeof p.finish === "string" ? ` finish="${p.finish}"` : ""
      const agent = typeof p.agent === "string" ? ` agent="${p.agent}"` : ""
      const messageID = typeof p.messageID === "string" ? ` messageID="${p.messageID}"` : ""
      return `<session-event sessionID="${String(p.sessionID)}"${messageID}${finish}${agent} />`
    }

    if (signal.type === "github") {
      // GitHub titles/state are repository-controlled input; escape anything
      // that could close the attribute or inject prompt structure.
      const p = signal.payload
      const attrs = [
        typeof p.resource === "string" ? `resource="${escapeAttr(p.resource)}"` : "",
        typeof p.repository === "string" ? `repository="${escapeAttr(p.repository)}"` : "",
        p.number !== undefined ? `number="${String(p.number)}"` : "",
        typeof p.title === "string" ? `title="${escapeAttr(p.title)}"` : "",
        typeof p.state === "string" ? `state="${escapeAttr(p.state)}"` : "",
        typeof p.previousState === "string" ? `previousState="${escapeAttr(p.previousState)}"` : "",
        typeof p.url === "string" ? `url="${escapeAttr(p.url)}"` : "",
      ]
        .filter(Boolean)
        .join(" ")
      return `<github-event ${attrs} />`
    }

    const json = JSON.stringify(signal.payload)
    if (json.length > 4096) return `<signal-payload>(payload too large, ${json.length} bytes)</signal-payload>`
    return `<signal-payload>${json}</signal-payload>`
  }

  function formatLastRun(state: AgendaTypes.ItemState): string | undefined {
    if (state.lastRunAt === undefined) return undefined

    const date = formatLocalDateTime(state.lastRunAt)
    const duration =
      state.lastRunDuration !== undefined ? ` duration="${(state.lastRunDuration / 1000).toFixed(1)}s"` : ""

    if (state.lastRunStatus === "error") {
      const lines = [`<last-run status="error" date="${date}"${duration} />`]
      if (state.lastRunError) lines.push(`<last-run-error>${state.lastRunError}</last-run-error>`)
      if (state.consecutiveErrors > 1) lines.push(`<consecutive-errors>${state.consecutiveErrors}</consecutive-errors>`)
      return lines.join("\n")
    }

    return `<last-run status="${state.lastRunStatus ?? "ok"}" date="${date}"${duration} />`
  }

  function formatSessionRefs(refs: AgendaTypes.SessionRef[] | undefined): string | undefined {
    if (!refs || refs.length === 0) return undefined
    const lines = refs.map((ref) => {
      const hint = ref.hint ? ` hint="${ref.hint}"` : ""
      return `<session-ref id="${ref.sessionID}"${hint} />`
    })
    return [
      "<context-sessions>",
      ...lines,
      "You can read the above sessions using tools to retrieve background context.",
      "</context-sessions>",
    ].join("\n")
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
