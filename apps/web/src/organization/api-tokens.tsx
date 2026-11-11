import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { OrganizationApiTokenProtocol as Token } from "@ericsanchezok/synergy-organization-protocol"
import type { OrgProjectView } from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Checkbox } from "@ericsanchezok/synergy-ui/checkbox"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { createOrganizationApiTokenIssuance } from "./api-token-state"
import { WorkspaceError } from "./workspace-error"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./api-tokens.css"

const messages = {
  title: { id: "organization.apiTokens.title", message: "API tokens" },
  hint: {
    id: "organization.apiTokens.hint",
    message: "Connect an integration to one project. Each request is checked against your current access.",
  },
  empty: { id: "organization.apiTokens.empty", message: "No API tokens yet." },
  create: { id: "organization.apiTokens.create", message: "Create token" },
  label: { id: "organization.apiTokens.label", message: "Token name" },
  project: { id: "organization.apiTokens.project", message: "Project" },
  chooseProject: { id: "organization.apiTokens.chooseProject", message: "Choose a project" },
  expiry: { id: "organization.apiTokens.expiry", message: "Expires after" },
  days: { id: "organization.apiTokens.days", message: "{count, plural, one {# day} other {# days}}" },
  operations: { id: "organization.apiTokens.operations", message: "Allowed actions" },
  secret: { id: "organization.apiTokens.secret", message: "API token" },
  once: { id: "organization.apiTokens.once", message: "Copy this token now. It is shown only once." },
  dismiss: { id: "organization.apiTokens.dismiss", message: "Hide token" },
  unknown: {
    id: "organization.apiTokens.unknown",
    message: "Token issuance is unconfirmed. Recover the original request before creating another token.",
  },
  recover: { id: "organization.apiTokens.recover", message: "Recover token issuance" },
  lost: {
    id: "organization.apiTokens.lost",
    message: "This token was issued, but its original value is unavailable. Revoke it before creating a replacement.",
  },
  revoke: { id: "organization.apiTokens.revoke", message: "Revoke token" },
  revokeHint: {
    id: "organization.apiTokens.revokeHint",
    message: "New requests with this token will be rejected. Work already accepted may finish.",
  },
  active: { id: "organization.apiTokens.active", message: "Active" },
  revoked: { id: "organization.apiTokens.revoked", message: "Revoked" },
  expired: { id: "organization.apiTokens.expired", message: "Expired" },
  expires: { id: "organization.apiTokens.expires", message: "Expires {date}" },
  unavailableProject: { id: "organization.apiTokens.unavailableProject", message: "Unavailable project" },
  required: {
    id: "organization.apiTokens.required",
    message: "Enter a name, choose a project and select at least one action.",
  },
  refresh: { id: "organization.apiTokens.refresh", message: "Refresh tokens" },
  moreProjects: { id: "organization.apiTokens.moreProjects", message: "Load more projects" },
  read: { id: "organization.apiTokens.action.read", message: "Read conversations" },
  newSession: { id: "organization.apiTokens.action.create", message: "Create conversations" },
  input: { id: "organization.apiTokens.action.input", message: "Send messages" },
  pause: { id: "organization.apiTokens.action.pause", message: "Pause work" },
  continue: { id: "organization.apiTokens.action.continue", message: "Continue work" },
  cancel: { id: "organization.apiTokens.action.cancel", message: "Cancel work" },
  reply: { id: "organization.apiTokens.action.reply", message: "Answer questions and permissions" },
  configure: { id: "organization.apiTokens.action.configure", message: "Choose conversation resources" },
  resources: { id: "organization.apiTokens.action.resources", message: "Read project resources" },
  artifacts: { id: "organization.apiTokens.action.artifacts", message: "Read published artifacts" },
}
const operationMessages = {
  "sessions.read": messages.read,
  "sessions.create": messages.newSession,
  "sessions.input": messages.input,
  "sessions.pause": messages.pause,
  "sessions.continue": messages.continue,
  "sessions.cancel": messages.cancel,
  "sessions.reply": messages.reply,
  "sessions.configure": messages.configure,
  "resources.read": messages.resources,
  "artifacts.read": messages.artifacts,
}

export function OrganizationApiTokens() {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const owner = space.current()!
  const connection = space.connection()!
  const api = space.client()!
  const confirm = useConfirm()
  const projectField = createUniqueId()
  const expiryField = createUniqueId()
  const controller = new AbortController()
  const signal = AbortSignal.any([owner.signal, controller.signal])
  onCleanup(() => controller.abort())
  const options = { throwOnError: true, signal } as const
  const issuance = createOrganizationApiTokenIssuance(
    localStorage,
    owner.key,
    connection.orgID,
    connection.account.accountID,
  )
  const [state, setState] = createStore({ tokens: [] as Token.Metadata[], projects: [] as OrgProjectView[] })
  const [pending, setPending] = createSignal<ReturnType<typeof issuance.pending>>()
  const [label, setLabel] = createSignal("")
  const [project, setProject] = createSignal("")
  const [days, setDays] = createSignal("7")
  const [operations, setOperations] = createSignal<Token.Operation[]>(["sessions.read"])
  const [created, setCreated] = createSignal<ReturnType<typeof Token.Created.parse>>()
  const releaseSecret = () => setCreated(undefined)
  signal.addEventListener("abort", releaseSecret, { once: true })
  if (signal.aborted) releaseSecret()
  onCleanup(() => {
    signal.removeEventListener("abort", releaseSecret)
    releaseSecret()
  })
  const [cursor, setCursor] = createSignal<string>()
  const [projectCursor, setProjectCursor] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loadingProjects, setLoadingProjects] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [blocked, setBlocked] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [projectError, setProjectError] = createSignal<unknown>()
  const [invalid, setInvalid] = createSignal(false)
  try {
    const current = issuance.pending()
    setPending(current)
    if (current) {
      setLabel(current.request.label)
      setProject(current.request.projectID)
      setOperations(current.request.operations)
    }
  } catch (error) {
    setError(error)
    setBlocked(true)
  }
  async function load(more = false) {
    if (loading()) return
    setLoading(true)
    try {
      const result = await api.orgApiTokens.list({ limit: 50, cursor: more ? cursor() : undefined }, options)
      signal.throwIfAborted()
      const rows = Token.Page.parse(result.data)
      if (
        rows.items.some((token) => token.orgID !== connection.orgID || token.accountID !== connection.account.accountID)
      )
        throw { code: "PERMISSION_DENIED" }
      setState("tokens", reconcile(more ? [...state.tokens, ...rows.items] : rows.items, { key: "tokenID" }))
      setCursor(rows.cursor)
      setError(undefined)
    } catch (error) {
      if (!signal.aborted) setError(error)
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }
  async function loadProjects(more = false) {
    if (loadingProjects()) return
    setLoadingProjects(true)
    try {
      const result = await api.orgProjects.list({ limit: 50, cursor: more ? projectCursor() : undefined }, options)
      signal.throwIfAborted()
      setState(
        "projects",
        reconcile(more ? [...state.projects, ...result.data.items] : result.data.items, { key: "projectID" }),
      )
      setProjectCursor(result.data.cursor)
      setProjectError(undefined)
    } catch (error) {
      if (!signal.aborted) setProjectError(error)
    } finally {
      if (!signal.aborted) setLoadingProjects(false)
    }
  }
  async function create(recover = false) {
    if (busy() || blocked()) return
    if (!recover && (!label().trim() || !project() || !operations().length)) {
      setInvalid(true)
      return
    }
    setBusy(true)
    setInvalid(false)
    setError(undefined)
    try {
      const request = recover
        ? issuance.pending()?.request
        : issuance.begin({
            requestID: generateSecureUUID(),
            projectID: project(),
            label: label().trim(),
            operations: operations(),
            expiresAt: Date.now() + Number(days()) * 86400000,
          })
      if (!request) throw new Error("Token issuance is unavailable")
      setPending(issuance.pending())
      const result = await api.orgApiTokens.create({ orgApiTokenCreate: request }, options)
      signal.throwIfAborted()
      const value = issuance.accept(result.data)
      setCreated(value)
      setPending(issuance.pending())
      const index = state.tokens.findIndex((token) => token.tokenID === value.metadata.tokenID)
      if (index < 0) setState("tokens", [value.metadata, ...state.tokens])
      else setState("tokens", index, reconcile(value.metadata))
    } catch (error) {
      if (!signal.aborted) {
        try {
          setPending(issuance.pending())
        } catch {
          setBlocked(true)
        }
        setError(error)
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  function revoke(token: Token.Metadata) {
    confirm.show({
      title: messages.revoke,
      description: messages.revokeHint,
      confirmLabel: messages.revoke,
      tone: "warning",
      async onConfirm() {
        if (busy()) return
        setBusy(true)
        setError(undefined)
        try {
          const result = await api.orgApiTokens.revoke(
            { tokenID: token.tokenID, orgApiTokenRevoke: { expectedRevision: token.revision } },
            options,
          )
          signal.throwIfAborted()
          const value = Token.Metadata.parse(result.data)
          if (
            value.tokenID !== token.tokenID ||
            value.accountID !== connection.account.accountID ||
            value.orgID !== connection.orgID ||
            value.revokedAt === undefined
          )
            throw new Error("Token revocation could not be confirmed")
          setState("tokens", (item) => item.tokenID === value.tokenID, reconcile(value))
          if (pending()?.issued?.tokenID === value.tokenID) {
            issuance.revoked(value)
            setPending(issuance.pending())
          }
          if (created()?.metadata.tokenID === value.tokenID) setCreated(undefined)
        } catch (error) {
          if (!signal.aborted) setError(error)
        } finally {
          if (!signal.aborted) setBusy(false)
        }
      },
    })
  }
  onMount(() => {
    void load()
    void loadProjects()
  })
  const expiry = (token: Token.Metadata) =>
    _({
      ...messages.expires,
      values: {
        date: new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(
          token.expiresAt,
        ),
      },
    })
  const name = (token: Token.Metadata) =>
    state.projects.find((project) => project.projectID === token.projectID)?.name ?? _(messages.unavailableProject)
  return (
    <section class="organization-api-tokens">
      <p>{_(messages.hint)}</p>
      <WorkspaceError error={error()} retry={() => void load()} />
      <Show when={created()?.token}>
        {(secret) => (
          <div class="organization-editor organization-api-token-secret">
            <p>{_(messages.once)}</p>
            <TextField
              label={_(messages.secret)}
              type="password"
              value={secret()}
              readOnly
              copyable
              autocomplete="off"
            />
            <Button variant="ghost" onClick={() => setCreated(undefined)}>
              {_(messages.dismiss)}
            </Button>
          </div>
        )}
      </Show>
      <Show when={pending()}>
        {(value) => (
          <div class="organization-editor" role="status">
            <p>{_(value().issued ? messages.lost : messages.unknown)}</p>
            <Show
              when={value().issued}
              fallback={
                <Button disabled={busy()} onClick={() => void create(true)}>
                  {_(messages.recover)}
                </Button>
              }
            >
              {(token) => (
                <Button disabled={busy()} onClick={() => revoke(token())}>
                  {_(messages.revoke)}
                </Button>
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={!pending() && !created()?.token}>
        <form
          class="organization-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <TextField
            label={_(messages.label)}
            value={label()}
            onChange={setLabel}
            required
            disabled={busy()}
            error={invalid() && !label().trim() ? _(messages.required) : undefined}
          />
          <WorkspaceError error={projectError()} retry={() => void loadProjects()} />
          <div class="organization-api-token-field">
            <label for={projectField}>{_(messages.project)}</label>
            <MenuField
              id={projectField}
              ariaLabel={_(messages.project)}
              value={project()}
              options={state.projects
                .filter((project) => project.state === "active")
                .map((project) => ({ value: project.projectID, label: project.name }))}
              triggerLabel={!project() ? _(messages.chooseProject) : undefined}
              onChange={setProject}
              disabled={busy()}
            />
          </div>
          <Show when={projectCursor()}>
            <Button type="button" variant="ghost" disabled={loadingProjects()} onClick={() => void loadProjects(true)}>
              {_(messages.moreProjects)}
            </Button>
          </Show>
          <div class="organization-api-token-field">
            <label for={expiryField}>{_(messages.expiry)}</label>
            <MenuField
              id={expiryField}
              ariaLabel={_(messages.expiry)}
              value={days()}
              options={["1", "7", "30"].map((value) => ({
                value,
                label: _({ ...messages.days, values: { count: Number(value) } }),
              }))}
              onChange={setDays}
              disabled={busy()}
            />
          </div>
          <fieldset disabled={busy()} class="organization-api-token-actions">
            <legend>{_(messages.operations)}</legend>
            <For each={Token.Operation.options}>
              {(operation) => (
                <Checkbox
                  checked={operations().includes(operation)}
                  onChange={(checked) =>
                    setOperations((previous) =>
                      checked ? [...previous, operation] : previous.filter((item) => item !== operation),
                    )
                  }
                >
                  {_(operationMessages[operation])}
                </Checkbox>
              )}
            </For>
          </fieldset>
          <Show when={invalid()}>
            <p role="alert">{_(messages.required)}</p>
          </Show>
          <Button type="submit" variant="primary" disabled={busy() || blocked()}>
            {_(messages.create)}
          </Button>
        </form>
      </Show>
      <div class="organization-form-actions">
        <Button variant="ghost" disabled={loading()} onClick={() => void load()}>
          {_(messages.refresh)}
        </Button>
      </div>
      <Show when={!loading() && !state.tokens.length}>
        <p>{_(messages.empty)}</p>
      </Show>
      <ul class="organization-api-token-list">
        <For each={state.tokens}>
          {(token) => (
            <li>
              <div>
                <strong>{token.label}</strong>
                <span>{name(token)}</span>
                <span>{expiry(token)}</span>
                <span>
                  {_(
                    token.revokedAt !== undefined
                      ? messages.revoked
                      : token.expiresAt <= Date.now()
                        ? messages.expired
                        : messages.active,
                  )}
                </span>
                <details>
                  <summary>{_(messages.operations)}</summary>
                  <ul>
                    <For each={token.operations}>{(operation) => <li>{_(operationMessages[operation])}</li>}</For>
                  </ul>
                </details>
              </div>
              <Show when={token.revokedAt === undefined && pending()?.issued?.tokenID !== token.tokenID}>
                <Button variant="ghost" disabled={busy()} onClick={() => revoke(token)}>
                  {_(messages.revoke)}
                </Button>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={cursor()}>
        <Button disabled={loading()} onClick={() => void load(true)}>
          {_(common.more)}
        </Button>
      </Show>
    </section>
  )
}
export const organizationApiTokenMessages = messages
