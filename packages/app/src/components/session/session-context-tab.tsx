import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useLayout } from "@/context/layout"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Accordion } from "@ericsanchezok/synergy-ui/accordion"
import { StickyAccordionHeader } from "@ericsanchezok/synergy-ui/sticky-accordion-header"
import { Code } from "@ericsanchezok/synergy-ui/code"
import { Markdown } from "@ericsanchezok/synergy-ui/markdown"
import type { AssistantMessage, Message, Part, UserMessage } from "@ericsanchezok/synergy-sdk/client"
import { ModelLimit } from "@ericsanchezok/synergy-util/model-limit"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useLocale } from "@/context/locale"
import { S } from "./session-i18n"

interface SessionContextTabProps {
  messages: () => Message[]
  visibleUserMessages: () => UserMessage[]
  view: () => ReturnType<ReturnType<typeof useLayout>["view"]>
  info: () => ReturnType<ReturnType<typeof useSync>["session"]["get"]>
}

export function SessionContextTab(props: SessionContextTabProps) {
  const params = useParams()
  const sync = useSync()
  const { i18n, fmt } = useLocale()
  const _ = (d: { id: string; message: string }) => i18n._(d)

  const ctx = createMemo(() => {
    const last = props.messages().findLast((x) => {
      if (x.role !== "assistant" || !x.tokens) return false
      const input = ModelLimit.actualInput(x.tokens)
      return input + x.tokens.output + x.tokens.reasoning > 0
    }) as AssistantMessage | undefined
    if (!last?.tokens) return

    const provider = sync.data.provider.all.find((x) => x.id === last.providerID)
    const model = provider?.models[last.modelID]
    const modelLimit = model?.limit

    const input = ModelLimit.actualInput(last.tokens)
    const output = last.tokens.output
    const reasoning = last.tokens.reasoning
    const cacheRead = last.tokens.cache.read
    const cacheWrite = last.tokens.cache.write
    const total = input + output + reasoning
    const usable = ModelLimit.usableInput(modelLimit)
    const usage = usable > 0 ? Math.round((total / usable) * 100) : null

    return {
      message: last,
      provider,
      model,
      limit: modelLimit?.context,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      total,
      usage,
    }
  })

  const cost = createMemo(() => {
    const total = props.messages().reduce((sum, x) => sum + (x.role === "assistant" ? x.cost : 0), 0)
    return fmt.currency(total, "USD")
  })

  const counts = createMemo(() => {
    const all = props.messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const systemPrompt = createMemo(() => {
    const msg = props.visibleUserMessages().findLast((m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  })

  const number = (value: number | null | undefined) => {
    if (value === undefined || value === null) return "—"
    return fmt.number(value)
  }

  const percent = (value: number | null | undefined) => {
    if (value === undefined || value === null) return "—"
    return fmt.percent(value / 100)
  }

  const time = (value: number | undefined) => {
    if (!value) return "—"
    return fmt.dateTime(value)
  }

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.provider?.name ?? c.message.providerID
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    if (c.model?.name) return c.model.name
    return c.message.modelID
  })

  const breakdown = createMemo(
    on(
      () => [ctx()?.message.id, ctx()?.input, props.messages()?.length ?? 0, systemPrompt()],
      () => {
        const c = ctx()
        if (!c) return []
        const input = c.input
        if (!input) return []

        const out = {
          system: systemPrompt()?.length ?? 0,
          user: 0,
          assistant: 0,
          tool: 0,
        }

        for (const msg of props.messages()) {
          const parts = (sync.data.part[msg.id] ?? []) as Part[]

          if (msg.role === "user") {
            for (const part of parts) {
              if (part.type === "text") out.user += part.text?.length ?? 0
              if (part.type === "attachment") out.user += part.source?.text?.value?.length ?? 0
            }
            continue
          }

          if (msg.role === "assistant") {
            for (const part of parts) {
              if (part.type === "text") out.assistant += part.text?.length ?? 0
              if (part.type === "reasoning") out.assistant += part.text?.length ?? 0
              if (part.type === "tool" && part.state) {
                out.tool += Object.keys(part.state.input ?? {}).length * 16
                if (part.state.status === "pending") out.tool += part.state.raw?.length ?? 0
                if (part.state.status === "generating") out.tool += (part.state as { raw?: string }).raw?.length ?? 0
                if (part.state.status === "completed") out.tool += part.state.output?.length ?? 0
                if (part.state.status === "error") out.tool += part.state.error?.length ?? 0
              }
            }
          }
        }

        const estimateTokens = (chars: number) => Math.ceil(chars / 4)
        const system = estimateTokens(out.system)
        const user = estimateTokens(out.user)
        const assistant = estimateTokens(out.assistant)
        const tool = estimateTokens(out.tool)
        const estimated = system + user + assistant + tool

        const pct = (tokens: number) => (tokens / input) * 100
        const pctLabel = (tokens: number) => fmt.percent(pct(tokens) / 100, { maximumFractionDigits: 1 })

        const build = (tokens: { system: number; user: number; assistant: number; tool: number; other: number }) => {
          const labelMap: Record<string, string> = {
            system: _(S.contextTabSystem),
            user: _(S.contextTabUser),
            assistant: _(S.contextTabAssistant),
            tool: _(S.contextTabToolCalls),
            other: _(S.contextTabOther),
          }
          return [
            {
              key: "system",
              label: labelMap.system,
              tokens: tokens.system,
              width: pct(tokens.system),
              percent: pctLabel(tokens.system),
              color: "var(--syntax-info)",
            },
            {
              key: "user",
              label: labelMap.user,
              tokens: tokens.user,
              width: pct(tokens.user),
              percent: pctLabel(tokens.user),
              color: "var(--syntax-success)",
            },
            {
              key: "assistant",
              label: labelMap.assistant,
              tokens: tokens.assistant,
              width: pct(tokens.assistant),
              percent: pctLabel(tokens.assistant),
              color: "var(--syntax-property)",
            },
            {
              key: "tool",
              label: labelMap.tool,
              tokens: tokens.tool,
              width: pct(tokens.tool),
              percent: pctLabel(tokens.tool),
              color: "var(--syntax-warning)",
            },
            {
              key: "other",
              label: labelMap.other,
              tokens: tokens.other,
              width: pct(tokens.other),
              percent: pctLabel(tokens.other),
              color: "var(--syntax-comment)",
            },
          ].filter((x) => x.tokens > 0)
        }

        if (estimated <= input) {
          return build({ system, user, assistant, tool, other: input - estimated })
        }

        const scale = input / estimated
        const scaled = {
          system: Math.floor(system * scale),
          user: Math.floor(user * scale),
          assistant: Math.floor(assistant * scale),
          tool: Math.floor(tool * scale),
        }
        const scaledTotal = scaled.system + scaled.user + scaled.assistant + scaled.tool
        return build({ ...scaled, other: Math.max(0, input - scaledTotal) })
      },
    ),
  )

  function Stat(statProps: { label: string; value: JSX.Element }) {
    return (
      <div class="flex flex-col gap-1">
        <div class="text-12-regular text-text-weak">{statProps.label}</div>
        <div class="text-12-medium text-text-strong">{statProps.value}</div>
      </div>
    )
  }

  const stats = createMemo(() => {
    const c = ctx()
    const count = counts()
    return [
      { label: _(S.contextTabSession), value: props.info()?.title ?? params.id ?? "—" },
      { label: _(S.contextTabMessages), value: number(count.all) },
      { label: _(S.contextTabProvider), value: providerLabel() },
      { label: _(S.contextTabModel), value: modelLabel() },
      { label: _(S.contextTabContextLimit), value: number(c?.limit) },
      { label: _(S.contextTabTotalTokens), value: number(c?.total) },
      { label: _(S.contextTabUsage), value: percent(c?.usage) },
      { label: _(S.contextTabInputTokens), value: number(c?.input) },
      { label: _(S.contextTabOutputTokens), value: number(c?.output) },
      { label: _(S.contextTabReasoningTokens), value: number(c?.reasoning) },
      { label: _(S.contextTabCacheTokens), value: `${number(c?.cacheRead)} / ${number(c?.cacheWrite)}` },
      { label: _(S.contextTabUserMessages), value: number(count.user) },
      { label: _(S.contextTabAssistantMessages), value: number(count.assistant) },
      { label: _(S.contextTabTotalCost), value: cost() },
      { label: _(S.contextTabSessionCreated), value: time(props.info()?.time.created) },
      { label: _(S.contextTabLastActivity), value: time(c?.message.time.created) },
    ] satisfies { label: string; value: JSX.Element }[]
  })

  function RawMessageContent(msgProps: { message: Message }) {
    const file = createMemo(() => {
      const parts = (sync.data.part[msgProps.message.id] ?? []) as Part[]
      const contents = JSON.stringify({ message: msgProps.message, parts }, null, 2)
      return {
        name: `${msgProps.message.role}-${msgProps.message.id}.json`,
        contents,
        cacheKey: checksum(contents),
      }
    })

    return <Code file={file()} overflow="wrap" class="select-text" />
  }

  function RawMessage(msgProps: { message: Message }) {
    return (
      <Accordion.Item value={msgProps.message.id}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div class="flex items-center justify-between gap-2 w-full">
              <div class="min-w-0 truncate">
                {msgProps.message.role} <span class="text-text-base">• {msgProps.message.id}</span>
              </div>
              <div class="flex items-center gap-3">
                <div class="shrink-0 text-12-regular text-text-weak">{time(msgProps.message.time.created)}</div>
                <Icon name={getSemanticIcon("navigation.expand")} size="small" class="shrink-0 text-text-weak" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content class="bg-background-base">
          <div class="p-3">
            <RawMessageContent message={msgProps.message} />
          </div>
        </Accordion.Content>
      </Accordion.Item>
    )
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = (retries = 0) => {
    const el = scroll
    if (!el) return

    const s = props.view()?.scroll("context")
    if (!s) return

    if (el.scrollHeight <= el.clientHeight && retries < 10) {
      requestAnimationFrame(() => restoreScroll(retries + 1))
      return
    }

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      props.view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => props.messages()?.length ?? 0,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <div
      class="@container h-full overflow-y-auto no-scrollbar pb-10"
      ref={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats()}>{(stat) => <Stat label={stat.label} value={stat.value} />}</For>
        </div>

        <Show when={breakdown().length > 0}>
          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{_(S.contextTabBreakdown)}</div>
            <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
              <For each={breakdown()}>
                {(segment) => (
                  <div
                    class="h-full"
                    style={{
                      width: `${segment.width}%`,
                      "background-color": segment.color,
                    }}
                  />
                )}
              </For>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">
              <For each={breakdown()}>
                {(segment) => (
                  <div class="flex items-center gap-1 text-11-regular text-text-weak">
                    <div class="size-2 rounded-sm" style={{ "background-color": segment.color }} />
                    <div>{segment.label}</div>
                    <div class="text-text-weaker">{segment.percent}</div>
                  </div>
                )}
              </For>
            </div>
            <div class="hidden text-11-regular text-text-weaker">{_(S.contextTabBreakdownHint)}</div>
          </div>
        </Show>

        <Show when={systemPrompt()}>
          {(prompt) => (
            <div class="flex flex-col gap-2">
              <div class="text-12-regular text-text-weak">{_(S.contextTabSysPrompt)}</div>
              <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
                <Markdown text={prompt()} class="text-12-regular" />
              </div>
            </div>
          )}
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{_(S.contextTabRawMessages)}</div>
          <Accordion multiple>
            <For each={props.messages()}>{(message) => <RawMessage message={message} />}</For>
          </Accordion>
        </div>
      </div>
    </div>
  )
}
