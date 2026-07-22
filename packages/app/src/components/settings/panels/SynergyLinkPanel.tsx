import { useLingui } from "@lingui/solid"
import type { SynergyLinkTargetView } from "@ericsanchezok/synergy-sdk/client"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { SettingsEntityList, SettingsPage, SettingsSection } from "../components/SettingsPrimitives"
import {
  createTargetRequestController,
  normalizeAllowedAgents,
  reconcileTargetDraft,
  targetFormReady,
  targetListState,
} from "./synergy-link-panel-model"

const copy = {
  title: { id: "settings.synergyLink.page.title", message: "Synergy Link" },
  description: {
    id: "settings.synergyLink.page.description",
    message: "Persist the Synergy hosts this installation can control and inspect their last observed identity.",
  },
  refresh: { id: "settings.synergyLink.refresh", message: "Refresh" },
  addTitle: { id: "settings.synergyLink.add.title", message: "Add target" },
  addDescription: {
    id: "settings.synergyLink.add.description",
    message: "Copy the target agent ID and Link ID from B. B still approves the first connection.",
  },
  name: { id: "settings.synergyLink.field.name", message: "Name" },
  namePlaceholder: { id: "settings.synergyLink.field.name.placeholder", message: "Build Mac" },
  targetAgentID: { id: "settings.synergyLink.field.targetAgentID", message: "Target agent ID" },
  targetAgentIDPlaceholder: { id: "settings.synergyLink.field.targetAgentID.placeholder", message: "agent_…" },
  linkID: { id: "settings.synergyLink.field.linkID", message: "Link ID" },
  linkIDPlaceholder: { id: "settings.synergyLink.field.linkID.placeholder", message: "link_…" },
  allowedAgents: { id: "settings.synergyLink.field.allowedAgents", message: "Allowed local agents" },
  allowedAgentsDescription: {
    id: "settings.synergyLink.field.allowedAgents.description",
    message: "Comma-separated Synergy agent names. Leave empty to allow every local agent to discover this target.",
  },
  allowedAgentsPlaceholder: {
    id: "settings.synergyLink.field.allowedAgents.placeholder",
    message: "synergy, build",
  },
  add: { id: "settings.synergyLink.add.action", message: "Add target" },
  adding: { id: "settings.synergyLink.add.adding", message: "Adding..." },
  cancel: { id: "settings.synergyLink.add.cancel", message: "Cancel" },
  close: { id: "settings.synergyLink.add.close", message: "Close add target dialog" },
  targetsTitle: { id: "settings.synergyLink.targets.title", message: "Targets" },
  targetsDescription: {
    id: "settings.synergyLink.targets.description",
    message:
      "A target stores routing identifiers, authorization state, and observed host capabilities. It never stores B's Holos credentials.",
  },
  emptyTitle: { id: "settings.synergyLink.empty.title", message: "No Link targets yet" },
  emptyDescription: {
    id: "settings.synergyLink.empty.description",
    message: "Add a target so agents can discover and connect to it by a stable target ID.",
  },
  loadError: { id: "settings.synergyLink.load.error", message: "Link targets could not be loaded." },
  retry: { id: "settings.synergyLink.load.retry", message: "Retry" },
  enabled: { id: "settings.synergyLink.enabled", message: "Enabled" },
  test: { id: "settings.synergyLink.test", message: "Test connection" },
  save: { id: "settings.synergyLink.save", message: "Save" },
  remove: { id: "settings.synergyLink.remove", message: "Remove" },
  hostTitle: { id: "settings.synergyLink.host.title", message: "Observed host" },
  notObserved: { id: "settings.synergyLink.host.notObserved", message: "Not observed yet" },
  stableTargetID: { id: "settings.synergyLink.field.stableTargetID", message: "Stable target ID" },
  removeTitle: { id: "settings.synergyLink.remove.title", message: "Remove Link target?" },
  removeDescription: {
    id: "settings.synergyLink.remove.description",
    message: "Agents will no longer discover this target. This does not change B's trust list.",
  },
  created: { id: "settings.synergyLink.toast.created", message: "Link target added" },
  saved: { id: "settings.synergyLink.toast.saved", message: "Link target saved" },
  tested: { id: "settings.synergyLink.toast.tested", message: "Connection test completed" },
  failed: { id: "settings.synergyLink.toast.failed", message: "Synergy Link action failed" },
  authorizationApproved: { id: "settings.synergyLink.authorization.approved", message: "Approved" },
  authorizationUnverified: { id: "settings.synergyLink.authorization.unverified", message: "Unverified" },
  authorizationRevoked: { id: "settings.synergyLink.authorization.revoked", message: "Revoked" },
  availabilityOffline: { id: "settings.synergyLink.availability.offline", message: "Holos offline" },
  availabilityIdle: { id: "settings.synergyLink.availability.idle", message: "Ready" },
  availabilityConnected: { id: "settings.synergyLink.availability.connected", message: "Connected" },
}

export function SynergyLinkPanel() {
  const { _ } = useLingui()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const confirm = useConfirm()
  const [targets, { refetch }] = createResource(async () => {
    const response = await globalSDK.client.synergyLink.targets({ throwOnError: true })
    return (response.data ?? []) as SynergyLinkTargetView[]
  })
  const listState = () =>
    targetListState({ loading: targets.loading, error: targets.error, count: targets()?.length ?? 0 })
  const unsubscribe = globalSDK.event.listen((event) => {
    if (!event.details?.type.startsWith("synergy_link.target.")) return
    void refetch()
  })
  onCleanup(unsubscribe)

  function openAddTargetDialog() {
    dialog.push(() => <DialogAddSynergyLinkTarget onCreated={refetch} />)
  }

  async function removeTarget(target: SynergyLinkTargetView) {
    try {
      await globalSDK.client.synergyLink.targetRemove({ id: target.id }, { throwOnError: true })
      await refetch()
    } catch (error) {
      showToast({ type: "error", title: _(copy.failed), description: requestErrorMessage(error) })
    }
  }

  function confirmRemove(target: SynergyLinkTargetView) {
    confirm.show({
      title: _(copy.removeTitle),
      description: _(copy.removeDescription),
      confirmLabel: _(copy.remove),
      tone: "danger",
      onConfirm: () => removeTarget(target),
    })
  }

  return (
    <SettingsPage
      title={_(copy.title)}
      description={_(copy.description)}
      actions={
        <div class="settings-link-page-actions">
          <Button
            type="button"
            variant="secondary"
            size="small"
            icon={getSemanticIcon("action.add")}
            onClick={openAddTargetDialog}
          >
            {_(copy.add)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.refresh")}
            onClick={() => void refetch()}
          >
            {_(copy.refresh)}
          </Button>
        </div>
      }
    >
      <div class="settings-integration-shell">
        <SettingsSection title={_(copy.targetsTitle)} description={_(copy.targetsDescription)}>
          <Show when={listState() === "error"}>
            <div class="settings-request-error" role="alert">
              <Icon name={getSemanticIcon("state.error")} size="small" />
              <span>{_(copy.loadError)}</span>
              <Button type="button" variant="secondary" size="small" onClick={() => void refetch()}>
                {_(copy.retry)}
              </Button>
            </div>
          </Show>
          <Show when={listState() !== "error"}>
            <SettingsEntityList
              isEmpty={listState() === "empty"}
              emptyIcon={getSemanticIcon("synergyLink.main")}
              emptyTitle={_(copy.emptyTitle)}
              emptyDescription={_(copy.emptyDescription)}
            >
              <div class="settings-link-list">
                <For each={targets()?.map((target) => target.id)}>
                  {(targetID) => (
                    <Show when={targets()?.find((target) => target.id === targetID)}>
                      {(target) => (
                        <SynergyLinkTargetCard
                          target={target()}
                          onRefresh={refetch}
                          onRemove={() => confirmRemove(target())}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </div>
            </SettingsEntityList>
          </Show>
        </SettingsSection>
      </div>
    </SettingsPage>
  )
}

function DialogAddSynergyLinkTarget(props: { onCreated: () => unknown }) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal("")
  const [targetAgentID, setTargetAgentID] = createSignal("")
  const [linkID, setLinkID] = createSignal("")
  const [allowedAgents, setAllowedAgents] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const isReady = () => targetFormReady({ name: name(), targetAgentID: targetAgentID(), linkID: linkID() })
  const requests = createTargetRequestController()
  onCleanup(() => requests.cancel())

  function closeDialog() {
    requests.cancel()
    dialog.close()
  }

  async function addTarget(event: SubmitEvent) {
    event.preventDefault()
    if (!isReady() || busy()) return
    const controller = requests.start()
    setBusy(true)
    try {
      await globalSDK.client.synergyLink.targetCreate(
        {
          synergyLinkTargetCreateInput: {
            name: name().trim(),
            targetAgentID: targetAgentID().trim(),
            linkID: linkID().trim(),
            allowedAgents: normalizeAllowedAgents(allowedAgents()),
          },
        },
        { throwOnError: true, signal: controller.signal },
      )
      if (controller.signal.aborted) return
      showToast({ type: "success", title: _(copy.created) })
      dialog.close()
      void Promise.resolve().then(() => props.onCreated())
    } catch (error) {
      if (controller.signal.aborted) return
      showToast({ type: "error", title: _(copy.failed), description: requestErrorMessage(error) })
    } finally {
      requests.finish(controller)
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <Dialog
      title={_(copy.addTitle)}
      description={_(copy.addDescription)}
      size="form"
      class="settings-link-add-dialog"
      dismissible
      action={
        <button
          type="button"
          aria-label={_(copy.close)}
          data-slot="dialog-close-button"
          data-component="icon-button"
          data-variant="ghost"
          onClick={closeDialog}
        >
          <Icon name={getSemanticIcon("action.close")} size="small" />
        </button>
      }
    >
      <form data-slot="dialog-form" onSubmit={addTarget}>
        <div class="settings-link-dialog-fields">
          <TextField
            autofocus
            label={_(copy.name)}
            placeholder={_(copy.namePlaceholder)}
            value={name()}
            disabled={busy()}
            onChange={setName}
          />
          <TextField
            label={_(copy.targetAgentID)}
            placeholder={_(copy.targetAgentIDPlaceholder)}
            value={targetAgentID()}
            disabled={busy()}
            onChange={setTargetAgentID}
          />
          <TextField
            label={_(copy.linkID)}
            placeholder={_(copy.linkIDPlaceholder)}
            value={linkID()}
            disabled={busy()}
            onChange={setLinkID}
          />
          <div class="settings-link-dialog-field-wide">
            <TextField
              label={_(copy.allowedAgents)}
              description={_(copy.allowedAgentsDescription)}
              placeholder={_(copy.allowedAgentsPlaceholder)}
              value={allowedAgents()}
              disabled={busy()}
              onChange={setAllowedAgents}
            />
          </div>
        </div>
        <div data-slot="dialog-actions" class="settings-link-dialog-actions">
          <Button type="button" variant="ghost" size="large" onClick={closeDialog}>
            {_(copy.cancel)}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={busy() || !isReady()}>
            {busy() ? _(copy.adding) : _(copy.add)}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SynergyLinkTargetCard(props: {
  target: SynergyLinkTargetView
  onRefresh: () => unknown
  onRemove: () => void
}) {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.target.name)
  const [agents, setAgents] = createSignal(props.target.allowedAgents.join(", "))
  const [busy, setBusy] = createSignal(false)
  let previousTargetID = props.target.id
  let previousName = props.target.name
  let previousAgents = props.target.allowedAgents.join(", ")
  createEffect(() => {
    const nextTargetID = props.target.id
    const nextName = props.target.name
    const nextAgents = props.target.allowedAgents.join(", ")
    const targetChanged = previousTargetID !== nextTargetID
    setName((current) =>
      reconcileTargetDraft({ current, previousServer: previousName, nextServer: nextName, targetChanged }),
    )
    setAgents((current) =>
      reconcileTargetDraft({ current, previousServer: previousAgents, nextServer: nextAgents, targetChanged }),
    )
    previousTargetID = nextTargetID
    previousName = nextName
    previousAgents = nextAgents
  })

  async function update(patch: { name?: string; enabled?: boolean; allowedAgents?: string[] }) {
    setBusy(true)
    try {
      await globalSDK.client.synergyLink.targetUpdate(
        { id: props.target.id, synergyLinkTargetPatchInput: patch },
        { throwOnError: true },
      )
      await Promise.resolve(props.onRefresh())
      return true
    } catch (error) {
      showToast({ type: "error", title: _(copy.failed), description: requestErrorMessage(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (await update({ name: name().trim(), allowedAgents: normalizeAllowedAgents(agents()) })) {
      showToast({ type: "success", title: _(copy.saved) })
    }
  }

  async function probe() {
    setBusy(true)
    try {
      await globalSDK.client.synergyLink.targetProbe({ id: props.target.id }, { throwOnError: true })
      await Promise.resolve(props.onRefresh())
      showToast({ type: "success", title: _(copy.tested) })
    } catch (error) {
      showToast({ type: "error", title: _(copy.failed), description: requestErrorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const hostSummary = () => {
    const capabilities = props.target.host?.capabilities
    if (!capabilities) return _(copy.notObserved)
    return `${capabilities.platform} · ${capabilities.arch} · ${capabilities.runtime} · ${capabilities.defaultShell}`
  }

  return (
    <article class="settings-link-card">
      <div class="settings-link-card-header">
        <div class="settings-integration-row-copy">
          <span class="settings-integration-row-icon">
            <Icon name={getSemanticIcon("synergyLink.main")} size="small" />
          </span>
          <div class="min-w-0">
            <div class="settings-integration-row-title truncate">{props.target.name}</div>
            <div class="settings-integration-row-description">{hostSummary()}</div>
          </div>
        </div>
        <div class="settings-link-badges">
          <span class="ds-inline-badge">{_(authorizationDescriptor(props.target.authorization))}</span>
          <span class="ds-inline-badge ds-inline-badge-muted">
            {_(availabilityDescriptor(props.target.availability))}
          </span>
        </div>
      </div>

      <div class="settings-integration-form-grid settings-integration-form-grid-two">
        <TextField label={_(copy.name)} value={name()} onChange={setName} disabled={busy()} />
        <TextField label={_(copy.allowedAgents)} value={agents()} onChange={setAgents} disabled={busy()} />
        <TextField label={_(copy.stableTargetID)} value={props.target.id} readOnly copyable />
        <TextField label={_(copy.targetAgentID)} value={props.target.targetAgentID} readOnly copyable />
        <TextField label={_(copy.linkID)} value={props.target.linkID} readOnly copyable />
        <TextField label={_(copy.hostTitle)} value={hostSummary()} readOnly copyable={Boolean(props.target.host)} />
      </div>

      <div class="settings-link-card-footer">
        <Switch checked={props.target.enabled} disabled={busy()} onChange={(enabled) => void update({ enabled })}>
          {_(copy.enabled)}
        </Switch>
        <div class="settings-link-actions">
          <Button type="button" variant="ghost" size="small" disabled={busy()} onClick={() => void probe()}>
            {_(copy.test)}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="small"
            disabled={busy() || !name().trim()}
            onClick={() => void save()}
          >
            {_(copy.save)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon={getSemanticIcon("action.remove")}
            disabled={busy()}
            onClick={props.onRemove}
          >
            {_(copy.remove)}
          </Button>
        </div>
      </div>
    </article>
  )
}

function authorizationDescriptor(state: SynergyLinkTargetView["authorization"]) {
  if (state === "approved") return copy.authorizationApproved
  if (state === "revoked") return copy.authorizationRevoked
  return copy.authorizationUnverified
}

function availabilityDescriptor(state: SynergyLinkTargetView["availability"]) {
  if (state === "connected") return copy.availabilityConnected
  if (state === "idle") return copy.availabilityIdle
  return copy.availabilityOffline
}
