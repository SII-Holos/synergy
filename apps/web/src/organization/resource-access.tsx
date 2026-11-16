import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import type {
  OrgAccount,
  OrgProjectView,
  OrgResourceAdminView,
  OrgResourceGrant,
} from "@ericsanchezok/synergy-sdk/organization"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { organizationOwnerFailure } from "./owner-error"
import { WorkspaceError } from "./workspace-error"
import { organizationResourceMessages as messages } from "./resource-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

export function ResourceAccess(props: { resource: OrgResourceAdminView; invalidated: (error: unknown) => void }) {
  const space = useSpace()
  const { _ } = useLingui()
  const confirm = useConfirm()
  const api = space.client()!
  const view = space.current()!
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  onCleanup(() => controller.abort())
  const resourceID = props.resource.resourceID
  let contextController = new AbortController()
  let generation = 0
  onCleanup(() => contextController.abort())
  const [kind, setKind] = createSignal<"account" | "project">("account")
  const [state, setState] = createStore({
    accounts: [] as OrgAccount[],
    projects: [] as OrgProjectView[],
    grants: [] as OrgResourceGrant[],
  })
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [cursor, setCursor] = createSignal<string>()
  const [subjectCursor, setSubjectCursor] = createSignal<string>()
  const matches = () => space.current() === view && props.resource.resourceID === resourceID
  const current = (version = generation) => !signal.aborted && matches() && version === generation
  function clear() {
    confirm.closeOwned()
    setState(reconcile({ accounts: [], projects: [], grants: [] }))
    setCursor(undefined)
    setSubjectCursor(undefined)
    setBusy(false)
    setLoading(false)
    setError(undefined)
  }
  createEffect(() => {
    if (!matches() && !signal.aborted) {
      generation++
      contextController.abort()
      controller.abort()
      clear()
    }
  })
  function select(value: "account" | "project") {
    if (value === kind() || !current()) return
    batch(() => {
      generation++
      contextController.abort()
      contextController = new AbortController()
      clear()
      setKind(value)
    })
    void load(value)
  }
  function failed(error: unknown) {
    if (organizationOwnerFailure(error)) props.invalidated(error)
    else setError(error)
  }
  async function load(selected = kind(), more = false) {
    if (!current() || loading()) return
    const version = generation
    const requestSignal = AbortSignal.any([signal, contextController.signal])
    setLoading(true)
    setError(undefined)
    try {
      const [grants, subjects] = await Promise.all([
        api.orgResourceGrants.list(
          { resourceID, kind: selected, limit: 50, cursor: more ? cursor() : undefined },
          { throwOnError: true, signal: requestSignal },
        ),
        selected === "account"
          ? api.orgAccounts.list(
              { limit: 50, cursor: more ? subjectCursor() : undefined },
              { throwOnError: true, signal: requestSignal },
            )
          : api.orgProjects.list(
              { limit: 50, cursor: more ? subjectCursor() : undefined },
              { throwOnError: true, signal: requestSignal },
            ),
      ])
      if (!current(version) || selected !== kind()) return
      setState(
        "grants",
        reconcile([
          ...new Map(
            (more ? [...state.grants, ...grants.data.items] : grants.data.items).map((entry) => [
              `${entry.subject.kind}:${entry.subject.id}`,
              entry,
            ]),
          ).values(),
        ]),
      )
      setCursor(grants.data.cursor)
      setSubjectCursor(subjects.data.cursor)
      if (selected === "account")
        setState(
          "accounts",
          reconcile([
            ...new Map(
              ((more ? [...state.accounts, ...subjects.data.items] : subjects.data.items) as OrgAccount[]).map(
                (entry) => [entry.accountID, entry],
              ),
            ).values(),
          ]),
        )
      else
        setState(
          "projects",
          reconcile([
            ...new Map(
              ((more ? [...state.projects, ...subjects.data.items] : subjects.data.items) as OrgProjectView[]).map(
                (entry) => [entry.projectID, entry],
              ),
            ).values(),
          ]),
        )
    } catch (error) {
      if (current(version) && selected === kind()) failed(error)
    } finally {
      if (current(version) && selected === kind()) setLoading(false)
    }
  }
  async function save(target: {
    version: number
    kind: "account" | "project"
    subjectID: string
    revision: number
    enabled: boolean
  }) {
    if (busy() || !current(target.version) || kind() !== target.kind) return
    const requestSignal = AbortSignal.any([signal, contextController.signal])
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgResourceGrants.set(
        {
          resourceID,
          kind: target.kind,
          subjectID: target.subjectID,
          orgResourceGrantChange: { expectedRevision: target.revision, enabled: target.enabled },
        },
        { throwOnError: true, signal: requestSignal },
      )
      if (current(target.version))
        setState(
          "grants",
          reconcile([
            ...state.grants.filter(
              (entry) => entry.subject.id !== target.subjectID || entry.subject.kind !== target.kind,
            ),
            result.data,
          ]),
        )
    } catch (error) {
      if (current(target.version)) failed(error)
    } finally {
      if (current(target.version)) setBusy(false)
    }
  }
  function toggle(subjectID: string, grant?: OrgResourceGrant) {
    const target = {
      version: generation,
      kind: kind(),
      subjectID,
      revision: grant?.revision ?? 0,
      enabled: !grant?.enabled,
    }
    if (target.enabled) {
      void save(target)
      return
    }
    confirm.show({
      title: messages.revoke,
      description: messages.revokeHint,
      confirmLabel: messages.revoke,
      tone: "warning",
      onConfirm: () => save(target),
    })
  }
  onMount(() => void load())
  const subjects = () =>
    kind() === "account"
      ? state.accounts
          .filter((entry) => entry.state === "active")
          .map((entry) => ({ id: entry.accountID, name: entry.displayName }))
      : state.projects.map((entry) => ({ id: entry.projectID, name: entry.name }))
  return (
    <section class="organization-access-view">
      <MenuField
        ariaLabel={_(messages.access)}
        value={kind()}
        onChange={select}
        options={[
          { value: "account", label: _(messages.accounts) },
          { value: "project", label: _(messages.projects) },
        ]}
      />
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <ul class="organization-access-list">
        <For each={subjects()}>
          {(subject) => {
            const grant = () =>
              state.grants.find((entry) => entry.subject.id === subject.id && entry.subject.kind === kind())
            return (
              <li>
                <span>{subject.name}</span>
                <span>{_(grant()?.enabled ? messages.allowed : messages.revoked)}</span>
                <Button disabled={busy()} onClick={() => toggle(subject.id, grant())}>
                  {_(grant()?.enabled ? messages.revoke : messages.allow)}
                </Button>
              </li>
            )
          }}
        </For>
      </ul>
      <Show when={cursor() || subjectCursor()}>
        <Button disabled={loading()} onClick={() => void load(kind(), true)}>
          {_(common.more)}
        </Button>
      </Show>
    </section>
  )
}
