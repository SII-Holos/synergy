import { createEffect, createMemo, createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Spinner } from "./spinner"
import { Countdown } from "./countdown"
import { ToolTrigger, type ToolTriggerProps } from "./tool/trigger"
import { withSubtitleClickHandler } from "./tool/trigger-normalization"
import { type IconName } from "./icon"
import { ToolTextOutput } from "./tool-output-text"
import { classifyTool } from "./tool/classifier"
import { toolCountdown, type ToolTime } from "./tool/timeout"

/** Legacy trigger value shape (pre-ToolTriggerProps). */
interface LegacyTriggerValue {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

export type LegacyTrigger = LegacyTriggerValue | (() => LegacyTriggerValue)

// Trigger can be ToolTriggerProps, the legacy {title, args} function/object, or raw JSX.
type Trigger = ToolTriggerProps | LegacyTrigger | JSX.Element

export interface BasicToolProps {
  trigger?: Trigger
  /** Legacy icon for use with legacy trigger patterns. */
  icon?: IconName
  children?: JSX.Element
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  status?: string
  countdown?: number
  countdownStartedAt?: number
  metadata?: Record<string, any>
  time?: ToolTime
  charsReceived?: number
  onSubtitleClick?: () => void
}

/** Returns ToolTriggerProps from any trigger shape, or undefined for raw JSX. */
function fromTrigger(
  trigger: Trigger | undefined,
  icon?: IconName,
  onSubtitleClick?: () => void,
): ToolTriggerProps | undefined {
  if (!trigger) return undefined
  // ToolTriggerProps — non-function object with icon field
  if (typeof trigger === "object" && !Array.isArray(trigger) && !("$$typeof" in (trigger as any))) {
    const t = trigger as any
    if (t.icon) return withSubtitleClickHandler(trigger as ToolTriggerProps, onSubtitleClick)
    if (typeof t.title === "string") {
      return {
        icon: icon ?? "settings",
        title: t.title as string,
        titleClass: t.titleClass as string | undefined,
        subtitle: t.subtitle as string | undefined,
        subtitleClass: t.subtitleClass as string | undefined,
        tags: (t.args as string[] | undefined)?.map((a) => ({ label: a })),
        argsClass: t.argsClass as string | undefined,
        action: t.action as JSX.Element | undefined,
        onSubtitleClick,
      }
    }
    return undefined
  }
  // Legacy function — call it
  if (typeof trigger === "function") {
    const resolved = (trigger as () => LegacyTriggerValue)()
    if (!resolved || typeof resolved.title !== "string") return undefined
    return {
      icon: icon ?? "settings",
      title: resolved.title,
      titleClass: resolved.titleClass,
      subtitle: resolved.subtitle,
      subtitleClass: resolved.subtitleClass,
      tags: resolved.args?.map((a) => ({ label: a })),
      argsClass: resolved.argsClass,
      action: resolved.action,
      onSubtitleClick,
    }
  }
  // JSX.Element
  return undefined
}

export function BasicTool(props: BasicToolProps) {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)
  const active = () => props.status === "pending" || props.status === "running" || props.status === "generating"

  createEffect(() => {
    if (props.forceOpen) setOpen(true)
  })

  const charsLabel = createMemo(() => {
    if (props.status !== "generating" || !props.charsReceived) return null
    return `${props.charsReceived.toLocaleString()} chars`
  })
  const countdown = createMemo(() => {
    if (props.countdown !== undefined) {
      return { seconds: props.countdown, startedAt: props.countdownStartedAt ?? props.time?.start }
    }
    return toolCountdown(props.metadata, props.time)
  })

  const triggerProps = createMemo(() => fromTrigger(props.trigger, props.icon, props.onSubtitleClick))
  const rawTrigger = createMemo<JSX.Element | undefined>(() => {
    if (triggerProps()) return undefined
    const trigger = props.trigger
    if (!trigger) return undefined
    return typeof trigger === "function" ? (trigger as unknown as () => JSX.Element)() : (trigger as JSX.Element)
  })

  return (
    <Collapsible open={open()} onOpenChange={setOpen} variant="tool" data-tool-status={props.status ?? "completed"}>
      <Collapsible.Trigger>
        <Show
          keyed
          when={triggerProps()}
          fallback={
            // Raw JSX.Element fallback (anchored-tool-card, file-ops custom triggers)
            rawTrigger()
          }
        >
          {(tp) => <ToolTrigger {...tp} />}
        </Show>
        <div data-slot="tool-trigger-status">
          <Switch>
            <Match when={active()}>
              <Show when={charsLabel()}>
                <span data-slot="tool-trigger-chars">{charsLabel()}</span>
              </Show>
              <Show keyed when={countdown()}>
                {(value) => <Countdown seconds={value.seconds} startedAt={value.startedAt} active={active()} />}
              </Show>
              <Spinner />
            </Match>
            <Match when={props.children && !props.hideDetails}>
              <Collapsible.Arrow />
            </Match>
          </Switch>
        </div>
      </Collapsible.Trigger>
      <Show when={props.children && !props.hideDetails}>
        <Collapsible.Content>{props.children}</Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

/**
 * SmartTool — intelligent fallback for unregistered tools.
 *
 * Instead of showing a plain gray gear icon with just the tool name,
 * SmartTool uses semantic classification to automatically:
 * - Pick a meaningful icon based on what the tool does
 * - Extract a human-readable title
 * - Pull the most relevant subtitle from the input
 * - Show contextual args badges
 * - Display output in a scrollable pane when available
 *
 * This covers external agent tools (codex shell, cline execute_command,
 * gemini read_file), MCP tools, and any future tools — all without
 * writing a single new ToolRegistry.register() entry.
 *
 * When `fallbackMeta` is provided (from plugin Tier 1 declarative metadata),
 * its icon/title/subtitleTemplate values override the auto-classified
 * defaults, giving plugin authors control over the smart fallback display.
 */
export function SmartTool(props: {
  tool: string
  input: Record<string, any>
  title?: string
  output?: string
  status?: string
  charsReceived?: number
  hideDetails?: boolean
  metadata?: Record<string, any>
  time?: ToolTime
  fallbackMeta?: {
    icon?: string
    title?: string
    subtitleTemplate?: string
  }
}) {
  const classified = createMemo(() =>
    classifyTool(props.tool, props.input, { ...props.metadata, title: props.title ?? props.metadata?.title }),
  )

  const icon = createMemo(() => {
    const fb = props.fallbackMeta
    if (fb?.icon) return fb.icon as IconName
    return classified().spec.icon
  })

  const title = createMemo(() => {
    const fb = props.fallbackMeta
    if (fb?.title) return fb.title
    return classified().title
  })

  const subtitle = createMemo(() => {
    const fb = props.fallbackMeta
    if (fb?.subtitleTemplate) {
      return resolveTemplate(fb.subtitleTemplate, props.input, props.metadata ?? {})
    }
    return classified().subtitle
  })

  return (
    <BasicTool
      status={props.status}
      charsReceived={props.charsReceived}
      metadata={props.metadata}
      time={props.time}
      trigger={{
        icon: icon(),
        title: title(),
        subtitle: subtitle(),
        tags: classified().args?.map((a) => ({ label: a })),
      }}
      hideDetails={props.hideDetails}
    >
      <Show keyed when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <ToolTextOutput text={output} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}

/**
 * Resolve a template string like "Reading {input.path}" by substituting
 * placeholder values from input or metadata.
 *
 * Placeholders use dot-separated paths: `{input.path}`, `{metadata.key}`.
 * Missing values produce the placeholder as-is.
 */
function resolveTemplate(template: string, input: Record<string, any>, metadata: Record<string, any>): string {
  return template.replace(/\{(\w[\w.]*)\}/g, (_match, path: string) => {
    const parts = path.split(".")
    const root = parts[0]
    let source: Record<string, any> | undefined
    if (root === "input") source = input
    else if (root === "metadata") source = metadata
    else return `{${path}}`

    let val: any = source
    for (const part of parts) {
      if (val == null || typeof val !== "object") return `{${path}}`
      val = val[part]
    }
    return typeof val === "string" ? val : `{${path}}`
  })
}
