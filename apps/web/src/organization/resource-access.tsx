import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
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
  const options = { throwOnError: true, signal } as const
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
  const current = () => !signal.aborted
  function failed(error: unknown) {
    if (organizationOwnerFailure(error)) props.invalidated(error)
    else setError(error)
  }
  async function load(selected = kind(), more = false) {
    setLoading(true)
    setError(undefined)
    try {
      const [grants, subjects] = await Promise.all([
        api.orgResourceGrants.list(
          { resourceID: props.resource.resourceID, kind: selected, limit: 50, cursor: more ? cursor() : undefined },
          options,
        ),
        selected === "account"
          ? api.orgAccounts.list({ limit: 50, cursor: more ? subjectCursor() : undefined }, options)
          : api.orgProjects.list({ limit: 50, cursor: more ? subjectCursor() : undefined }, options),
      ])
      if (!current() || selected !== kind()) return
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
      if (current() && selected === kind()) failed(error)
    } finally {
      if (current() && selected === kind()) setLoading(false)
    }
  }
  async function save(subjectID: string, grant: OrgResourceGrant | undefined) {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgResourceGrants.set(
        {
          resourceID: props.resource.resourceID,
          kind: kind(),
          subjectID,
          orgResourceGrantChange: { expectedRevision: grant?.revision ?? 0, enabled: !grant?.enabled },
        },
        options,
      )
      if (current())
        setState("grants", reconcile([...state.grants.filter((entry) => entry.subject.id !== subjectID), result.data]))
    } catch (error) {
      if (current()) failed(error)
    } finally {
      if (current()) setBusy(false)
    }
  }
  function toggle(subjectID: string, grant?: OrgResourceGrant) {
    if (!grant?.enabled) {
      void save(subjectID, grant)
      return
    }
    confirm.show({
      title: messages.revoke,
      description: messages.revokeHint,
      confirmLabel: messages.revoke,
      tone: "warning",
      onConfirm: () => save(subjectID, grant),
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
        onChange={(value) => {
          setKind(value)
          void load(value)
        }}
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
