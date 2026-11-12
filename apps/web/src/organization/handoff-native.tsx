import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { WorkspaceError } from "./workspace-error"
import { organizationNativeHandoffMessages as messages } from "./handoff-native-messages"
import { createOrganizationHandoffDifference } from "./handoff-native-state"

export function OrganizationNativeDifference(props: {
  view: Handoff.View
  revision: number
  disabled: boolean
  pending: boolean
  read: (summary: Handoff.Difference, cursor?: string) => Promise<Handoff.MachineResult>
  preview: () => void
  accept: (consent: Handoff.DifferenceConsent) => void
  failed?: (error: unknown) => void
}) {
  const { _, i18n } = useLingui()
  type Reader = ReturnType<typeof createOrganizationHandoffDifference>
  const [state, setState] = createStore<{ current?: Reader["current"] }>({})
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [reviewed, setReviewed] = createSignal(false)
  let reader: Reader | undefined
  let identity = ""
  let generation = 0
  let request = 0
  let disposed = false
  let available: boolean | undefined
  const number = (value: number) => new Intl.NumberFormat(i18n().locale).format(value)
  const bytes = (value: number) =>
    new Intl.NumberFormat(i18n().locale, { style: "unit", unit: "byte", unitDisplay: "short" }).format(value)
  const mode = (value: number) => value.toString(8).padStart(4, "0")
  async function load(index: number) {
    const owner = reader
    if (!owner || props.pending || props.disabled || loading()) return
    const read = ++request
    const original = generation
    const position = owner.position(index)
    setLoading(true)
    setError(undefined)
    try {
      const result = await props.read(owner.summary, position.cursor)
      if (disposed || read !== request || original !== generation || owner !== reader) return
      if (!result.workspaceDifference || !result.differencePage)
        throw new Error("The destination returned no complete difference page")
      setState("current", reconcile(owner.accept(position, result.workspaceDifference, result.differencePage)))
    } catch (error) {
      if (!disposed && read === request && original === generation && !props.pending && !props.disabled) {
        setError(error)
        props.failed?.(error)
      }
    } finally {
      if (!disposed && read === request && original === generation) setLoading(false)
    }
  }
  createEffect(() => {
    const active = !props.disabled && !props.pending
    if (available !== active) {
      available = active
      generation++
      request++
      setLoading(false)
    }
    const summary = props.view.workspaceDifference
    const key = JSON.stringify([props.view.handoffID, summary, props.revision])
    if (key !== identity) {
      identity = key
      generation++
      request++
      reader = summary ? createOrganizationHandoffDifference(summary) : undefined
      setState("current", undefined)
      setLoading(false)
      setError(undefined)
      setReviewed(false)
    }
    if (reader && !state.current && !loading() && !error() && active) void load(0)
  })
  onCleanup(() => {
    disposed = true
    generation++
    request++
  })
  return (
    <section class="organization-handoff-native" aria-label={_(messages.differences)}>
      <p>{_(messages.previewHint)}</p>
      <Show
        when={props.view.workspaceDifference}
        fallback={
          <Button disabled={props.disabled || props.pending} onClick={props.preview}>
            {_(messages.preview)}
          </Button>
        }
      >
        {(summary) => (
          <>
            <h3>{_(messages.differences)}</h3>
            <p>{_(messages.differenceHint)}</p>
            <Show when={summary().mode.source !== summary().mode.target}>
              <p>
                {_({
                  ...messages.mode,
                  values: { source: mode(summary().mode.source), target: mode(summary().mode.target) },
                })}
              </p>
            </Show>
            <WorkspaceError
              error={error()}
              retry={
                !loading() && !props.pending && !props.disabled ? () => void load(state.current?.index ?? 0) : undefined
              }
            />
            <Show when={loading()}>
              <p role="status">{_(messages.loading)}</p>
            </Show>
            <Show when={state.current}>
              {(current) => (
                <>
                  <p>
                    {_({
                      ...messages.showing,
                      values: {
                        first: number(summary().entries ? current().start + 1 : 0),
                        last: number(current().start + (current().page?.items.length ?? 0)),
                        total: number(summary().entries),
                      },
                    })}
                  </p>
                  <Show when={current().page?.items.length} fallback={<p>{_(messages.empty)}</p>}>
                    <ul class="organization-handoff-differences">
                      <For each={current().page?.items}>
                        {(entry) => (
                          <li>
                            <strong>{entry.path}</strong>
                            <dl>
                              <For each={["source", "target"] as const}>
                                {(side) => (
                                  <div>
                                    <dt>{_(messages[side])}</dt>
                                    <dd>
                                      <Show when={entry[side]} fallback={_(messages.absent)}>
                                        {(header) => (
                                          <>
                                            {_(
                                              header().kind === "directory"
                                                ? messages.directoryKind
                                                : header().kind === "symlink"
                                                  ? messages.linkKind
                                                  : messages.fileKind,
                                            )}
                                            {" · "}
                                            {mode(header().mode)}
                                            <Show when={header().kind === "file"}>
                                              {(_file) => {
                                                const value = header()
                                                return value.kind === "file" ? (
                                                  <>
                                                    <span>
                                                      {" · "}
                                                      {bytes(value.size)}
                                                    </span>
                                                    <code title={value.hash}>{value.hash.slice(0, 12)}</code>
                                                  </>
                                                ) : null
                                              }}
                                            </Show>
                                            <Show when={header().kind === "symlink"}>
                                              {(_link) => {
                                                const value = header()
                                                return value.kind === "symlink" ? <code>{value.target}</code> : null
                                              }}
                                            </Show>
                                          </>
                                        )}
                                      </Show>
                                    </dd>
                                  </div>
                                )}
                              </For>
                            </dl>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <div class="organization-handoff-actions">
                    <Button
                      variant="ghost"
                      disabled={props.disabled || loading() || props.pending || current().index === 0}
                      onClick={() => void load(current().index - 1)}
                    >
                      {_(messages.previous)}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={props.disabled || loading() || props.pending || !current().page?.cursor}
                      onClick={() => void load(current().index + 1)}
                    >
                      {_(messages.next)}
                    </Button>
                  </div>
                </>
              )}
            </Show>
            <details class="organization-handoff-versions">
              <summary>{_(messages.details)}</summary>
              <dl>
                <div>
                  <dt>{_(messages.sourceVersion)}</dt>
                  <dd>
                    <code>{summary().sourceSnapshotHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>{_(messages.targetVersion)}</dt>
                  <dd>
                    <code>{summary().targetDigest}</code>
                  </dd>
                </div>
                <div>
                  <dt>{_(messages.differenceVersion)}</dt>
                  <dd>
                    <code>{summary().diffHash}</code>
                  </dd>
                </div>
              </dl>
            </details>
            <p>{_({ ...messages.incomplete, values: { total: number(summary().entries) } })}</p>
            <Show
              when={props.view.workspaceDifferenceAccepted}
              fallback={
                <>
                  <Checkbox
                    checked={reviewed()}
                    onChange={setReviewed}
                    disabled={props.disabled || props.pending || loading() || !state.current || !!error()}
                  >
                    {_(messages.reviewed)}
                  </Checkbox>
                  <Button
                    variant="primary"
                    disabled={
                      props.disabled || props.pending || loading() || !state.current || !reviewed() || !!error()
                    }
                    onClick={() => reader && props.accept(reader.consent())}
                  >
                    {_(messages.accept)}
                  </Button>
                </>
              }
            >
              <p role="status">{_(messages.accepted)}</p>
            </Show>
            <Show when={props.view.phase === "preparing"}>
              <Button variant="ghost" disabled={props.disabled || props.pending || loading()} onClick={props.preview}>
                {_(messages.refresh)}
              </Button>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
