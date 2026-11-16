import { createMemo, ErrorBoundary, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrganizationProtocol as Protocol } from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { DataProvider, type Data } from "@ericsanchezok/synergy-ui/context/data"
import {
  createSessionDataView,
  EMPTY_CORTEX,
  EMPTY_PERMISSIONS,
  EMPTY_QUESTIONS,
} from "@ericsanchezok/synergy-ui/context/session-data-view"
import { SessionDecisionSurface } from "@/components/session/decision-surface"
import { SessionDecisionProvider } from "@/context/session-decision"
import { useSpace } from "@/context/space"
import { createOrganizationInteractionRuntime, type OrganizationInteractionDecision } from "./interaction-runtime"
import { WorkspaceError } from "./workspace-error"
import "./interactions.css"

const messages = {
  refresh: { id: "organization.interactions.refresh", message: "Refresh requests" },
  more: { id: "organization.interactions.more", message: "More requests" },
  first: { id: "organization.interactions.first", message: "First requests" },
  check: { id: "organization.interactions.check", message: "Check response status" },
  retry: { id: "organization.interactions.retry", message: "Retry original response" },
  unknown: { id: "organization.interactions.unknown", message: "The response status is unconfirmed." },
  expired: { id: "organization.interactions.expired", message: "This request has expired." },
  answered: { id: "organization.interactions.answered", message: "Answered by {name}." },
  skipped: { id: "organization.interactions.skipped", message: "Skipped by {name}." },
  allowedOnce: { id: "organization.interactions.allowedOnce", message: "Allowed once by {name}." },
  allowedSession: { id: "organization.interactions.allowedSession", message: "Allowed for this session by {name}." },
  allowedAlways: { id: "organization.interactions.allowedAlways", message: "Always allowed by {name}." },
  denied: { id: "organization.interactions.denied", message: "Denied by {name}." },
  handled: { id: "organization.interactions.handled", message: "This request was handled." },
  close: { id: "organization.interactions.dismiss", message: "Dismiss status" },
  passwordLost: {
    id: "organization.interactions.passwordLost",
    message: "The original password answer was kept only in memory. Check its status before answering again.",
  },
  memberScope: {
    id: "organization.interactions.memberScope",
    message: "Save these rules for future matching work in every project on this Runtime, until the rules are removed.",
  },
  hostedScope: {
    id: "organization.interactions.hostedScope",
    message:
      "Save these rules for future matching work by all members in every project on this hosted Runtime, until the rules are removed.",
  },
  moreStatuses: { id: "organization.interactions.moreStatuses", message: "More response statuses" },
  firstStatuses: { id: "organization.interactions.firstStatuses", message: "First response statuses" },
  submitted: { id: "organization.interactions.submitted", message: "Response submitted {date}" },
}

export function OrganizationSessionInteractions(props: {
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  online: boolean
  invalidated?: (error: unknown) => void
}) {
  return (
    <ErrorBoundary fallback={() => <WorkspaceError error={{ code: "COMMAND_OUTCOME_UNKNOWN" }} />}>
      <InteractionSurface {...props} />
    </ErrorBoundary>
  )
}
function InteractionSurface(props: {
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  online: boolean
  invalidated?: (error: unknown) => void
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const owner = space.current()!
  const runtime = createOrganizationInteractionRuntime({
    api: space.client()!,
    accountID: space.connection()!.account.accountID,
    connectionKey: owner.key,
    rootSessionID: props.sessionID,
    sourceSessionID: props.sourceSessionID,
    binding: props.binding,
    signal: owner.signal,
    invalidated: props.invalidated,
  })
  const [data] = createStore<Data>({ session: [], session_diff: {}, message: {}, part: {} })
  const questions = createMemo(() =>
    runtime.visible().flatMap((entry) =>
      entry.kind === "question"
        ? [
            {
              id: entry.requestID,
              sessionID: entry.sourceSessionID,
              questions: entry.questions,
              tool: entry.tool,
              timeout: entry.timeout,
              createdAt: entry.createdAt,
            },
          ]
        : [],
    ),
  )
  const permissions = createMemo(() =>
    runtime.visible().flatMap((entry) =>
      entry.kind === "permission"
        ? [
            {
              id: entry.requestID,
              sessionID: entry.sourceSessionID,
              permission: entry.permission,
              patterns: entry.patterns,
              metadata: {},
              tool: entry.tool,
            },
          ]
        : [],
    ),
  )
  const view = createSessionDataView(data, {
    statusFor: () => undefined,
    cortexTasks: () => EMPTY_CORTEX,
    questionsFor: (id) => (id === runtime.sourceID ? questions() : EMPTY_QUESTIONS),
    permissionsFor: (id) => (id === runtime.sourceID ? permissions() : EMPTY_PERMISSIONS),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const compact = window.matchMedia("(max-width: 600px) and (max-height: 740px)").matches
  async function poll() {
    if (disposed || owner.signal.aborted || !runtime.active()) return
    if (props.online) {
      await runtime.load(false, true)
      try {
        await runtime.reconcilePending()
      } catch (error) {
        runtime.fail(error)
      }
    }
    if (!disposed && !owner.signal.aborted)
      timer = setTimeout(() => void poll(), document.visibilityState === "visible" ? 5000 : 15000)
  }
  onMount(() => void poll())
  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })
  function resolution(value: OrganizationInteractionDecision) {
    if (value.state === "expired") return _(messages.expired)
    if (value.state !== "resolved") return ""
    const name = value.winner.actor?.displayName
    if (!name) return _(messages.handled)
    const outcome = value.winner.outcome
    const descriptor =
      outcome.kind === "question"
        ? outcome.reply === "answer"
          ? messages.answered
          : messages.skipped
        : outcome.reply === "once"
          ? messages.allowedOnce
          : outcome.reply === "session"
            ? messages.allowedSession
            : outcome.reply === "always"
              ? messages.allowedAlways
              : messages.denied
    return _({ ...descriptor, values: { name } })
  }
  return (
    <div class="organization-interactions">
      <WorkspaceError error={runtime.error()} retry={runtime.active() ? () => void runtime.load() : undefined} />
      <Show when={runtime.notice()}>
        {(value) => (
          <div role="status" class="organization-interaction-status">
            <span>{resolution(value())}</span>
            <Button variant="ghost" onClick={runtime.dismissNotice}>
              {_(messages.close)}
            </Button>
          </div>
        )}
      </Show>
      <For each={runtime.blocked()}>
        {(entry) => (
          <div class="organization-interaction-recovery" role="status">
            <p>{_(messages.unknown)}</p>
            <p>
              {_({
                ...messages.submitted,
                values: {
                  date: new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(
                    entry.createdAt,
                  ),
                },
              })}
            </p>
            <Show when={entry.sensitive && !entry.available}>
              <p>{_(messages.passwordLost)}</p>
            </Show>
            <div class="organization-form-actions">
              <Button disabled={!!runtime.checking() || !props.online} onClick={() => void runtime.check(entry)}>
                {_(messages.check)}
              </Button>
              <Show when={runtime.retryable().has(entry.requestID) && entry.available}>
                <Button
                  disabled={!!runtime.checking() || !props.online}
                  onClick={() => void runtime.check(entry, true)}
                >
                  {_(messages.retry)}
                </Button>
              </Show>
            </div>
          </div>
        )}
      </For>
      <Show when={runtime.outboxStart() || runtime.outboxCursor()}>
        <div class="organization-form-actions">
          <Show when={runtime.outboxStart()}>
            <Button
              variant="ghost"
              disabled={runtime.loadingRetained() || !runtime.active()}
              onClick={() => void runtime.retainedPage(false, true)}
            >
              {_(messages.firstStatuses)}
            </Button>
          </Show>
          <Show when={runtime.outboxCursor()}>
            <Button
              variant="ghost"
              disabled={runtime.loadingRetained() || !runtime.active()}
              onClick={() => void runtime.retainedPage(true)}
            >
              {_(messages.moreStatuses)}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.online}>
        <DataProvider data={data} directory={null} serverUrl={space.connection()!.issuer}>
          <SessionDecisionProvider value={runtime.decisions}>
            <SessionDecisionSurface
              sessionId={runtime.sourceID}
              view={() => view}
              persistentScope={runtime.runtimeKind() === "hosted" ? messages.hostedScope : messages.memberScope}
              defaultCollapsed={compact}
            />
          </SessionDecisionProvider>
        </DataProvider>
      </Show>
      <Show when={runtime.cursor() || runtime.earlier()}>
        <div class="organization-form-actions">
          <Button variant="ghost" disabled={runtime.loading() || !props.online} onClick={() => void runtime.load()}>
            {_(runtime.earlier() ? messages.first : messages.refresh)}
          </Button>
          <Show when={runtime.cursor()}>
            <Button
              variant="ghost"
              disabled={runtime.loading() || !props.online}
              onClick={() => void runtime.load(true)}
            >
              {_(messages.more)}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
