import { createEffect, createMemo, createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { Collapsible } from "./collapsible"
import { Spinner } from "./spinner"
import { Countdown } from "./countdown"
import { ToolTrigger, type ToolTriggerProps } from "./tool/trigger"
import { type IconName } from "./icon"
import { ToolTextOutput } from "./tool-output-text"
import { classifyTool } from "./tool/classifier"

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
    if (t.icon) return trigger as ToolTriggerProps
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

  const triggerProps = createMemo(() => fromTrigger(props.trigger, props.icon, props.onSubtitleClick))

  return (
    <Collapsible open={open()} onOpenChange={setOpen} variant="tool" data-tool-status={props.status ?? "completed"}>
      <Collapsible.Trigger>
        <Show
          when={triggerProps()}
          fallback={
            // Raw JSX.Element fallback (anchored-tool-card, file-ops custom triggers)
            <Show when={props.trigger as JSX.Element}>{(el) => el()}</Show>
          }
        >
          {(tp) => <ToolTrigger {...tp()} />}
        </Show>
        <div data-slot="tool-trigger-status">
          <Switch>
            <Match when={active()}>
              <Show when={charsLabel()}>
                <span data-slot="tool-trigger-chars">{charsLabel()}</span>
              </Show>
              <Show when={props.countdown != null}>
                <Countdown seconds={props.countdown!} active={active()} />
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
 * Uses semantic classification to pick icon, title, subtitle, and args badges
 * for external tools, MCP tools, and any future unregistered tools.
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
}) {
  const classified = createMemo(() =>
    classifyTool(props.tool, props.input, { ...props.metadata, title: props.title ?? props.metadata?.title }),
  )

  return (
    <BasicTool
      status={props.status}
      charsReceived={props.charsReceived}
      trigger={{
        icon: classified().spec.icon,
        title: classified().title,
        subtitle: classified().subtitle,
        tags: classified().args?.map((a) => ({ label: a })),
      }}
      hideDetails={props.hideDetails}
    >
      <Show when={props.output}>
        {(output) => (
          <div data-component="tool-output" data-scrollable>
            <ToolTextOutput text={output()} />
          </div>
        )}
      </Show>
    </BasicTool>
  )
}
