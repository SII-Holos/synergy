import { createMemo, createSignal, For, Show, type JSX, onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import type { WorkbenchPanelContentProps } from "@/plugin/registries/workbench-panel-registry"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLocale } from "@/context/locale"
import { contextWorkspace as C } from "@/locales/messages"
import {
  buildContextPanelModel,
  createContextPanelPresentation,
  formatContextNumber,
  formatContextPercent,
} from "./context-model"
import { RawMessagesDialog } from "@/components/session/raw-messages-dialog"
import { compactSessionWithCurrentModel, isSessionCompactionPending } from "@/components/session/compact-action"
import { S } from "@/components/session/session-i18n"

function DetailRow(props: { label: string; value: string }) {
  return (
    <div class="flex items-start justify-between gap-3 border-b border-border-weaker-base py-2 last:border-b-0">
      <span class="text-12-regular text-text-weak">{props.label}</span>
      <span class="min-w-0 break-words text-right text-12-medium text-text-strong">{props.value}</span>
    </div>
  )
}

function DeveloperDetails(props: { title: string; children: JSX.Element }) {
  return (
    <details class="border-t border-border-weaker-base py-4">
      <summary class="cursor-pointer text-13-medium text-text-strong marker:text-text-weaker">{props.title}</summary>
      <div class="mt-3">{props.children}</div>
    </details>
  )
}

export function ContextWorkbenchContent(_props: WorkbenchPanelContentProps) {
  const params = useParams()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const { i18n, fmt } = useLocale()
  const sessionID = createMemo(() => params.id)
  const messages = createMemo(() => (sessionID() ? (sync.data.message[sessionID()!] ?? []) : []))
  const session = createMemo(() => (sessionID() ? sync.session.get(sessionID()!) : undefined))
  const providers = createMemo(() =>
    Object.fromEntries(sync.data.provider.all.map((provider) => [provider.id, provider])),
  )
  const model = createMemo(() =>
    buildContextPanelModel({
      session: session(),
      messages: messages(),
      latestMessage: sessionID() ? sync.session.latestContextMessage(sessionID()!) : null,
      providers: providers(),
      status: sessionID() ? sync.data.session_status[sessionID()!] : undefined,
      pendingItems: sessionID() ? (sync.data.inbox[sessionID()!]?.length ?? 0) : 0,
      compactRequestPending: isSessionCompactionPending(sessionID()),
      presentation: createContextPanelPresentation(i18n, fmt),
    }),
  )
  const percentage = createMemo(() => model().usage.contextPercentage)
  const n = (value: number | null | undefined) => formatContextNumber(value, fmt.number)
  const p = (value: number | null | undefined) => formatContextPercent(value, fmt.percent)
  const time = (value: number | undefined) => (value ? fmt.dateTime(value) : "—")
  const [instructionCopyState, setInstructionCopyState] = createSignal<"idle" | "copied" | "failed">("idle")
  let instructionCopyTimer: number | undefined

  const openRawMessages = () => {
    const id = sessionID()
    if (id) dialog.show(() => <RawMessagesDialog sessionID={id} />)
  }
  const copyLatestUserSystemOverride = async () => {
    const instructions = model().latestUserSystemOverride
    if (!instructions) return
    const result = await copyTextToClipboard(instructions, {
      label: i18n._(C.copySystemInstructions),
      failureDescription: i18n._(C.copySystemInstructionsFailed),
    })
    setInstructionCopyState(result.ok ? "copied" : "failed")
    if (instructionCopyTimer) window.clearTimeout(instructionCopyTimer)
    instructionCopyTimer = window.setTimeout(() => setInstructionCopyState("idle"), 1_600)
  }
  onCleanup(() => {
    if (instructionCopyTimer) window.clearTimeout(instructionCopyTimer)
  })

  return (
    <div class="h-full overflow-y-auto bg-background-stronger px-4 py-5 sm:px-5">
      <div class="mx-auto flex max-w-[42rem] flex-col pb-10">
        <section class="pb-5">
          <div class="flex flex-col gap-3">
            <p class="text-16-semibold text-text-strong" data-tone={model().statusTone}>
              {model().statusSummary}
            </p>
            <div class="flex items-end justify-between gap-3">
              <div>
                <div class="text-12-regular text-text-weak">{i18n._(C.usedInput)}</div>
                <div class="mt-1 text-24-semibold text-text-strong">{n(model().usage.exactInputTokens)}</div>
              </div>
              <div class="text-right text-12-regular text-text-weak">
                <Show
                  when={model().usage.usableInputLimit !== null}
                  fallback={<div>{i18n._(C.contextLimitUnknown)}</div>}
                >
                  <div>{i18n._({ ...C.percentUsed, values: { percent: p(percentage()) } })}</div>
                  <div>
                    {i18n._({ ...C.tokensRemaining, values: { tokens: n(model().usage.remainingInputTokens) } })}
                  </div>
                </Show>
              </div>
            </div>
            <Show when={model().usage.usableInputLimit !== null}>
              <div class="h-2 overflow-hidden rounded-full bg-surface-inset-base" aria-hidden="true">
                <div
                  class="h-full rounded-full bg-text-strong transition-[width]"
                  style={{ width: `${Math.max(0, Math.min(100, percentage() ?? 0))}%` }}
                />
              </div>
            </Show>
            <p class="text-12-regular text-text-weak">
              {i18n._({ ...C.modelLabel, values: { model: model().modelLabel } })}
            </p>
            <Show when={model().compact.visible}>
              <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-surface-warning-base px-3 py-2 text-text-on-warning-base">
                <span class="text-12-medium">{i18n._(C.compactHint)}</span>
                <Button
                  type="button"
                  size="small"
                  variant="secondary"
                  class="min-h-11"
                  icon={getSemanticIcon("command.compact")}
                  disabled={!model().compact.eligible}
                  onClick={() =>
                    void compactSessionWithCurrentModel({
                      sdk,
                      local,
                      sessionID: sessionID(),
                      notices: {
                        noModel: { title: i18n._(S.cmdToastNoModel), description: i18n._(S.cmdToastNoModelDesc) },
                        failure: {
                          title: i18n._(S.cmdToastCompactFailed),
                          description: i18n._(S.cmdToastCompactFailedDesc),
                        },
                      },
                    })
                  }
                >
                  {model().compact.inProgress ? i18n._(C.statusCompacting) : i18n._(C.compactAction)}
                </Button>
              </div>
            </Show>
          </div>
        </section>

        <section class="border-t border-border-weaker-base py-5">
          <h3 class="text-13-medium text-text-strong">{i18n._(C.breakdownTitle)}</h3>
          <Show
            when={model().breakdownAvailable}
            fallback={
              <p class="mt-3 rounded-lg bg-surface-raised-base px-3 py-3 text-12-regular text-text-weak">
                {i18n._(C.breakdownUnavailable)}
              </p>
            }
          >
            <div class="mt-3 flex flex-col gap-4">
              <For each={model().breakdownRows}>
                {(row) => (
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <div class="text-12-medium text-text-strong">{row.label}</div>
                        <div class="text-11-regular text-text-weaker">{row.description}</div>
                        <Show when={row.items !== null}>
                          <div class="text-11-regular text-text-weaker">
                            {i18n._({ ...C.itemCount, values: { count: row.items } })}
                          </div>
                        </Show>
                      </div>
                      <div class="shrink-0 text-right">
                        <div class="text-12-medium text-text-strong">
                          {row.estimated
                            ? i18n._({ ...C.estimatedTokens, values: { tokens: n(row.attributedTokens) } })
                            : n(row.attributedTokens)}
                        </div>
                        <div class="text-11-regular text-text-weaker">
                          {i18n._({ ...C.exactInputShare, values: { percent: p(row.percent) } })}
                        </div>
                      </div>
                    </div>
                    <div class="h-1.5 overflow-hidden rounded-full bg-surface-inset-base" aria-hidden="true">
                      <div
                        class="h-full rounded-full bg-text-weaker"
                        style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }}
                      />
                    </div>
                  </div>
                )}
              </For>
              <p class="text-11-regular text-text-weaker">{i18n._(C.estimateNote)}</p>
            </div>
          </Show>
        </section>

        <section class="border-t border-border-weaker-base py-4">
          <h3 class="text-13-medium text-text-strong">{i18n._(C.usageDetails)}</h3>
          <div class="mt-3">
            <DetailRow label={i18n._(C.provider)} value={model().providerLabel} />
            <DetailRow label={i18n._(C.model)} value={model().modelLabel} />
            <DetailRow label={i18n._(C.contextWindow)} value={n(model().usage.contextWindow)} />
            <DetailRow label={i18n._(C.contextUsage)} value={p(model().usage.contextPercentage)} />
            <DetailRow label={i18n._(C.usedInput)} value={n(model().usage.exactInputTokens)} />
            <DetailRow label={i18n._(C.remainingInput)} value={n(model().usage.remainingInputTokens)} />
            <DetailRow label={i18n._(C.latestCallTotal)} value={n(model().usage.latestCallTotalTokens)} />
            <DetailRow
              label={i18n._(C.latestOutputReasoning)}
              value={`${n(model().usage.outputTokens)} / ${n(model().usage.reasoningTokens)}`}
            />
            <DetailRow
              label={i18n._(C.cacheReadWrite)}
              value={`${n(model().usage.cacheReadTokens)} / ${n(model().usage.cacheWriteTokens)}`}
            />
            <DetailRow label={i18n._(C.latestCallCost)} value={model().usage.latestCallCost} />
            <DetailRow label={i18n._(C.loadedMessagesCost)} value={model().usage.loadedMessagesCost} />
          </div>
        </section>

        <section class="border-t border-border-weaker-base py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-13-medium text-text-strong">{i18n._(C.dataAccess)}</h3>
              <p class="mt-1 text-12-regular text-text-weak">{i18n._(C.dataAccessDescription)}</p>
            </div>
            <Button
              type="button"
              variant="secondary"
              class="min-h-11"
              icon={getSemanticIcon("action.view")}
              onClick={openRawMessages}
            >
              {i18n._(C.rawMessages)}
            </Button>
          </div>
          <details class="mt-4 rounded-lg bg-surface-raised-base px-3 py-3">
            <summary class="cursor-pointer text-12-medium text-text-strong marker:text-text-weaker">
              {i18n._(C.latestUserSystemOverride)}
            </summary>
            <div class="mt-3 flex flex-col gap-3">
              <Show
                when={model().latestUserSystemOverride}
                fallback={<p class="text-12-regular text-text-weak">{i18n._(C.noSystemInstructions)}</p>}
              >
                {(instructions) => (
                  <>
                    <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-inset-base px-3 py-2 text-12-regular text-text-base">
                      {instructions()}
                    </pre>
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="small"
                        variant="secondary"
                        class="min-h-11"
                        icon={getSemanticIcon("action.copy")}
                        onClick={() => void copyLatestUserSystemOverride()}
                      >
                        {i18n._(C.copy)}
                      </Button>
                      <Show when={instructionCopyState() !== "idle"}>
                        <span class="text-12-medium text-text-weak">
                          {instructionCopyState() === "copied" ? i18n._(C.copied) : i18n._(C.copyFailed)}
                        </span>
                      </Show>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </details>
        </section>

        <DeveloperDetails title={i18n._(C.developerDetails)}>
          <DetailRow label={i18n._(C.sessionTitle)} value={model().developerDetails.title} />
          <DetailRow label={i18n._(C.sessionID)} value={model().developerDetails.sessionID} />
          <DetailRow label={i18n._(C.messages)} value={n(model().developerDetails.effectiveMessages)} />
          <DetailRow label={i18n._(C.userMessages)} value={n(model().developerDetails.effectiveUserMessages)} />
          <DetailRow
            label={i18n._(C.assistantMessages)}
            value={n(model().developerDetails.effectiveAssistantMessages)}
          />
          <DetailRow label={i18n._(C.sessionCreated)} value={time(model().developerDetails.createdAt)} />
          <DetailRow label={i18n._(C.lastActivity)} value={time(model().developerDetails.updatedAt)} />
          <DetailRow label={i18n._(C.estimatorKind)} value={model().developerDetails.estimatorKind ?? "—"} />
          <DetailRow label={i18n._(C.estimatorEncoding)} value={model().developerDetails.estimatorEncoding ?? "—"} />
          <DetailRow label={i18n._(C.reconciliationMode)} value={model().developerDetails.reconciliationMode ?? "—"} />
          <DetailRow label={i18n._(C.reconciliationFactor)} value={n(model().developerDetails.reconciliationFactor)} />
          <DetailRow label={i18n._(C.rawEstimatedTotal)} value={n(model().developerDetails.rawEstimatedTotal)} />
          <DetailRow label={i18n._(C.attributedTotal)} value={n(model().developerDetails.attributedTotal)} />
          <For each={model().breakdownRows}>
            {(row) => (
              <DetailRow
                label={i18n._({ ...C.estimatedAttributed, values: { category: row.label } })}
                value={`${n(row.estimatedTokens)} / ${n(row.attributedTokens)}`}
              />
            )}
          </For>
        </DeveloperDetails>
      </div>
    </div>
  )
}
