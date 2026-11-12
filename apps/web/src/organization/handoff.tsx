import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import {
  OrganizationHandoffProtocol as Handoff,
  type OrganizationSessionProtocol as Session,
} from "@ericsanchezok/synergy-organization-protocol"
import type {
  OrgRuntimeRegistration,
  OrgResourceView,
  OrgCloudWorkspace,
} from "@ericsanchezok/synergy-sdk/organization"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { WorkspaceError } from "./workspace-error"
import { organizationHandoffMessages as messages } from "./handoff-messages"
import { organizationNativeHandoffMessages as nativeMessages } from "./handoff-native-messages"
import { OrganizationNativeDifference } from "./handoff-native"
import { organizationNativeHandoffMapping } from "./handoff-native-state"
import { OrganizationNativeCleanup } from "./handoff-native-cleanup"
import { organizationNativeCleanupHandle, type OrganizationNativeCleanupHandle } from "./handoff-native-cleanup-state"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import {
  createOrganizationHandoffState,
  organizationHandoffMachineKnown,
  organizationHandoffOutcomeKnown,
  type OrganizationHandoffAction,
  type OrganizationHandoffCancellation,
  type OrganizationHandoffSaved,
} from "./handoff-state"
import "./handoff.css"

const terminal = (view: Handoff.View) => ["completed", "cancelled", "retired"].includes(view.phase)

export function OrganizationHandoff(props: { session: Session.View; changed: () => void; compact?: boolean }) {
  const { _ } = useLingui()
  const dialog = useDialog()
  const space = useSpace()
  const view = space.current()!
  const [menu, setMenu] = createSignal(false)
  let anchor: HTMLSpanElement | undefined
  let id: string | undefined
  const close = () => {
    setMenu(false)
    if (id) dialog.close(id)
    id = undefined
  }
  view.signal.addEventListener("abort", close, { once: true })
  onCleanup(() => {
    view.signal.removeEventListener("abort", close)
    close()
  })
  const open = (trigger: HTMLButtonElement | undefined) => {
    if (id || view.signal.aborted || !trigger?.isConnected) return
    setMenu(false)
    trigger.focus({ preventScroll: true })
    id = dialog.push(
      () => <OrganizationHandoffDialog session={props.session} changed={props.changed} close={close} />,
      () => {
        id = undefined
      },
    )
  }
  return (
    <Show
      when={props.compact}
      fallback={
        <Button onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => open(event.currentTarget)}>
          {_(messages.move)}
        </Button>
      }
    >
      <span ref={anchor} class="organization-handoff-menu">
        <Popover
          variant="menu"
          placement="bottom-end"
          title={_(messages.actions)}
          open={menu()}
          onOpenChange={setMenu}
          triggerAs={(attributes) => (
            <Button
              {...attributes}
              variant="ghost"
              aria-label={_(messages.actions)}
              title={_(messages.actions)}
              icon={getSemanticIcon("action.more")}
            />
          )}
        >
          <Button
            variant="ghost"
            onClick={() =>
              open(anchor?.querySelector<HTMLButtonElement>('button[data-slot="popover-trigger"]') ?? undefined)
            }
          >
            {_(messages.move)}
          </Button>
        </Popover>
      </span>
    </Show>
  )
}

export function OrganizationHandoffDialog(props: { session: Session.View; changed: () => void; close: () => void }) {
  const { _, i18n } = useLingui()
  const dialog = useDialog()
  const space = useSpace()
  const api = space.client()!
  const owner = space.current()!
  const connection = space.connection()!
  const accountID = connection.account.accountID
  const authRevision = connection.account.authRevision
  const orgID = connection.orgID
  const incarnation = connection.deploymentIncarnation
  const sessionID = props.session.sessionID
  const projectID = props.session.projectID
  const controller = new AbortController()
  const signal = AbortSignal.any([owner.signal, controller.signal])
  const options = { throwOnError: true, signal } as const
  const confirm = useConfirm()
  const recovery = createOrganizationHandoffState({ storage: localStorage, owner: owner.key, projectID, sessionID })
  const [state, setState] = createStore<{
    runtimes: OrgRuntimeRegistration[]
    history: Handoff.View[]
    resources: OrgResourceView[]
    workspaces: OrgCloudWorkspace[]
    view?: Handoff.View
    preview?: Handoff.Options
    machine?: Handoff.MachineResult
    cancellationMachine?: Handoff.MachineResult
  }>({ runtimes: [], history: [], resources: [], workspaces: [] })
  const [saved, setSaved] = createSignal<OrganizationHandoffSaved>()
  const [destination, setDestination] = createSignal("")
  const [kind, setKind] = createSignal<Handoff.WorkspaceMapping["kind"]>("native")
  const [resourceID, setResourceID] = createSignal("")
  const [workspaceID, setWorkspaceID] = createSignal("")
  const [path, setPath] = createSignal("")
  const [runtimeCursor, setRuntimeCursor] = createSignal<string>()
  const [historyCursor, setHistoryCursor] = createSignal<string>()
  const [resourceCursor, setResourceCursor] = createSignal<string>()
  const [workspaceCursor, setWorkspaceCursor] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [cancelling, setCancelling] = createSignal(false)
  const [inspecting, setInspecting] = createSignal(false)
  const [listing, setListing] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [resourcesLoading, setResourcesLoading] = createSignal(false)
  const [workspacesLoading, setWorkspacesLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [storageFailed, setStorageFailed] = createSignal(false)
  const [accessLost, setAccessLost] = createSignal(false)
  const [retryable, setRetryable] = createSignal(false)
  const [nativeRevision, setNativeRevision] = createSignal(0)
  const [cleanup, setCleanup] = createSignal<OrganizationNativeCleanupHandle>()
  let selectionRevision = 0
  let workspaceRevision = 0
  let handoffRevision = 0
  let observedBinding = `${props.session.driverRuntimeID}:${props.session.bindingEpoch}`
  let first: HTMLButtonElement | undefined
  const current = () =>
    !signal.aborted &&
    space.current() === owner &&
    props.session.sessionID === sessionID &&
    props.session.projectID === projectID &&
    space.connection()?.state === "ready" &&
    space.connection()?.account.accountID === accountID &&
    space.connection()?.account.authRevision === authRevision &&
    space.connection()?.account.state === "active" &&
    space.connection()?.orgID === orgID &&
    space.connection()?.deploymentIncarnation === incarnation
  const actionable = () => current() && !storageFailed() && !accessLost() && props.session.permissions.execute
  const allowed = () =>
    actionable() && !busy() && !cancelling() && !inspecting() && !cancellation() && !state.view?.cancelRequested
  const pending = () => saved()?.pending
  const cancellation = () => saved()?.cancellation
  const sourceOwner = () =>
    props.session.runtime?.runtimeKind === "member"
      ? props.session.runtime.ownerID === accountID
      : props.session.creatorID === accountID
  const targetRuntime = () => state.runtimes.find((runtime) => runtime.runtimeID === state.view?.targetRuntimeID)
  const targetOwner = () => {
    const target = targetRuntime()
    return target?.runtimeKind === "member"
      ? target.accountID === accountID
      : target?.runtimeKind === "hosted" && props.session.creatorID === accountID
  }
  const sourceCanDrive = () => state.view?.initiator === accountID
  const label = (id: string) => {
    const runtime = state.runtimes.find((entry) => entry.runtimeID === id)
    return runtime
      ? runtime.runtimeKind === "hosted"
        ? runtime.name
        : runtime.deviceID
      : id === props.session.driverRuntimeID
        ? (props.session.runtime?.name ?? _(messages.source))
        : _(messages.destination)
  }
  function failure(error: unknown, display = true) {
    if (!current()) return
    if (display) setError(error)
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (["AUTHENTICATION_REQUIRED", "reauthorization_required", "signed_out"].includes(String(code))) {
      confirm.closeOwned()
      space.authorizationRequired(owner)
    }
    if (["PERMISSION_DENIED", "SHARE_REVOKED", "permission_denied"].includes(String(code))) {
      setAccessLost(true)
      confirm.closeOwned()
    }
  }
  function retain(id: string, action?: OrganizationHandoffAction) {
    try {
      const previous = saved()?.handoffID ?? state.view?.handoffID
      const value = recovery.save(id, action)
      if (previous !== id) {
        handoffRevision++
        setState("machine", undefined)
        setState("cancellationMachine", undefined)
        setRetryable(false)
        setCleanup(undefined)
      }
      setSaved(value)
      return value
    } catch (error) {
      setStorageFailed(true)
      throw error
    }
  }
  function confirmed(id: string) {
    try {
      if (saved()?.handoffID === id) setSaved(recovery.confirmed(id))
      setRetryable(false)
    } catch (error) {
      setStorageFailed(true)
      throw error
    }
  }
  function cancellationConfirmed(id: string) {
    try {
      if (saved()?.handoffID === id) setSaved(recovery.cancelConfirmed(id))
    } catch (error) {
      setStorageFailed(true)
      throw error
    }
  }
  function acceptView(value: unknown) {
    const view = Handoff.View.parse(value)
    const id = saved()?.handoffID ?? state.view?.handoffID
    if (
      view.sessionID !== sessionID ||
      view.orgID !== orgID ||
      view.deploymentIncarnation !== incarnation ||
      (id && view.handoffID !== id)
    )
      throw new Error("Handoff returned another owner")
    const previous = state.view?.phase
    const action = pending()
    if (
      action?.kind === "prepare" &&
      (view.targetRuntimeID !== action.body.targetRuntimeID ||
        view.fromEpoch !== action.body.expectedBindingEpoch ||
        view.mappingPlanRevision !== action.body.mappingPlanRevision ||
        JSON.stringify(view.workspaceMapping) !== JSON.stringify(action.body.workspaceMapping))
    )
      throw new Error("Handoff returned another original plan")
    if (action && organizationHandoffOutcomeKnown(action, view)) confirmed(view.handoffID)
    const cancelled = cancellation()
    if (cancelled && organizationHandoffOutcomeKnown(cancelled, view)) cancellationConfirmed(view.handoffID)
    setState("view", reconcile(view))
    if (terminal(view)) {
      try {
        if (view.phase === "cancelled" && view.workspaceMapping.kind === "organization-native" && view.manifestHash) {
          const original = state.runtimes.find((runtime) => runtime.runtimeID === view.targetRuntimeID)
          if (!original || (original.runtimeKind === "member" && original.accountID === accountID)) {
            if (!saved()) retain(view.handoffID)
            rememberCleanup()
          } else {
            recovery.clear(view.handoffID)
            setSaved(undefined)
          }
        } else {
          recovery.clear(view.handoffID)
          setSaved(undefined)
        }
      } catch (error) {
        setStorageFailed(true)
        throw error
      }
      if (previous !== view.phase) props.changed()
    }
    return view
  }
  function rememberCleanup() {
    const view = state.view
    if (!view || cleanup()) return
    const runtime = state.runtimes.find((runtime) => runtime.runtimeID === view.targetRuntimeID)
    if (!runtime || runtime.runtimeKind !== "member" || runtime.accountID !== accountID) return
    const handle = organizationNativeCleanupHandle(view, runtime)
    if (!handle) return
    try {
      const saved = recovery.rememberCleanup(handle)
      setSaved(saved)
      setCleanup(saved.nativeCleanup)
    } catch (error) {
      setStorageFailed(true)
      failure(error)
    }
  }
  function cleanupAllowed(handle: OrganizationNativeCleanupHandle) {
    const runtime = state.runtimes.find((runtime) => runtime.runtimeID === handle.runtime.runtimeID)
    return (
      current() &&
      !storageFailed() &&
      handle.binding.orgID === orgID &&
      handle.binding.deploymentIncarnation === incarnation &&
      handle.binding.sessionID === sessionID &&
      handle.runtime.accountID === accountID &&
      runtime?.runtimeKind === "member" &&
      runtime.accountID === accountID &&
      runtime.publicKey === handle.runtime.publicKey &&
      runtime.state === "active"
    )
  }
  async function readCleanup(handle: OrganizationNativeCleanupHandle, requestID: string) {
    if (!cleanupAllowed(handle) || cleanup() !== handle)
      throw new DOMException("The native cleanup owner was retired", "AbortError")
    const response = await api.orgHandoff.drive(
      { handoffID: handle.binding.handoffID, orgHandoffDrive: { operation: "inspect-target", requestID } },
      options,
    )
    if (!cleanupAllowed(handle) || cleanup() !== handle)
      throw new DOMException("The native cleanup owner was retired", "AbortError")
    return Handoff.MachineResult.parse(response.data)
  }
  function cleanupComplete(handle: OrganizationNativeCleanupHandle) {
    if (!current() || cleanup() !== handle) return
    try {
      handoffRevision++
      recovery.clear(handle.binding.handoffID)
      setSaved(undefined)
      setRetryable(false)
    } catch (error) {
      setStorageFailed(true)
      failure(error)
    }
  }
  async function refresh() {
    const id = saved()?.handoffID ?? state.view?.handoffID
    if (!id) return
    const revision = handoffRevision
    const result = await api.orgHandoff.get({ handoffID: id }, options)
    if (current() && revision === handoffRevision && (saved()?.handoffID ?? state.view?.handoffID) === id)
      return acceptView(result.data)
  }
  async function runtime(id: string) {
    if (state.runtimes.some((runtime) => runtime.runtimeID === id)) return
    const result = await api.orgRuntime.get({ runtimeID: id }, options)
    if (current()) {
      setState("runtimes", reconcile([...state.runtimes, result.data]))
      rememberCleanup()
    }
  }
  async function loadRuntimes(more = false) {
    if (listing()) return
    setListing(true)
    try {
      const result = await api.orgRuntime.list({ limit: 50, cursor: more ? runtimeCursor() : undefined }, options)
      if (!current()) return
      const previous = more
        ? state.runtimes
        : state.runtimes.filter((entry) =>
            [state.view?.sourceRuntimeID, state.view?.targetRuntimeID].includes(entry.runtimeID),
          )
      setState(
        "runtimes",
        reconcile([...new Map([...previous, ...result.data.items].map((entry) => [entry.runtimeID, entry])).values()]),
      )
      setRuntimeCursor(result.data.cursor)
      rememberCleanup()
    } catch (error) {
      failure(error)
    } finally {
      if (current()) setListing(false)
    }
  }
  async function history(more = false) {
    try {
      const result = await api.orgHandoff.list(
        { sessionID, limit: 50, cursor: more ? historyCursor() : undefined },
        options,
      )
      if (!current()) return
      const rows = result.data.items.map((view) => Handoff.View.parse(view))
      if (
        rows.some(
          (view) => view.orgID !== orgID || view.deploymentIncarnation !== incarnation || view.sessionID !== sessionID,
        )
      )
        throw new Error("Handoff history returned another owner")
      setState("history", reconcile(more ? [...state.history, ...rows] : rows))
      setHistoryCursor(result.data.cursor)
      if (!saved() && !state.view) {
        const active = rows.find((view) => !terminal(view))
        if (active) {
          retain(active.handoffID)
          acceptView(active)
          await runtime(active.targetRuntimeID)
        }
      }
    } catch (error) {
      failure(error)
    }
  }
  async function inspectChoices(id: string) {
    if (!allowed() || pending() || !id) return
    const revision = ++selectionRevision
    setDestination(id)
    setState("preview", undefined)
    setChecking(true)
    setError(undefined)
    try {
      const result = await api.orgHandoff.options(
        { sessionID, requestID: generateSecureUUID(), targetRuntimeID: id },
        options,
      )
      if (!current() || revision !== selectionRevision || destination() !== id) return
      const value = Handoff.Options.parse(result.data)
      if (
        value.sessionID !== sessionID ||
        value.projectID !== projectID ||
        value.sourceRuntimeID !== props.session.driverRuntimeID ||
        value.targetRuntimeID !== id ||
        value.bindingEpoch !== props.session.bindingEpoch
      )
        throw { code: "STALE_BINDING" }
      setState("preview", reconcile(value))
      const initial = value.choices.find(
        (choice) =>
          !choice.requiresDifference && ["native", "organization-live", "organization-object"].includes(choice.kind),
      )
      if (initial && initial.kind !== "organization-native") chooseKind(initial.kind)
    } catch (error) {
      if (revision === selectionRevision) failure(error)
    } finally {
      if (current() && revision === selectionRevision) setChecking(false)
    }
  }
  async function resources(more = false) {
    if (resourcesLoading()) return
    setResourcesLoading(true)
    try {
      const result = await api.orgProjectResources.list(
        { projectID, limit: 50, cursor: more ? resourceCursor() : undefined },
        options,
      )
      if (!current()) return
      setState(
        "resources",
        reconcile(more ? [...state.resources, ...result.data.items] : result.data.items, { key: "resourceID" }),
      )
      setResourceCursor(result.data.cursor)
    } catch (error) {
      failure(error)
    } finally {
      if (current()) setResourcesLoading(false)
    }
  }
  async function workspaces(id: string, more = false) {
    if (!id || (more && workspacesLoading())) return
    const revision = more ? workspaceRevision : ++workspaceRevision
    setWorkspacesLoading(true)
    setResourceID(id)
    if (!more) {
      setWorkspaceID("")
      setState("workspaces", reconcile([]))
      setWorkspaceCursor(undefined)
    }
    try {
      const result = await api.orgCloudWorkspaces.list(
        { projectID, resourceID: id, limit: 50, cursor: more ? workspaceCursor() : undefined },
        options,
      )
      if (!current() || id !== resourceID() || revision !== workspaceRevision) return
      setState(
        "workspaces",
        reconcile(more ? [...state.workspaces, ...result.data.items] : result.data.items, { key: "workspaceID" }),
      )
      setWorkspaceCursor(result.data.cursor)
    } catch (error) {
      if (id === resourceID() && revision === workspaceRevision) failure(error)
    } finally {
      if (current() && revision === workspaceRevision) setWorkspacesLoading(false)
    }
  }
  function chooseKind(value: Handoff.WorkspaceMapping["kind"]) {
    setKind(value)
    if (value === "organization-object") void resources()
  }
  function mapping(): Handoff.WorkspaceMapping | undefined {
    const preview = state.preview
    if (!preview) return
    if (kind() === "organization-native") return organizationNativeHandoffMapping(preview, "validation")
    if (!preview.choices.some((choice) => choice.kind === kind() && !choice.requiresDifference)) return
    if (kind() === "native") return { kind: "native" }
    if (!preview.source) return
    const source = {
      workspaceID: preview.source.reference.workspaceID,
      generation: preview.source.reference.generation,
    }
    if (kind() === "organization-live" && preview.source.resource)
      return { kind: "organization-live", source, resource: preview.source.resource }
    const workspace = state.workspaces.find(
      (workspace) =>
        workspace.workspaceID === workspaceID() &&
        workspace.resourceID === resourceID() &&
        workspace.projectID === projectID &&
        !workspace.activeMount,
    )
    const resource = state.resources.find(
      (resource) =>
        resource.resourceID === resourceID() &&
        resource.state === "enabled" &&
        resource.permissions.use &&
        resource.definition.protocol === "workspace-storage",
    )
    if (kind() !== "organization-object" || !workspace || !resource || !path()) return
    const parsed = Handoff.WorkspaceMapping.safeParse({
      kind: "organization-object",
      moveID: "validation",
      source,
      target: {
        resourceID: resource.resourceID,
        workspaceID: workspace.workspaceID,
        generation: workspace.generation,
        expectedRevision: workspace.revision,
        path: path(),
      },
      acceptedDiffHash: null,
    })
    return parsed.success ? parsed.data : undefined
  }
  async function perform(action: OrganizationHandoffAction, id = saved()?.handoffID ?? state.view?.handoffID) {
    if (!allowed() || !id) return false
    if (pending() && JSON.stringify(pending()) !== JSON.stringify(action)) return false
    const retained = !!pending()
    try {
      retain(id, action)
    } catch (error) {
      failure(error)
      return false
    }
    const revision = handoffRevision
    setBusy(true)
    setError(undefined)
    setRetryable(false)
    try {
      if (action.kind === "drive") {
        const response = await api.orgHandoff.drive({ handoffID: id, orgHandoffDrive: action.body }, options)
        if (!current() || revision !== handoffRevision) return false
        const result = Handoff.MachineResult.parse(response.data)
        const runtimeID = action.body.operation.endsWith("-source")
          ? state.view?.sourceRuntimeID
          : state.view?.targetRuntimeID
        if (
          result.handoffID !== id ||
          result.requestID !== action.body.requestID ||
          result.operation !== action.body.operation ||
          result.runtimeID !== runtimeID
        )
          throw new Error("Handoff operation returned another participant")
        setState("machine", reconcile(result))
        setRetryable(result.state === "blocked")
        if (result.operation === "preview-target" && result.state === "complete")
          setNativeRevision((value) => value + 1)
        if (organizationHandoffMachineKnown(action, result)) confirmed(id)
        await refresh()
        return result.state === "complete"
      }
      if (action.kind === "permit") {
        const response = await api.orgHandoff.permit({ handoffID: id, orgHandoffPermitRequest: action.body }, options)
        if (!current() || revision !== handoffRevision) return false
        const result = Handoff.SignedPermit.parse(response.data).permit
        if (
          result.handoffID !== id ||
          result.purpose !== action.body.purpose ||
          result.orgID !== orgID ||
          result.deploymentIncarnation !== incarnation ||
          result.sessionID !== sessionID
        )
          throw new Error("Handoff authorization returned another owner")
        confirmed(id)
        await refresh()
        return true
      }
      const response =
        action.kind === "prepare"
          ? await api.orgHandoff.prepare({ sessionID, orgHandoffPrepare: action.body }, options)
          : action.kind === "accept"
            ? await api.orgHandoff.accept({ handoffID: id, orgHandoffAccept: action.body }, options)
            : action.kind === "commit"
              ? await api.orgHandoff.commit({ handoffID: id, body: {} }, options)
              : await api.orgHandoff.cancel({ handoffID: id, body: {} }, options)
      if (!current() || revision !== handoffRevision) return false
      acceptView(response.data)
      if (saved()?.handoffID === id) confirmed(id)
      return true
    } catch (error) {
      if (
        current() &&
        revision === handoffRevision &&
        !retained &&
        action.kind !== "drive" &&
        error &&
        typeof error === "object" &&
        "outcome" in error &&
        error.outcome === "not_dispatched"
      ) {
        try {
          if (action.kind === "prepare") {
            recovery.clear(id)
            setSaved(undefined)
            setState("preview", undefined)
          } else confirmed(id)
        } catch (error) {
          setStorageFailed(true)
          failure(error)
        }
      }
      if (revision === handoffRevision) failure(error)
      return false
    } finally {
      if (current()) setBusy(false)
    }
  }
  async function performCancellation(action: OrganizationHandoffCancellation, id: string, retry?: string) {
    if (!actionable() || cancelling() || !state.view?.canCancel || state.view.handoffID !== id || !sourceCanDrive())
      return
    let attempt: ReturnType<typeof recovery.cancel>
    try {
      attempt = recovery.cancel(id, action, retry)
      setSaved(attempt.saved)
    } catch (error) {
      setStorageFailed(true)
      failure(error)
      return
    }
    if (!attempt.accepted) {
      handoffRevision++
      await check()
      return
    }
    const revision = ++handoffRevision
    setState("cancellationMachine", undefined)
    setCancelling(true)
    setError(undefined)
    try {
      if (action.kind === "cancel") {
        const result = await api.orgHandoff.cancel({ handoffID: id, body: {} }, options)
        if (current() && revision === handoffRevision) acceptView(result.data)
        return
      }
      const response = await api.orgHandoff.drive({ handoffID: id, orgHandoffDrive: action.body }, options)
      if (!current() || revision !== handoffRevision) return
      const result = Handoff.MachineResult.parse(response.data)
      if (
        result.handoffID !== id ||
        result.requestID !== action.body.requestID ||
        result.operation !== action.body.operation ||
        result.runtimeID !== state.view?.sourceRuntimeID
      )
        throw new Error("Handoff cancellation returned another participant")
      setState("cancellationMachine", reconcile(result))
      if (organizationHandoffMachineKnown(action, result)) cancellationConfirmed(id)
      await refresh()
    } catch (error) {
      if (
        current() &&
        revision === handoffRevision &&
        !attempt.retained &&
        action.kind === "cancel" &&
        error &&
        typeof error === "object" &&
        "outcome" in error &&
        error.outcome === "not_dispatched"
      ) {
        try {
          const saved = recovery.cancelUnsent(id, attempt.nonce)
          if (saved?.handoffID === id) setSaved(saved)
        } catch (error) {
          setStorageFailed(true)
          failure(error)
        }
      }
      if (revision === handoffRevision) failure(error)
    } finally {
      if (current()) setCancelling(false)
    }
  }
  function drive(operation: Handoff.Drive["operation"]) {
    try {
      if (operation === "preview-target") handoffRevision++
      const previous = state.machine
      const runtimeID = operation.endsWith("-source") ? state.view?.sourceRuntimeID : state.view?.targetRuntimeID
      return perform({
        kind: "drive",
        body: {
          operation,
          requestID: generateSecureUUID(),
          ...(previous && previous.runtimeID === runtimeID ? { expectedRevision: previous.revision } : {}),
        },
      })
    } catch (error) {
      failure(error)
      return Promise.resolve(false)
    }
  }
  function nativeDirectoryLabel(view: Handoff.View) {
    const mapping = view.workspaceMapping
    const original = state.preview
    const native = original?.native
    if (
      mapping.kind === "organization-native" &&
      original?.targetRuntimeID === view.targetRuntimeID &&
      native &&
      native.reference.workspaceID === mapping.target.workspaceID &&
      native.reference.generation === mapping.target.generation &&
      native.reference.revision === mapping.target.expectedRevision &&
      native.projectRevision === mapping.target.projectRevision
    )
      return native.label
    return _(nativeMessages.selected)
  }
  async function readDifference(summary: Handoff.Difference, cursor?: string) {
    const view = state.view
    if (
      !current() ||
      !view ||
      !targetOwner() ||
      !props.session.permissions.execute ||
      pending() ||
      view.cancelRequested ||
      !["preparing", "prepared"].includes(view.phase) ||
      JSON.stringify(view.workspaceDifference) !== JSON.stringify(summary)
    )
      throw new DOMException("The native comparison has another owner", "AbortError")
    const revision = handoffRevision
    const handoffID = view.handoffID
    const targetRuntimeID = view.targetRuntimeID
    const requestID = generateSecureUUID()
    const response = await api.orgHandoff.drive(
      {
        handoffID,
        orgHandoffDrive: {
          operation: "inspect-target",
          requestID,
          expectedRevision: summary.diffHash,
          ...(cursor ? { cursor } : {}),
        },
      },
      options,
    )
    if (
      !current() ||
      revision !== handoffRevision ||
      state.view?.handoffID !== handoffID ||
      state.view.cancelRequested ||
      JSON.stringify(state.view.workspaceDifference) !== JSON.stringify(summary)
    )
      throw new DOMException("The native comparison was retired", "AbortError")
    const result = Handoff.MachineResult.parse(response.data)
    if (
      result.handoffID !== handoffID ||
      result.runtimeID !== targetRuntimeID ||
      result.requestID !== requestID ||
      result.operation !== "inspect-target"
    )
      throw new Error("The difference reader returned another destination")
    return result
  }
  function acceptDifference(value: Handoff.DifferenceConsent) {
    const captured = state.view ? Handoff.View.parse(state.view) : undefined
    if (
      !captured?.canAccept ||
      !allowed() ||
      pending() ||
      captured.cancelRequested ||
      captured.workspaceMapping.kind !== "organization-native" ||
      !captured.targetAccepted ||
      !captured.workspaceDifference ||
      !targetOwner()
    )
      return
    const consent = Handoff.DifferenceConsent.parse(value)
    if (
      JSON.stringify(consent) !== JSON.stringify(Handoff.DifferenceConsent.strip().parse(captured.workspaceDifference))
    )
      return
    const parent = dialog.active?.id
    if (!parent) return
    first?.focus({ preventScroll: true })
    confirm.show({
      title: nativeMessages.accept,
      description: { ...nativeMessages.acceptHint, values: { directory: nativeDirectoryLabel(captured) } },
      confirmLabel: nativeMessages.accept,
      tone: "warning",
      async onConfirm() {
        const currentView = state.view
        if (
          !allowed() ||
          !currentView?.canAccept ||
          currentView.handoffID !== captured.handoffID ||
          currentView.mappingHash !== captured.mappingHash ||
          currentView.mappingPlanRevision !== captured.mappingPlanRevision ||
          !currentView.workspaceDifference ||
          currentView.cancelRequested ||
          JSON.stringify(Handoff.DifferenceConsent.strip().parse(currentView.workspaceDifference)) !==
            JSON.stringify(consent)
        )
          return
        await perform(
          {
            kind: "accept",
            body: {
              mappingPlanRevision: captured.mappingPlanRevision,
              mappingHash: captured.mappingHash,
              workspaceDifference: consent,
            },
          },
          captured.handoffID,
        )
      },
      onConfirmed() {
        if (current() && state.view?.handoffID === captured.handoffID && dialog.active?.id === parent)
          first?.focus({ preventScroll: true })
      },
    })
  }
  async function check(cursor?: string) {
    if (inspecting() || cancelling() || !current()) return
    const inspection = handoffRevision
    setInspecting(true)
    setError(undefined)
    try {
      const view = await refresh()
      if (!current() || inspection !== handoffRevision || !view || terminal(view)) return
      const original = cancellation() ?? pending()
      if (original?.kind !== "drive" && original?.kind !== "cancel" && !view.cancelRequested) return
      const role =
        view.cancelRequested ||
        original?.kind === "cancel" ||
        (original?.kind === "drive" && original.body.operation.endsWith("-source"))
          ? "source"
          : "target"
      const revision = machine()?.revision
      const request = {
        requestID: generateSecureUUID(),
        operation: role === "source" ? ("inspect-source" as const) : ("inspect-target" as const),
        ...(cursor && revision ? { cursor, expectedRevision: revision } : {}),
      }
      const response = await api.orgHandoff.drive({ handoffID: view.handoffID, orgHandoffDrive: request }, options)
      if (!current() || inspection !== handoffRevision) return
      const result = Handoff.MachineResult.parse(response.data)
      if (
        result.handoffID !== view.handoffID ||
        result.requestID !== request.requestID ||
        result.operation !== request.operation ||
        result.runtimeID !== (role === "source" ? view.sourceRuntimeID : view.targetRuntimeID)
      )
        throw new Error("Handoff inspection returned another participant")
      if (cursor && result.revision !== revision) throw { code: "REVISION_CONFLICT" }
      const cancel = cancellation()
      if (view.cancelRequested || cancel) setState("cancellationMachine", reconcile(result))
      else {
        setState("machine", reconcile(result))
        setRetryable(result.state === "blocked")
      }
      if (cancel && organizationHandoffMachineKnown(cancel, result)) cancellationConfirmed(view.handoffID)
      const native = pending()
      if (native && organizationHandoffMachineKnown(native, result)) confirmed(view.handoffID)
      await refresh()
    } catch (error) {
      if (inspection === handoffRevision) failure(error)
    } finally {
      if (current()) setInspecting(false)
    }
  }
  async function begin() {
    try {
      const preview = state.preview
      const selected = mapping()
      if (!allowed() || !sourceOwner() || pending() || !preview || !selected) return
      const handoffID = generateSecureUUID()
      const workspaceMapping =
        selected.kind === "organization-object" || selected.kind === "organization-native"
          ? { ...selected, moveID: generateSecureUUID() }
          : selected
      await perform(
        {
          kind: "prepare",
          body: {
            handoffID,
            targetRuntimeID: preview.targetRuntimeID,
            expectedBindingEpoch: preview.bindingEpoch,
            expectedControlRevision: preview.controlRevision,
            mappingPlanRevision: 1,
            workspaceMapping,
          },
        },
        handoffID,
      )
    } catch (error) {
      failure(error)
    }
  }
  function surrender() {
    const captured = state.view
    if (!captured || !allowed() || pending()) return
    confirm.show({
      title: messages.surrender,
      description: messages.surrenderHint,
      confirmLabel: messages.surrender,
      tone: "warning",
      async onConfirm() {
        if (!allowed() || state.view?.handoffID !== captured.handoffID || state.view.phase !== "prepared") return
        if (await perform({ kind: "permit", body: { purpose: "handoff-surrender" } }, captured.handoffID))
          await drive("surrender-source")
      },
    })
  }
  function cancel(trigger: HTMLButtonElement) {
    const captured = state.view
    if (!captured?.canCancel || !actionable() || cancelling() || cancellation() || !sourceCanDrive()) return
    const parent = dialog.active?.id
    if (!parent) return
    const source = captured.cancelRequested
    trigger.focus({ preventScroll: true })
    confirm.show({
      title: source ? messages.finishCancel : messages.cancel,
      description: source ? messages.finishCancelHint : messages.cancelHint,
      confirmLabel: source ? messages.finishCancel : messages.cancel,
      tone: "warning",
      onConfirmed() {
        if (!current() || state.view?.handoffID !== captured.handoffID || dialog.active?.id !== parent) return
        const target = trigger.isConnected && !trigger.disabled ? trigger : first
        target?.focus({ preventScroll: true })
      },
      async onConfirm() {
        if (
          !actionable() ||
          cancelling() ||
          state.view?.handoffID !== captured.handoffID ||
          !state.view.canCancel ||
          state.view.cancelRequested !== source ||
          cancellation()
        )
          return
        await performCancellation(
          source
            ? {
                kind: "drive",
                body: { operation: "cancel-source", requestID: generateSecureUUID() },
              }
            : { kind: "cancel" },
          captured.handoffID,
        )
      },
    })
  }
  function retire() {
    const captured = state.view
    if (!captured || !allowed() || pending()) return
    confirm.show({
      title: messages.retire,
      description: messages.retireHint,
      confirmLabel: messages.retire,
      tone: "danger",
      async onConfirm() {
        if (
          !allowed() ||
          state.view?.handoffID !== captured.handoffID ||
          !["surrendered", "committed", "activation_permitted"].includes(state.view.phase)
        )
          return
        await drive("retire-target")
      },
    })
  }
  async function activate() {
    if (await perform({ kind: "permit", body: { purpose: "handoff-activation" } })) await drive("activate-target")
  }
  onMount(() => {
    try {
      setSaved(recovery.read())
      const retained = saved()?.nativeCleanup
      if (retained) {
        if (
          retained.binding.orgID !== orgID ||
          retained.binding.deploymentIncarnation !== incarnation ||
          retained.runtime.accountID !== accountID
        )
          throw new Error("Native cleanup has another account or deployment")
        setCleanup(retained)
        void runtime(retained.runtime.runtimeID).catch((error) => failure(error, false))
        return
      }
    } catch (error) {
      setStorageFailed(true)
      failure(error)
    }
    void loadRuntimes()
    void history()
    if (saved())
      void refresh()
        .then((view) => view && runtime(view.targetRuntimeID))
        .catch(failure)
  })
  createEffect(() => {
    if (!current()) {
      confirm.closeOwned()
      props.close()
    }
  })
  createEffect(() => {
    if (!props.session.permissions.execute) confirm.closeOwned()
  })
  createEffect(() => {
    const binding = `${props.session.driverRuntimeID}:${props.session.bindingEpoch}`
    if (binding === observedBinding) return
    observedBinding = binding
    selectionRevision++
    setState("preview", undefined)
    setDestination("")
  })
  const aborted = () => {
    confirm.closeOwned()
    props.close()
  }
  signal.addEventListener("abort", aborted, { once: true })
  onCleanup(() => {
    signal.removeEventListener("abort", aborted)
    controller.abort()
    confirm.closeOwned()
  })
  const phase = () =>
    state.view?.phase === "activation_permitted" ? messages.committed : messages[state.view?.phase ?? "preparing"]
  const machine = () => (state.view?.cancelRequested || cancellation() ? state.cancellationMachine : state.machine)
  const requirements = () => {
    const action = pending()
    if (
      state.view?.cancelRequested &&
      machine()?.operation !== "cancel-source" &&
      !(action?.kind === "drive" && action.body.operation === "cancel-source")
    )
      return []
    return machine()?.requirements.length ? machine()!.requirements : (state.view?.missingRequirements ?? [])
  }
  const sourceMissing = () =>
    state.view?.missingRequirements.some((requirement) => requirement.code === "source_freeze")
  const targetMissing = () =>
    state.view?.missingRequirements.some((requirement) => requirement.code === "target_prepare")
  const supportedChoices = () =>
    state.preview?.choices.filter(
      (choice) =>
        (["native", "organization-live", "organization-object"].includes(choice.kind) && !choice.requiresDifference) ||
        (choice.kind === "organization-native" &&
          choice.requiresDifference &&
          !!state.preview?.native &&
          state.preview.source?.kind === "organization" &&
          !!state.preview.source.resource),
    ) ?? []
  const remoteWorkspace = () => {
    const mapping = state.view?.workspaceMapping
    return mapping?.kind === "organization-object"
      ? mapping.target
      : mapping?.kind === "organization-live"
        ? mapping.resource
        : undefined
  }
  return (
    <Dialog
      title={_(cleanup() && !state.view ? nativeMessages.cleanup : messages.move)}
      size="form"
      initialFocus={() => first}
      footer={
        <Button ref={first} variant="ghost" onClick={props.close}>
          {_(messages.close)}
        </Button>
      }
    >
      <div class="organization-handoff">
        <Show when={!cleanup()}>
          <p>{_(messages.hint)}</p>
        </Show>
        <WorkspaceError
          error={error()}
          retry={
            !pending() && !busy()
              ? () =>
                  state.view ? void check() : destination() ? void inspectChoices(destination()) : void loadRuntimes()
              : undefined
          }
        />
        <Show when={!state.view && !saved() && !cleanup()}>
          <Show when={sourceOwner() && props.session.permissions.execute} fallback={<p>{_(messages.ownerHint)}</p>}>
            <div class="organization-handoff-fields">
              <label class="organization-handoff-field">
                <span>{_(messages.destination)}</span>
                <MenuField
                  ariaLabel={_(messages.destination)}
                  value={destination()}
                  onChange={(id) => void inspectChoices(id)}
                  triggerLabel={!destination() ? _(messages.chooseDestination) : undefined}
                  disabled={busy() || checking() || listing()}
                  options={state.runtimes
                    .filter(
                      (runtime) => runtime.runtimeID !== props.session.driverRuntimeID && runtime.state === "active",
                    )
                    .map((runtime) => ({ value: runtime.runtimeID, label: label(runtime.runtimeID) }))}
                />
              </label>
              <Show when={listing()}>
                <p role="status">{_(common.loading)}</p>
              </Show>
              <Show
                when={
                  !listing() &&
                  !state.runtimes.some(
                    (runtime) => runtime.runtimeID !== props.session.driverRuntimeID && runtime.state === "active",
                  )
                }
              >
                <p>{_(messages.noDestination)}</p>
              </Show>
              <div class="organization-handoff-actions">
                <Show when={runtimeCursor()}>
                  <Button disabled={listing()} onClick={() => void loadRuntimes(true)}>
                    {_(common.more)}
                  </Button>
                </Show>
                <Button variant="ghost" disabled={listing()} onClick={() => void loadRuntimes()}>
                  {_(messages.refresh)}
                </Button>
              </div>
              <Show when={checking()}>
                <p role="status">{_(messages.checking)}</p>
              </Show>
              <Show when={state.preview}>
                {(preview) => (
                  <>
                    <dl class="organization-handoff-summary">
                      <div>
                        <dt>{_(messages.source)}</dt>
                        <dd>{preview().source?.label ?? _(messages.noSource)}</dd>
                      </div>
                      <div>
                        <dt>{_(messages.target)}</dt>
                        <dd>{label(preview().targetRuntimeID)}</dd>
                      </div>
                    </dl>
                    <Show when={supportedChoices().length} fallback={<p role="status">{_(messages.unsupported)}</p>}>
                      <div class="organization-handoff-field">
                        <span>{_(messages.workspace)}</span>
                        <Show
                          when={supportedChoices().length > 1}
                          fallback={
                            <p>
                              {_(
                                kind() === "native"
                                  ? messages.native
                                  : kind() === "organization-native"
                                    ? nativeMessages.existing
                                    : kind() === "organization-live"
                                      ? messages.live
                                      : messages.object,
                              )}
                            </p>
                          }
                        >
                          <MenuField
                            ariaLabel={_(messages.workspace)}
                            value={kind()}
                            onChange={(kind) => chooseKind(kind as Handoff.WorkspaceMapping["kind"])}
                            options={supportedChoices().map((choice) => ({
                              value: choice.kind,
                              label: _(
                                choice.kind === "native"
                                  ? messages.native
                                  : choice.kind === "organization-native"
                                    ? nativeMessages.existing
                                    : choice.kind === "organization-live"
                                      ? messages.live
                                      : messages.object,
                              ),
                            }))}
                          />
                        </Show>
                      </div>
                      <p>
                        {_(
                          kind() === "organization-native"
                            ? nativeMessages.hint
                            : kind() === "organization-live"
                              ? messages.liveHint
                              : messages.nativeHint,
                        )}
                      </p>
                      <Show when={kind() === "organization-native" && preview().native}>
                        {(native) => (
                          <dl class="organization-handoff-summary">
                            <div>
                              <dt>{_(nativeMessages.directory)}</dt>
                              <dd>{native().label}</dd>
                            </div>
                          </dl>
                        )}
                      </Show>
                      <Show
                        when={
                          preview().source?.kind === "organization" &&
                          state.runtimes.find((runtime) => runtime.runtimeID === preview().targetRuntimeID)
                            ?.runtimeKind === "member" &&
                          !preview().native
                        }
                      >
                        <p>{_(nativeMessages.unavailable)}</p>
                      </Show>
                      <Show when={kind() === "organization-object"}>
                        <label class="organization-handoff-field">
                          <span>{_(messages.storage)}</span>
                          <MenuField
                            ariaLabel={_(messages.storage)}
                            value={resourceID()}
                            triggerLabel={!resourceID() ? _(messages.chooseStorage) : undefined}
                            onChange={(id) => void workspaces(id)}
                            options={state.resources
                              .filter(
                                (resource) =>
                                  resource.state === "enabled" &&
                                  resource.permissions.use &&
                                  resource.definition.protocol === "workspace-storage",
                              )
                              .map((resource) => ({ value: resource.resourceID, label: resource.name }))}
                          />
                        </label>
                        <Show when={resourcesLoading()}>
                          <p role="status">{_(common.loading)}</p>
                        </Show>
                        <Show when={resourceCursor()}>
                          <Button disabled={resourcesLoading()} onClick={() => void resources(true)}>
                            {_(common.more)}
                          </Button>
                        </Show>
                        <label class="organization-handoff-field">
                          <span>{_(messages.workspace)}</span>
                          <MenuField
                            ariaLabel={_(messages.chooseWorkspace)}
                            value={workspaceID()}
                            onChange={setWorkspaceID}
                            triggerLabel={!workspaceID() ? _(messages.chooseWorkspace) : undefined}
                            options={state.workspaces
                              .filter(
                                (workspace) =>
                                  !workspace.activeMount &&
                                  workspace.resourceID === resourceID() &&
                                  workspace.projectID === projectID,
                              )
                              .map((workspace) => ({ value: workspace.workspaceID, label: workspace.name }))}
                          />
                        </label>
                        <Show when={workspacesLoading()}>
                          <p role="status">{_(common.loading)}</p>
                        </Show>
                        <Show
                          when={
                            resourceID() &&
                            !workspacesLoading() &&
                            !state.workspaces.some((workspace) => !workspace.activeMount)
                          }
                        >
                          <p>{_(messages.noWorkspace)}</p>
                        </Show>
                        <Show when={workspaceCursor()}>
                          <Button disabled={workspacesLoading()} onClick={() => void workspaces(resourceID(), true)}>
                            {_(common.more)}
                          </Button>
                        </Show>
                        <TextField label={_(messages.path)} value={path()} onChange={setPath} maxLength={4096} />
                      </Show>
                      <Button
                        variant="primary"
                        disabled={!allowed() || checking() || !mapping()}
                        onClick={() => void begin()}
                      >
                        {_(messages.begin)}
                      </Button>
                    </Show>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={state.view}>
          {(view) => (
            <>
              <h3 aria-live="polite">{_(phase())}</h3>
              <dl class="organization-handoff-summary">
                <div>
                  <dt>{_(messages.source)}</dt>
                  <dd>{label(view().sourceRuntimeID)}</dd>
                </div>
                <div>
                  <dt>{_(messages.target)}</dt>
                  <dd>{label(view().targetRuntimeID)}</dd>
                </div>
                <div>
                  <dt>{_(messages.workspace)}</dt>
                  <dd>
                    {_(
                      view().workspaceMapping.kind === "native"
                        ? messages.native
                        : view().workspaceMapping.kind === "organization-native"
                          ? nativeMessages.existing
                          : view().workspaceMapping.kind === "organization-live"
                            ? messages.live
                            : messages.object,
                    )}
                  </dd>
                </div>
                <Show when={remoteWorkspace()}>
                  {(workspace) => (
                    <>
                      <div>
                        <dt>{_(messages.storage)}</dt>
                        <dd>
                          {state.resources.find((resource) => resource.resourceID === workspace().resourceID)?.name ??
                            workspace().resourceID}
                        </dd>
                      </div>
                      <div>
                        <dt>{_(messages.cloudWorkspace)}</dt>
                        <dd>
                          {state.workspaces.find((entry) => entry.workspaceID === workspace().workspaceID)?.name ??
                            workspace().workspaceID}
                        </dd>
                      </div>
                      <div>
                        <dt>{_(messages.folder)}</dt>
                        <dd>{workspace().path}</dd>
                      </div>
                    </>
                  )}
                </Show>
              </dl>
              <Show when={!terminal(view()) && requirements().length}>
                <ul class="organization-handoff-requirements">
                  <For each={requirements()}>
                    {(requirement) => (
                      <li>
                        {requirement.code === "source_freeze"
                          ? _(messages.sourceFreeze)
                          : requirement.code === "target_prepare"
                            ? _(messages.targetPrepare)
                            : requirement.code === "target_consent"
                              ? _(messages.targetConsent)
                              : requirement.label}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={requirements().length && machine()?.requirementsCursor}>
                <Button
                  variant="ghost"
                  disabled={inspecting() || cancelling()}
                  onClick={() => void check(machine()?.requirementsCursor)}
                >
                  {_(messages.moreRequirements)}
                </Button>
              </Show>
              <Show when={machine()?.progress}>
                {(progress) => (
                  <p>
                    {_({
                      ...messages.progress,
                      values: { bytes: new Intl.NumberFormat(i18n().locale).format(progress().bytes) },
                    })}
                  </p>
                )}
              </Show>
              <Show when={view().phase === "completed"}>
                <p>{_(messages.completedHint)}</p>
              </Show>
              <Show when={view().cancelRequested && !terminal(view())}>
                <p role="status">{_(messages.cancelRequested)}</p>
              </Show>
              <Show
                when={
                  props.session.permissions.read &&
                  view().workspaceMapping.kind === "organization-native" &&
                  view().targetAccepted &&
                  !sourceMissing() &&
                  !view().cancelRequested &&
                  ["preparing", "prepared"].includes(view().phase)
                }
              >
                <Show when={targetOwner()} fallback={<p>{_(nativeMessages.waiting)}</p>}>
                  <OrganizationNativeDifference
                    view={view()}
                    revision={nativeRevision()}
                    disabled={!allowed()}
                    pending={!!pending()}
                    read={readDifference}
                    preview={() => void drive("preview-target")}
                    accept={acceptDifference}
                    failed={(error) => failure(error, false)}
                  />
                </Show>
              </Show>
              <Show
                when={pending()}
                fallback={
                  <div class="organization-handoff-actions">
                    <Show when={view().canAccept && !view().targetAccepted && !view().cancelRequested}>
                      <Button
                        variant="primary"
                        disabled={!allowed()}
                        onClick={() =>
                          void perform({
                            kind: "accept",
                            body: { mappingPlanRevision: view().mappingPlanRevision, mappingHash: view().mappingHash },
                          })
                        }
                      >
                        {_(
                          view().workspaceMapping.kind === "organization-native"
                            ? nativeMessages.acceptDirectory
                            : messages.accept,
                        )}
                      </Button>
                    </Show>
                    <Show when={!view().targetAccepted && !view().canAccept && !view().cancelRequested}>
                      <p>{_(messages.waiting)}</p>
                    </Show>
                    <Show
                      when={
                        view().phase === "preparing" &&
                        !view().cancelRequested &&
                        view().targetAccepted &&
                        sourceCanDrive() &&
                        sourceMissing()
                      }
                    >
                      <Button disabled={!allowed()} onClick={() => void drive("prepare-source")}>
                        {_(messages.prepareSource)}
                      </Button>
                    </Show>
                    <Show
                      when={
                        view().phase === "preparing" &&
                        !view().cancelRequested &&
                        view().targetAccepted &&
                        targetOwner() &&
                        !sourceMissing() &&
                        targetMissing() &&
                        (view().workspaceMapping.kind !== "organization-native" ||
                          view().workspaceDifferenceAccepted === true)
                      }
                    >
                      <Button disabled={!allowed()} onClick={() => void drive("prepare-target")}>
                        {_(messages.prepareTarget)}
                      </Button>
                    </Show>
                    <Show when={view().phase === "prepared" && !view().cancelRequested && sourceCanDrive()}>
                      <Button variant="primary" disabled={!allowed()} onClick={surrender}>
                        {_(messages.surrender)}
                      </Button>
                    </Show>
                    <Show when={view().phase === "surrendered" && !view().cancelRequested && sourceCanDrive()}>
                      <Button variant="primary" disabled={!allowed()} onClick={() => void perform({ kind: "commit" })}>
                        {_(messages.commit)}
                      </Button>
                    </Show>
                    <Show
                      when={
                        ["committed", "activation_permitted"].includes(view().phase) &&
                        !view().cancelRequested &&
                        targetOwner()
                      }
                    >
                      <Button variant="primary" disabled={!allowed()} onClick={() => void activate()}>
                        {_(messages.activate)}
                      </Button>
                    </Show>
                    <Show
                      when={
                        ["surrendered", "committed", "activation_permitted"].includes(view().phase) &&
                        !view().cancelRequested &&
                        targetOwner()
                      }
                    >
                      <Button variant="ghost" disabled={!allowed()} onClick={retire}>
                        {_(messages.retire)}
                      </Button>
                    </Show>
                    <Show when={view().canCancel && sourceCanDrive()}>
                      <Button
                        variant="ghost"
                        disabled={!actionable() || cancelling() || !!cancellation()}
                        onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) =>
                          cancel(event.currentTarget)
                        }
                      >
                        {_(view().cancelRequested ? messages.finishCancel : messages.cancel)}
                      </Button>
                    </Show>
                  </div>
                }
              >
                <Show when={!view().cancelRequested && !cancellation()}>
                  <p role="status">
                    {_(busy() ? messages.working : retryable() ? messages.blocked : messages.unknown)}
                  </p>
                </Show>
              </Show>
              <Show when={pending() && view().canCancel && sourceCanDrive()}>
                <div class="organization-handoff-actions">
                  <Button
                    variant="ghost"
                    disabled={!actionable() || cancelling() || !!cancellation()}
                    onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => cancel(event.currentTarget)}
                  >
                    {_(view().cancelRequested ? messages.finishCancel : messages.cancel)}
                  </Button>
                </div>
              </Show>
              <Show when={cancellation()}>
                <p role="status">{_(cancelling() ? messages.working : messages.unknown)}</p>
              </Show>
              <Show when={!terminal(view())}>
                <Button variant="ghost" disabled={inspecting() || cancelling()} onClick={() => void check()}>
                  {_(messages.check)}
                </Button>
              </Show>
            </>
          )}
        </Show>
        <Show when={saved() && !state.view && !cleanup()}>
          <p role="status">{_(busy() ? messages.working : messages.unknown)}</p>
          <Button disabled={busy()} onClick={() => void check()}>
            {_(messages.check)}
          </Button>
        </Show>
        <Show when={cleanup()} keyed>
          {(handle) => (
            <OrganizationNativeCleanup
              handle={handle}
              heading={!!state.view}
              disabled={!cleanupAllowed(handle)}
              current={() => current() && cleanup() === handle}
              read={(requestID) => readCleanup(handle, requestID)}
              complete={() => cleanupComplete(handle)}
              failed={(error) => failure(error, false)}
            />
          )}
        </Show>
        <Show when={pending()?.kind === "permit" && !cancellation() && !state.view?.cancelRequested}>
          <p>{_(messages.retryPermitHint)}</p>
          <Button
            disabled={!allowed()}
            onClick={() => {
              const action = pending()
              if (action?.kind === "permit") void perform(action)
            }}
          >
            {_(messages.retryPermit)}
          </Button>
        </Show>
        <Show when={retryable() && pending()?.kind === "drive" && !cancellation() && !state.view?.cancelRequested}>
          <Button
            disabled={!allowed()}
            onClick={() => {
              const action = pending()
              if (action?.kind === "drive") void perform(action)
            }}
          >
            {_(messages.retryOperation)}
          </Button>
        </Show>
        <Show
          when={
            cancellation()?.kind === "drive" &&
            state.cancellationMachine?.operation === "cancel-source" &&
            state.cancellationMachine.state === "blocked"
          }
        >
          <Button
            disabled={!actionable() || cancelling()}
            onClick={() => {
              const action = cancellation()
              const id = saved()?.handoffID
              if (action?.kind === "drive" && id) void performCancellation(action, id, saved()?.cancellationNonce)
            }}
          >
            {_(messages.retryOperation)}
          </Button>
        </Show>
        <Show when={state.history.length || historyCursor()}>
          <div class="organization-handoff-history">
            <h3>{_(messages.history)}</h3>
            <p>{_(messages.historyHint)}</p>
            <For each={state.history}>
              {(view) => (
                <Button
                  variant="ghost"
                  disabled={busy() || cancelling() || inspecting() || !!pending() || !!cancellation()}
                  onClick={() => {
                    try {
                      retain(view.handoffID)
                      setState("view", undefined)
                      void refresh()
                        .then(() => runtime(view.targetRuntimeID))
                        .catch(failure)
                    } catch (error) {
                      failure(error)
                    }
                  }}
                >
                  {label(view.targetRuntimeID)} ·{" "}
                  {_(view.phase === "activation_permitted" ? messages.committed : messages[view.phase])}
                </Button>
              )}
            </For>
            <Show when={historyCursor()}>
              <Button disabled={busy()} onClick={() => void history(true)}>
                {_(common.more)}
              </Button>
            </Show>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
