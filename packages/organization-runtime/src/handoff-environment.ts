import { OrganizationHandoffProtocol as Handoff } from "@ericsanchezok/synergy-organization-protocol"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"
import { SessionTransferEnvironments as Environments } from "@ericsanchezok/synergy-harness/session/transfer"
import type { Session } from "@ericsanchezok/synergy-harness/session"
import { withMemberHandoffPlan } from "./execution-source"
import { OrganizationRuntimeError } from "./error"

export namespace OrganizationHandoffEnvironments {
  type NativeSelection = Parameters<Environments.MappingSource["capture"]>[1]
  type Mapping = NonNullable<ReturnType<Environments.MappingSource["capture"]>>["mapping"]
  interface Frame {
    plan: Readonly<Handoff.MachinePlan>
    role: "source" | "target"
    signal: AbortSignal
    open: boolean
    assert(): void
  }
  const frames = RuntimeContext.createAsyncContext<Frame>()
  const state = RuntimeContext.state(() => ({ registered: false }))
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  function fail(message: string): never {
    throw new OrganizationRuntimeError({
      code: "HANDOFF_BLOCKED",
      message,
      outcome: "not_dispatched",
      retryable: false,
    })
  }
  function current(role?: Frame["role"]) {
    const frame = frames.getStore()
    if (!frame || !frame.open || (role && role !== frame.role))
      fail("Environment mapping has no original enrolled handoff callback")
    frame.assert()
    if (!frame.plan.environmentPlan) fail("Environment mapping has no explicit accepted plan")
    return { frame, environment: frame.plan.environmentPlan }
  }
  function sourceMatches(
    sessionID: string,
    rootSessionID: string,
    expected: Handoff.EnvironmentSourceSelection,
    selected: NativeSelection,
  ) {
    if (expected.kind === "organization") return
    if (expected.kind === "none") {
      if (selected) fail("The original source acquired another native Environment selection")
      return
    }
    if (
      !selected ||
      selected.provider !== expected.provider ||
      !same(selected.descriptor, expected.descriptor) ||
      (sessionID === rootSessionID &&
        (selected.environmentID !== expected.environmentID || selected.generation !== expected.generation))
    )
      fail("Environment mapping changed its original native source descriptor")
  }
  function targetMatches(expected: Handoff.EnvironmentTargetSelection, selected: NativeSelection) {
    if (expected.kind !== "native") {
      if (selected) fail("A logical Environment cannot borrow a destination native selection")
      return
    }
    if (
      !selected ||
      selected.provider !== expected.provider ||
      !same(selected.descriptor, expected.descriptor) ||
      (expected.reference &&
        (selected.environmentID !== expected.reference.environmentID ||
          selected.generation !== expected.reference.generation))
    )
      fail("Environment mapping changed its actual native destination")
  }
  function nativeReference(selected: NonNullable<NativeSelection>) {
    return Handoff.NativeEnvironmentSelection.parse({
      kind: "native",
      environmentID: selected.environmentID,
      provider: selected.provider,
      generation: selected.generation,
      descriptor: selected.descriptor,
    })
  }
  function mapping(plan: Readonly<Handoff.MachinePlan>): Mapping {
    const environment = plan.environmentPlan
    if (!environment) fail("Environment mapping has no explicit accepted plan")
    return {
      version: 1,
      provider: "organization",
      hash: environment.hash,
      source: environment.mapping.source,
      target: environment.mapping.target,
    }
  }
  export function assertPlan(plan: Readonly<Handoff.MachinePlan>, role: Frame["role"]) {
    const { frame } = current(role)
    if (!same(frame.plan, plan)) fail("Environment mapping changed its original authorized machine plan")
  }
  export function register() {
    Environments.registerMappingSource("organization", {
      applies(session) {
        const frame = frames.getStore()
        return (
          !!frame?.plan.environmentPlan &&
          frame.role === "source" &&
          session.scope.id === frame.plan.sourceBinding.projectID
        )
      },
      capture(context, selected) {
        const { frame, environment } = current("source")
        if (
          context.rootSessionID !== frame.plan.sessionID ||
          context.handoffID !== frame.plan.handoffID ||
          context.session.scope.id !== frame.plan.sourceBinding.projectID
        )
          fail("Environment capture belongs to another original source cohort")
        sourceMatches(context.session.id, context.rootSessionID, environment.mapping.source, selected)
        return { mapping: mapping(frame.plan), assert: frame.assert }
      },
      target(context, source, selected) {
        const { frame, environment } = current("target")
        if (
          context.rootSessionID !== frame.plan.sessionID ||
          context.handoffID !== frame.plan.handoffID ||
          context.session.scope.id !== frame.plan.sourceBinding.projectID ||
          source.sessionID !== context.session.id ||
          source.scopeID !== context.session.scope.id ||
          source.rootSessionID !== context.rootSessionID ||
          source.handoffID !== context.handoffID ||
          !same(source.mapping, mapping(frame.plan)) ||
          context.mapping.environmentMappingHash !== environment.hash
        )
          fail("Environment publication has another original signed mapping")
        sourceMatches(source.sessionID, source.rootSessionID, environment.mapping.source, source.selected)
        targetMatches(environment.mapping.target, selected)
        const preparedSelection = Handoff.NativeEnvironmentSelection.nullable().safeParse(
          context.mapping.environmentSelection,
        )
        if (!preparedSelection.success || !same(preparedSelection.data, selected ? nativeReference(selected) : null))
          fail("The prepared Environment mapping changed its actual native selection")
        return frame.assert
      },
    })
    state().registered = true
  }
  export async function withPlan<T>(
    value: Handoff.SignedMachinePlan,
    signal: AbortSignal,
    body: () => Promise<T>,
  ): Promise<T> {
    const authorization = Handoff.SignedMachinePlan.parse(value)
    if (!authorization.plan.environmentPlan) return body()
    if (!state().registered) fail("The Runtime did not register its original Environment mapping owner")
    return withMemberHandoffPlan(authorization, signal, async (plan, assert) => {
      const environment = plan.environmentPlan,
        workspace = plan.workspacePlan
      if (!environment || !workspace || !plan.mappingPlanHash)
        fail("Explicit Environment mapping requires its complete original plan")
      const [environmentHash, completeHash] = await Promise.all([
        Handoff.environmentMappingHash(environment.mapping),
        Handoff.planHash(workspace.mapping, environment.mapping),
      ])
      assert()
      if (environmentHash !== environment.hash || completeHash !== plan.mappingPlanHash)
        fail("Environment mapping changed its original consent hash")
      const frame: Frame = {
        plan,
        role: Handoff.machineRole(plan.operation),
        signal,
        open: true,
        assert() {
          assert()
          if (!frame.open || frames.getStore() !== frame) fail("The original Environment mapping callback has ended")
        },
      }
      try {
        return await frames.run(frame, body)
      } finally {
        frame.open = false
      }
    })
  }
  export async function targetMapping(session: Readonly<Session.Info>) {
    const { frame, environment } = current("target")
    if (session.scope.id !== frame.plan.sourceBinding.projectID)
      fail("Native Environment mapping belongs to another original Scope")
    const choice = environment.mapping.target
    if (choice.kind !== "native")
      return { environmentID: null, environmentMappingHash: environment.hash, environmentSelection: null }
    let selected: Awaited<ReturnType<typeof Environments.nativeSelection>>
    if (choice.reference) {
      selected = await Environments.nativeSelection({
        environmentID: choice.reference.environmentID,
        scopeID: session.scope.id,
        signal: frame.signal,
      })
    } else {
      const provider = EnvironmentProviders.get(choice.provider)
      if (
        provider.ownership !== "borrowed" ||
        !provider.portableDescriptor ||
        !same(Handoff.NativeEnvironmentDescriptor.parse(provider.portableDescriptor({})), choice.descriptor)
      )
        fail("The destination has no matching registered native descriptor")
      const ownerID = JSON.stringify(["organization-handoff-environment", frame.plan.handoffID, session.id])
      let existing = await Environment.binding(session.scope.id, ownerID)
      frame.assert()
      if (!existing) {
        if (frame.plan.operation !== "prepare-target")
          fail("Native Environment activation requires its original prepared metadata")
        existing = await Storage.transaction(
          () => {
            frame.assert()
            return Environment.bind({ scopeID: session.scope.id, ownerID, provider: choice.provider, spec: {} })
          },
          { commitGuard: frame.assert },
        )
      }
      selected = await Environments.nativeSelection({
        environmentID: existing.id,
        scopeID: session.scope.id,
        signal: frame.signal,
      })
    }
    frame.assert()
    targetMatches(choice, selected)
    if (!selected) fail("The native destination has no original canonical selection")
    return {
      environmentID: selected.environmentID,
      environmentMappingHash: environment.hash,
      environmentSelection: nativeReference(selected),
    }
  }
}
