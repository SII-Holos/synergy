import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { EnvironmentOrigin } from "./origin"
import { EnvironmentUseOwnershipSchema as Schema } from "./use-ownership-schema"
import type { EnvironmentSchema } from "./schema"

export namespace EnvironmentUseOwnership {
  export const Info = Schema.Info
  export type Info = Schema.Info
  export type OwnerID = "execution" | "workspace-mount" | "workspace-operation"
  export type Phase = "admission" | "retain" | "release"
  export const Selector = z.strictObject({
    scopeID: z.string().min(1),
    environmentID: z.string().min(1),
    useID: z.string().min(1),
  })
  export type Selector = z.infer<typeof Selector>
  const brand = Symbol("native-environment-use-owner")
  export interface Token {
    readonly [brand]: true
  }
  export type Admission = EnvironmentOrigin.Token | Token
  export interface Proof {
    selector: Selector
    ownership: Schema.Current
    verify(target?: Readonly<EnvironmentSchema.Target>): Promise<void>
  }
  export interface Inspection {
    origin?: Readonly<EnvironmentOrigin.Info>
  }
  export interface Contribution<Input> {
    capture(input: Input, phase: Phase): Proof
    inspect(
      ownership: Schema.Resource,
      selector: Readonly<Selector>,
      target: Readonly<EnvironmentSchema.Target>,
    ): Promise<Inspection | void>
  }
  interface Evidence {
    phase: Phase
    owner: OwnerID
    selector: Readonly<Selector>
    ownership: Readonly<Schema.Current>
    current(): void
    verify: Proof["verify"]
  }
  const evidence = new WeakMap<object, Evidence>()
  const owners = RuntimeContext.state(() => new Map<OwnerID, Pick<Contribution<never>, "inspect">>())

  function family(owner: OwnerID, info: Schema.Current) {
    return owner === "execution"
      ? ["execution-preparation", "execution"].includes(info.kind)
      : owner === "workspace-mount"
        ? ["workspace-attachment", "workspace-mount"].includes(info.kind)
        : info.kind === "workspace-operation"
  }
  function owning(info: Schema.Resource): OwnerID {
    return info.kind === "execution" || info.kind === "execution-preparation"
      ? "execution"
      : info.kind === "workspace-mount" || info.kind === "workspace-attachment"
        ? "workspace-mount"
        : "workspace-operation"
  }
  export function captureStorage() {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const objects = artifactObjects && {
      blobs: artifactObjects.blobs,
      writerID: artifactObjects.writerID,
      now: artifactObjects.now,
    }
    return () => {
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== objects?.blobs ||
        artifactObjects?.writerID !== objects?.writerID ||
        artifactObjects?.now !== objects?.now
      )
        throw new Error("Environment Use belongs to another Runtime or Storage configuration")
    }
  }

  export function register<Input>(owner: OwnerID, contribution: Contribution<Input>) {
    RuntimeContext.assertCompositionOpen("Environment Use owners")
    owner = z.enum(["execution", "workspace-mount", "workspace-operation"]).parse(owner)
    if (owners().has(owner)) throw new Error("Environment Use owner is already registered")
    const runtime = RuntimeContext.current()
    const capture = contribution.capture.bind(contribution)
    owners().set(owner, { inspect: contribution.inspect.bind(contribution) })
    const mint = (input: Input, phase: Phase): Token => {
      if (RuntimeContext.current() !== runtime) throw new Error("Environment Use owner belongs to another Runtime")
      const current = captureStorage()
      const proof = capture(input, phase)
      const selector = Object.freeze(Selector.parse(proof.selector))
      const ownership = Info.parse(proof.ownership)
      if (ownership.kind === "legacy-unknown" || !family(owner, ownership))
        throw new Error("Environment Use proof belongs to another canonical owner")
      current()
      const token: Token = Object.freeze({ [brand]: true as const })
      evidence.set(token, {
        phase,
        owner,
        selector,
        ownership: Object.freeze(ownership),
        current,
        verify: proof.verify.bind(proof),
      })
      return token
    }
    return Object.freeze({
      admission: (input: Input) => mint(input, "admission"),
      retention: (input: Input) => mint(input, "retain"),
      retirement: (input: Input) => mint(input, "release"),
    })
  }

  function matches(first: Readonly<Selector>, second: Readonly<Selector>) {
    return (
      first.scopeID === second.scopeID && first.environmentID === second.environmentID && first.useID === second.useID
    )
  }
  export async function authorize(
    input: Admission,
    phase: Phase,
    value: Selector,
    target?: EnvironmentSchema.Target,
  ): Promise<Schema.Current> {
    const selector = Selector.parse(value)
    target = target && { ...target }
    if (target && target.environmentID !== selector.environmentID)
      throw new Error("Environment Use target differs from its selected Environment")
    const captured = evidence.get(input)
    if (!captured) {
      if (phase !== "admission") throw new Error("Retained Environment Use requires its canonical owner capability")
      const origin = EnvironmentOrigin.selected(input)
      if (origin !== input) throw new Error("Environment Use admission requires an opaque original origin")
      await EnvironmentOrigin.assertAdmission(origin, selector)
      return { kind: "admission", origin: origin.value }
    }
    captured.current()
    if (captured.phase !== phase || !matches(captured.selector, selector))
      throw new Error("Environment Use proof has another phase or selector")
    await captured.verify(target)
    captured.current()
    const ownership = Info.parse(captured.ownership)
    if (ownership.kind === "legacy-unknown") throw new Error("Current Environment Use cannot acquire unknown ownership")
    return ownership
  }

  export function assertCurrent(input: Admission) {
    const captured = evidence.get(input)
    if (captured) return captured.current()
    const origin = EnvironmentOrigin.selected(input)
    if (origin !== input) throw new Error("Environment Use requires its original opaque origin")
    origin.assertCurrent()
  }

  export function request<T>(input: Admission, body: () => Promise<T>): Promise<T> {
    const captured = evidence.get(input)
    if (captured) {
      captured.current()
      return body()
    }
    const origin = EnvironmentOrigin.selected(input)
    if (origin !== input) throw new Error("Environment Use requires its original opaque origin")
    return EnvironmentOrigin.request(origin, body)
  }

  export function transition(previous: Info, next: Info) {
    if (previous.kind === "execution-preparation" && next.kind === "execution")
      return previous.scopeID === next.scopeID && previous.operationID === next.operationID
    if (previous.kind === "workspace-attachment" && next.kind === "workspace-mount")
      return (
        previous.scopeID === next.scopeID &&
        previous.workspaceID === next.workspaceID &&
        previous.bindingGeneration === next.bindingGeneration
      )
    return (
      previous.kind !== "legacy-unknown" &&
      previous.kind !== "admission" &&
      JSON.stringify(previous) === JSON.stringify(next)
    )
  }

  export async function inspect(use: EnvironmentSchema.Use, scopeID: string) {
    const info = use.ownership
    if (info.kind === "legacy-unknown") throw new Error("Environment Use has unknown historical ownership")
    if (info.kind === "admission") {
      if (info.origin.kind === "session" && info.origin.scopeID !== scopeID)
        throw new Error("Environment Use origin belongs to another Scope")
      return { origin: info.origin }
    }
    const owner = owners().get(owning(info))
    if (!owner) throw new Error("Environment Use requires its registered canonical owner")
    const current = captureStorage()
    const inspected = await owner.inspect(
      info,
      { scopeID, environmentID: use.target.environmentID, useID: use.id },
      use.target,
    )
    current()
    return inspected?.origin ? { origin: EnvironmentOrigin.Info.parse(inspected.origin) } : undefined
  }
}
