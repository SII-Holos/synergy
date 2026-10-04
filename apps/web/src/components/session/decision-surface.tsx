import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  useContext,
  type ParentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { PermissionRequest, QuestionRequest } from "@ericsanchezok/synergy-sdk/client"
import { PortalStyleOwner, UIStyleProvider } from "@ericsanchezok/synergy-ui/context/ui-style"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useSessionDataView } from "@/context/session-data-view"
import { useSessionDecision } from "@/context/session-decision"
import { PermissionDock, permissionInfo } from "./permission-dock"
import { QuestionPrompt } from "./question-prompt"
import { RequestSubmissionNotice } from "./request-submission-notice"
import "./decision-surface.css"

import { SessionSurfaceFocusProvider, useSessionSurfaceFocus } from "./session-surface-focus"

const copy = {
  pending: { id: "session.decision.pending", message: "Pending {count}" },
  collapse: { id: "session.decision.collapse", message: "Collapse request" },
  expand: { id: "session.decision.expand", message: "Expand request" },
  more: { id: "session.decision.more", message: "More actions" },
  skip: { id: "session.decision.skip", message: "Skip this question" },
  question: { id: "session.decision.question", message: "Question" },
  permission: { id: "session.decision.permission", message: "Permission" },
  from: { id: "session.decision.from", message: "From {agent}" },
  agent: { id: "session.permissionDock.agent", message: "Agent" },
}
type DecisionItem =
  | { kind: "question"; key: string; request: QuestionRequest; origin?: undefined }
  | { kind: "permission"; key: string; request: PermissionRequest; origin?: string }

export function SessionDecisionSurface(props: { sessionId?: string }) {
  const view = useSessionDataView()
  const data = useData()
  const returnFocus = useSessionSurfaceFocus()
  const decisions = useSessionDecision()
  const { _ } = useLingui()
  const [collapsed, setCollapsed] = createSignal(false)
  const [queueOpen, setQueueOpen] = createSignal(false)
  const [moreOpen, setMoreOpen] = createSignal(false)
  const titleID = createUniqueId()
  let root: HTMLElement | undefined
  let collapseButton: HTMLButtonElement | undefined
  const items = createMemo<DecisionItem[]>(() => {
    const sessionID = props.sessionId
    if (!sessionID) return []
    const result: DecisionItem[] = []
    const add = (request: PermissionRequest, origin?: string) =>
      result.push({ kind: "permission", request, origin, key: decisions.key("permission", request) })
    for (const request of view().permissionsFor(sessionID)) add(request)
    for (const child of view()
      .sessions()
      .filter((session) => session.parentID === sessionID)) {
      for (const request of view().permissionsFor(child.id)) add(request, child.title || _(copy.agent))
    }
    result.sort((left, right) => left.request.id.localeCompare(right.request.id))
    for (const request of view().questionsFor(sessionID))
      result.push({ kind: "question", request, key: decisions.key("question", request) })
    return result.filter((item) => decisions.state(item.key).status !== "settled")
  })
  const active = createMemo(
    () => items().find((item) => item.key === decisions.selection(props.sessionId ?? "")) ?? items()[0],
  )
  const question = createMemo(() => {
    const item = active()
    return item?.kind === "question" ? item.request : undefined
  })
  const permission = createMemo(() => {
    const item = active()
    return item?.kind === "permission" ? item.request : undefined
  })
  const toolTitle = (title: string | MessageDescriptor) => (typeof title === "string" ? title : _(title))
  const title = (item: DecisionItem, heading = false) => {
    if (item.kind === "question") {
      const question = item.request.questions[decisions.draft(item.request).step]
      return (heading ? question?.header : question?.question) || _(copy.question)
    }
    return toolTitle(permissionInfo(item.request, view()).title)
  }
  createEffect(() => {
    const item = active()
    if (item && props.sessionId && decisions.selection(props.sessionId) !== item.key)
      decisions.select(props.sessionId, item.key)
  })
  createEffect(
    on(
      () => props.sessionId,
      () => {
        setCollapsed(false)
        setQueueOpen(false)
        setMoreOpen(false)
      },
    ),
  )
  const select = (item: DecisionItem) => {
    if (props.sessionId) decisions.select(props.sessionId, item.key)
    setQueueOpen(false)
    setCollapsed(false)
  }

  return (
    <Show when={active()?.key} keyed>
      {(_key) => {
        onCleanup(() => {
          if (!root?.contains(document.activeElement)) return
          queueMicrotask(() => {
            if (root?.isConnected) collapseButton?.focus()
            else returnFocus()
          })
        })
        return (
          <section
            ref={root}
            class="decision-card"
            data-session-decision-stack
            data-collapsed={collapsed()}
            aria-labelledby={titleID}
            onKeyDown={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('[data-component="popover-content"], [data-component="dialog"]')
              )
                return
              if (
                event.key !== "Escape" ||
                event.defaultPrevented ||
                event.isComposing ||
                collapsed() ||
                root?.querySelector('[data-slot="popover-trigger"][aria-expanded="true"]') ||
                !root?.contains(document.activeElement)
              )
                return
              event.preventDefault()
              collapseButton?.focus()
              setCollapsed(true)
            }}
          >
            <header class="decision-header">
              <Icon
                name={getSemanticIcon(active()?.kind === "question" ? "settings.questions" : "settings.permissions")}
                size="small"
              />
              <h3 id={titleID} class="decision-title">
                {active() && title(active()!, true)}
              </h3>
              <Show when={items().length > 1}>
                <Popover
                  variant="menu"
                  title={_({ ...copy.pending, values: { count: items().length } })}
                  open={queueOpen()}
                  onOpenChange={setQueueOpen}
                  placement="top-end"
                  triggerAs={(trigger) => (
                    <button {...trigger} type="button" class="decision-secondary-button">
                      {_({ ...copy.pending, values: { count: items().length } })}
                    </button>
                  )}
                >
                  <For each={items()}>
                    {(item) => (
                      <button
                        type="button"
                        class="decision-menu-row"
                        aria-current={item.key === active()?.key ? "true" : undefined}
                        onClick={() => select(item)}
                      >
                        <span>{title(item)}</span>
                        <span class="decision-secondary">
                          {_(item.kind === "question" ? copy.question : copy.permission)}
                        </span>
                      </button>
                    )}
                  </For>
                </Popover>
              </Show>
              <Show when={question()}>
                <Popover
                  variant="menu"
                  title={_(copy.more)}
                  open={moreOpen()}
                  onOpenChange={setMoreOpen}
                  placement="top-end"
                  triggerAs={(trigger) => (
                    <button {...trigger} type="button" class="decision-icon-button" aria-label={_(copy.more)}>
                      <Icon name={getSemanticIcon("action.more")} size="small" />
                    </button>
                  )}
                >
                  <button
                    type="button"
                    class="decision-menu-row"
                    disabled={
                      decisions.state(active()!.key).status !== "idle" &&
                      decisions.state(active()!.key).status !== "error"
                    }
                    onClick={() => {
                      const request = question()
                      setMoreOpen(false)
                      if (request) void decisions.respondQuestion(request)
                    }}
                  >
                    {_(copy.skip)}
                  </button>
                </Popover>
              </Show>
              <button
                ref={collapseButton}
                type="button"
                class="decision-icon-button"
                aria-expanded={!collapsed()}
                aria-label={_(collapsed() ? copy.expand : copy.collapse)}
                onClick={() => setCollapsed((value) => !value)}
              >
                <Icon name={getSemanticIcon(collapsed() ? "navigation.expand" : "navigation.collapse")} size="small" />
              </button>
            </header>
            <Show when={active()?.origin}>
              {(origin) => (
                <button
                  type="button"
                  class="decision-origin"
                  onClick={() => {
                    const item = active()
                    if (item) data.navigateToSession?.(item.request.sessionID)
                  }}
                >
                  {_({ ...copy.from, values: { agent: origin() } })}
                </button>
              )}
            </Show>
            <Show when={!collapsed()}>
              <Show
                when={question()}
                fallback={<Show when={permission()}>{(request) => <PermissionDock request={request()} />}</Show>}
              >
                {(request) => <QuestionPrompt request={request()} />}
              </Show>
              <RequestSubmissionNotice
                state={decisions.state(active()!.key)}
                onRetry={() => void decisions.retry(active()!.key)}
              />
            </Show>
          </section>
        )
      }}
    </Show>
  )
}

const DecisionOutletContext = createContext<(element: HTMLDivElement) => () => void>()

export function SessionDecisionOutlet() {
  const register = useContext(DecisionOutletContext)
  let element!: HTMLDivElement
  let release: (() => void) | undefined
  onMount(() => {
    release = register?.(element)
  })
  onCleanup(() => release?.())
  return <div ref={element} data-session-decision-outlet />
}

export function SessionDecisionHost(props: ParentProps<{ sessionId?: string; onReturnFocus?(): boolean }>) {
  let surface: HTMLDivElement | undefined
  const returnFocus = () => {
    if (props.onReturnFocus?.()) return
    const target = surface?.querySelector<HTMLElement>('[data-ui-part="session"]') ?? surface?.firstElementChild
    if (!(target instanceof HTMLElement) || !target.isConnected) return
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  const [outlet, setOutlet] = createSignal<HTMLDivElement>()
  return (
    <SessionSurfaceFocusProvider value={returnFocus}>
      <DecisionOutletContext.Provider
        value={(element) => {
          setOutlet(element)
          return () => setOutlet((current) => (current === element ? undefined : current))
        }}
      >
        <div ref={surface} class="contents" data-session-surface>
          {props.children}
        </div>
        <UIStyleProvider reset>
          <Portal mount={outlet()}>
            <PortalStyleOwner>
              <div
                data-session-decision-host
                style={
                  outlet()
                    ? undefined
                    : {
                        position: "fixed",
                        bottom: "1rem",
                        left: "50%",
                        transform: "translateX(-50%)",
                        width: "min(48rem, calc(100vw - 2rem))",
                        "z-index": 1000,
                      }
                }
              >
                <SessionDecisionSurface sessionId={props.sessionId} />
              </div>
            </PortalStyleOwner>
          </Portal>
        </UIStyleProvider>
      </DecisionOutletContext.Provider>
    </SessionSurfaceFocusProvider>
  )
}
