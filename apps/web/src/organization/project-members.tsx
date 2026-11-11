import { createSignal, For, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrgProjectMemberPage, OrgProjectCandidatePage } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { organizationWorkspaceMessages as common } from "./workspace-messages"

const messages = {
  add: { id: "organization.projectMembers.add", message: "Add project member" },
  search: { id: "organization.projectMembers.search", message: "Find organization members" },
  remove: { id: "organization.projectMembers.remove", message: "Remove from project" },
  removeHint: {
    id: "organization.projectMembers.removeHint",
    message: "Remove this member's project role. Existing organization and account permissions still apply.",
  },
  empty: { id: "organization.projectMembers.empty", message: "No project roles assigned" },
  inherited: {
    id: "organization.projectMembers.inherited",
    message: "Organization owners and administrators also have access through their organization role.",
  },
}
type Role = OrgProjectMemberPage["items"][number]["role"]

export function OrganizationProjectMembers(props: { projectID: string; changed: () => void }) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const confirm = useConfirm()
  const options = { throwOnError: true, signal: view.signal } as const
  const [state, setState] = createStore({
    members: [] as OrgProjectMemberPage["items"],
    candidates: [] as OrgProjectCandidatePage["items"],
  })
  const [revision, setRevision] = createSignal<number>()
  const [cursor, setCursor] = createSignal<string>()
  const [candidateCursor, setCandidateCursor] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [searching, setSearching] = createSignal(false)
  const [adding, setAdding] = createSignal(false)
  const [q, setQ] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [role, setRole] = createSignal<Role>("reader")
  const [error, setError] = createSignal<unknown>()
  const roles = () =>
    (["reader", "collaborator", "maintainer"] as const).map((value) => ({ value, label: _(common[value]) }))
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgProjects.members(
        { projectID: props.projectID, limit: 50, cursor: more ? cursor() : undefined },
        options,
      )
      if (view.signal.aborted) return
      setState("members", reconcile(more ? [...state.members, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setRevision(result.data.projectRevision)
    } catch (error) {
      if (!view.signal.aborted) setError(error)
    } finally {
      if (!view.signal.aborted) setLoading(false)
    }
  }
  async function search(more = false) {
    if (searching()) return
    setSearching(true)
    setError(undefined)
    try {
      const result = await api.orgProjects.candidates(
        {
          projectID: props.projectID,
          q: query().trim() || undefined,
          cursor: more ? candidateCursor() : undefined,
          limit: 20,
        },
        options,
      )
      if (view.signal.aborted) return
      setState("candidates", reconcile(more ? [...state.candidates, ...result.data.items] : result.data.items))
      setCandidateCursor(result.data.cursor)
    } catch (error) {
      if (!view.signal.aborted) setError(error)
    } finally {
      if (!view.signal.aborted) setSearching(false)
    }
  }
  async function change(accountID: string, role: Role | null) {
    const expectedRevision = revision()
    if (busy() || expectedRevision === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await api.orgProjects.member(
        { projectID: props.projectID, accountID, orgProjectMemberChange: { expectedRevision, role } },
        options,
      )
      if (view.signal.aborted) return
      await load()
      props.changed()
    } catch (error) {
      if (!view.signal.aborted) setError(error)
    } finally {
      if (!view.signal.aborted) setBusy(false)
    }
  }
  onMount(() => void load())
  return (
    <section class="organization-members-view">
      <div class="organization-page-heading">
        <h2>{_(common.members)}</h2>
        <Button
          size="large"
          variant="primary"
          onClick={() => {
            setAdding(!adding())
            if (!adding()) return
            setQuery("")
            void search()
          }}
        >
          {_(messages.add)}
        </Button>
      </div>
      <p>{_(messages.inherited)}</p>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={!loading() && !state.members.length}>
        <p>{_(messages.empty)}</p>
      </Show>
      <ul class="organization-member-list">
        <For each={state.members}>
          {(member) => (
            <li>
              <div class="organization-member-identity">
                <strong>{member.displayName}</strong>
                <span>{member.loginName}</span>
              </div>
              <MenuField
                ariaLabel={`${_(common.role)}: ${member.displayName}`}
                value={member.role}
                onChange={(role) => void change(member.accountID, role)}
                disabled={busy()}
                options={roles()}
                closeOnChange={false}
              />
              <Button
                variant="ghost"
                disabled={busy()}
                onClick={() =>
                  confirm.show({
                    title: messages.remove,
                    description: messages.removeHint,
                    confirmLabel: messages.remove,
                    tone: "warning",
                    onConfirm: () => change(member.accountID, null),
                  })
                }
              >
                {_(messages.remove)}
              </Button>
            </li>
          )}
        </For>
      </ul>
      <Show when={cursor()}>
        <Button disabled={loading()} onClick={() => void load(true)}>
          {_(common.more)}
        </Button>
      </Show>
      <Show when={adding()}>
        <section class="organization-publication-detail">
          <form
            class="organization-search"
            onSubmit={(event) => {
              event.preventDefault()
              setQuery(q())
              void search()
            }}
          >
            <TextField label={_(messages.search)} value={q()} onChange={setQ} maxLength={128} />
            <Button type="submit" disabled={searching()}>
              {_(messages.search)}
            </Button>
          </form>
          <MenuField ariaLabel={_(common.role)} value={role()} onChange={setRole} options={roles()} />
          <ul class="organization-member-list">
            <For
              each={state.candidates.filter(
                (candidate) =>
                  candidate.state === "active" &&
                  !state.members.some((member) => member.accountID === candidate.accountID),
              )}
            >
              {(candidate) => (
                <li>
                  <div class="organization-member-identity">
                    <strong>{candidate.displayName}</strong>
                    <span>{candidate.loginName}</span>
                  </div>
                  <Button disabled={busy() || loading()} onClick={() => void change(candidate.accountID, role())}>
                    {_(messages.add)}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={candidateCursor()}>
            <Button disabled={searching()} onClick={() => void search(true)}>
              {_(common.more)}
            </Button>
          </Show>
        </section>
      </Show>
    </section>
  )
}
