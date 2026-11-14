import { batch, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import type { OrgProjectMemberPage, OrgProjectCandidatePage } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { organizationOwnerFailure } from "./owner-error"
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

export function OrganizationProjectMembers(props: {
  projectID: string
  changed: () => void
  invalidated: (error: unknown) => void
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const projectID = props.projectID
  const confirm = useConfirm()
  const controller = new AbortController()
  const signal = AbortSignal.any([view.signal, controller.signal])
  let searchController: AbortController | undefined
  let generation = 0
  let searchGeneration = 0
  const options = { throwOnError: true, signal } as const
  onCleanup(() => {
    controller.abort()
    searchController?.abort()
  })
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
  const [blocked, setBlocked] = createSignal(false)
  const matches = () => props.projectID === projectID && space.current() === view
  const current = (version = generation) => !signal.aborted && matches() && version === generation
  function closeDiscovery() {
    searchGeneration++
    searchController?.abort()
    searchController = undefined
    setAdding(false)
    setSearching(false)
    setState("candidates", reconcile([]))
    setCandidateCursor(undefined)
  }
  function retire() {
    generation++
    confirm.closeOwned()
    closeDiscovery()
    setBlocked(true)
    setState("members", reconcile([]))
    setRevision(undefined)
    setCursor(undefined)
    setBusy(false)
    setLoading(false)
    setQ("")
    setQuery("")
  }
  function failed(error: unknown) {
    const failure = organizationOwnerFailure(error)
    batch(() => {
      if (failure) retire()
      setError(error)
    })
    if (failure) props.invalidated(error)
  }
  createEffect(() => {
    if (!matches() && !signal.aborted) {
      retire()
      controller.abort()
    }
  })
  const roles = () =>
    (["reader", "collaborator", "maintainer"] as const).map((value) => ({ value, label: _(common[value]) }))
  async function load(more = false) {
    if (loading() || !current()) return
    const version = generation
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.orgProjects.members(
        { projectID, limit: 50, cursor: more ? cursor() : undefined },
        options,
      )
      if (!current(version)) return
      setBlocked(false)
      setState("members", reconcile(more ? [...state.members, ...result.data.items] : result.data.items))
      setCursor(result.data.cursor)
      setRevision(result.data.projectRevision)
    } catch (error) {
      if (current(version)) failed(error)
    } finally {
      if (current(version)) setLoading(false)
    }
  }
  async function search(more = false) {
    if (searching() || !current() || !adding() || !searchController) return
    const version = generation
    const searchVersion = searchGeneration
    const selectedQuery = query().trim()
    const requestSignal = AbortSignal.any([signal, searchController.signal])
    const searchingCurrent = () => current(version) && searchVersion === searchGeneration && !requestSignal.aborted
    setSearching(true)
    setError(undefined)
    try {
      const result = await api.orgProjects.candidates(
        {
          projectID,
          q: selectedQuery || undefined,
          cursor: more ? candidateCursor() : undefined,
          limit: 20,
        },
        { throwOnError: true, signal: requestSignal },
      )
      if (!searchingCurrent()) return
      setState("candidates", reconcile(more ? [...state.candidates, ...result.data.items] : result.data.items))
      setCandidateCursor(result.data.cursor)
    } catch (error) {
      if (searchingCurrent()) failed(error)
    } finally {
      if (searchingCurrent()) setSearching(false)
    }
  }
  function discover(value = q()) {
    closeDiscovery()
    if (!current() || blocked()) return
    searchController = new AbortController()
    setAdding(true)
    setQuery(value)
    void search()
  }
  async function change(accountID: string, role: Role | null, target = { version: generation, revision: revision() }) {
    const expectedRevision = target.revision
    if (busy() || blocked() || expectedRevision === undefined || !current(target.version)) return
    setBusy(true)
    setError(undefined)
    try {
      await api.orgProjects.member(
        { projectID, accountID, orgProjectMemberChange: { expectedRevision, role } },
        options,
      )
      if (!current(target.version)) return
      await load()
      if (current(target.version)) props.changed()
    } catch (error) {
      if (current(target.version)) failed(error)
    } finally {
      if (current(target.version)) setBusy(false)
    }
  }
  function remove(accountID: string) {
    const target = { version: generation, revision: revision() }
    confirm.show({
      title: messages.remove,
      description: messages.removeHint,
      confirmLabel: messages.remove,
      tone: "warning",
      onConfirm: () => change(accountID, null, target),
    })
  }
  onMount(() => void load())
  return (
    <section class="organization-members-view">
      <div class="organization-page-heading">
        <h2>{_(common.members)}</h2>
        <Button
          size="large"
          variant="primary"
          onClick={() => (adding() ? closeDiscovery() : discover())}
          disabled={blocked()}
        >
          {_(messages.add)}
        </Button>
      </div>
      <p>{_(messages.inherited)}</p>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={!blocked()}>
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
                <Button variant="ghost" disabled={busy()} onClick={() => remove(member.accountID)}>
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
                discover(q())
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
      </Show>
    </section>
  )
}
