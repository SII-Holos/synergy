import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { OrganizationPublicationProtocol as Publication } from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSpace } from "@/context/space"
import { PublicationIdentity, publicationScopeKey, type PublicationRecord } from "./publication-record"
import { createOrganizationPublicationStore, observePublicationMetadata } from "./publication-store"
import { inspectPublication, submitPublication } from "./publication-recovery"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"
import { publicationMessages as messages } from "./publication-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

type Props = {
  purpose: "knowledge" | "artifact"
  scope: Publication.Scope
  canPublish?: boolean
  invalidated: (error: unknown) => void
  resolved: () => void
}
export function PendingPublications(props: Props) {
  return (
    <Show keyed when={`${props.purpose}:${publicationScopeKey(props.scope)}`}>
      {(_source) => <PendingSource {...props} />}
    </Show>
  )
}
function PendingSource(props: Props) {
  const { _ } = useLingui()
  const space = useSpace()
  const view = space.current()!
  const api = space.client()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  const store = createOrganizationPublicationStore({ identity: PublicationIdentity.parse(view.identity), signal })
  const [items, setItems] = createSignal<PublicationRecord[]>([])
  const [cursor, setCursor] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [missing, setMissing] = createSignal<string>()
  let revision = 0
  async function load(after?: string) {
    const version = ++revision
    try {
      const page = await store.page({ purpose: props.purpose, scope: props.scope, cursor: after })
      if (signal.aborted || version !== revision) return
      setItems(page.items)
      setCursor(page.cursor)
    } catch (error) {
      if (!signal.aborted && version === revision) setError(error)
    }
  }
  const unobserve = observePublicationMetadata(PublicationIdentity.parse(view.identity), () => {
    void load()
  })
  onCleanup(() => {
    controller.abort()
    store.dispose()
    unobserve()
  })
  onMount(() => {
    void load()
  })
  async function check(record: PublicationRecord, retry = false) {
    if (signal.aborted || busy() || (retry && !props.canPublish)) return
    setBusy(true)
    setError(undefined)
    setMissing(undefined)
    try {
      if (retry) {
        await submitPublication(api, store, record, signal)
        if (!signal.aborted) props.resolved()
      } else {
        const result = await inspectPublication(api, store, record, signal)
        if (signal.aborted) return
        if (result.state === "published") props.resolved()
        else setMissing(record.request.requestID)
      }
    } catch (error) {
      if (!signal.aborted) {
        if (organizationOwnerFailure(error)) props.invalidated(error)
        else setError(error)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  return (
    <>
      <WorkspaceError
        error={error()}
        retry={() => {
          setError(undefined)
          void load()
        }}
      />
      <Show when={items().length}>
        <section class="organization-editor" aria-label={_(messages.pending)}>
          <h3>{_(messages.pending)}</h3>
          <p>{_(messages.pendingHint)}</p>
          <ul class="organization-file-list">
            <For each={items()}>
              {(record) => (
                <li>
                  <div>
                    <strong>{record.request.title}</strong>
                    <Show when={missing() === record.request.requestID}>
                      <p role="status">{_(messages.receiptMissing)}</p>
                    </Show>
                  </div>
                  <Button
                    disabled={busy()}
                    onClick={() => {
                      void check(record)
                    }}
                  >
                    {_(messages.checkReceipt)}
                  </Button>
                  <Show when={missing() === record.request.requestID && props.canPublish}>
                    <Button
                      disabled={busy()}
                      onClick={() => {
                        void check(record, true)
                      }}
                    >
                      {_(messages.retryOriginal)}
                    </Button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <div class="organization-actions">
            <Button
              disabled={busy()}
              onClick={() => {
                setMissing(undefined)
                void load()
              }}
            >
              {_(messages.refreshPending)}
            </Button>
            <Show when={cursor()}>
              <Button
                disabled={busy()}
                onClick={() => {
                  setMissing(undefined)
                  void load(cursor())
                }}
              >
                {_(common.more)}
              </Button>
            </Show>
          </div>
        </section>
      </Show>
    </>
  )
}
