import { RuntimeContext } from "../lifecycle/context"
import { Storage } from "../storage/storage"
import { EnvironmentOriginSchema as Schema } from "./origin-schema"

export namespace EnvironmentOrigin {
  export const Session = Schema.Session
  export type Session = Schema.Session
  export const Current = Schema.Current
  export type Current = Schema.Current
  export const Host = Schema.Host
  export type Host = Extract<Current, { kind: "host" }>
  export const Info = Schema.Info
  export type Info = Schema.Info
  const originBrand: unique symbol = Symbol("Environment host origin")
  export interface Token {
    readonly [originBrand]: true
  }
  export type Input = Session | Token
  export interface Captured extends Token {
    readonly value: Readonly<Current>
    assertCurrent(): void
  }
  export interface Target {
    scopeID: string
    environmentID?: string
  }
  interface SessionAuthority {
    admission(origin: Readonly<Session>, target: Readonly<Target>): Promise<void>
    mutation(origin: Readonly<Session>): Promise<void>
  }
  export interface HostAuthority {
    admission(origin: Readonly<Host>, target: Readonly<Target>): Promise<void>
    mutation(origin: Readonly<Host>): Promise<void>
  }
  interface Request {
    origin: Captured
    store: ReturnType<typeof Storage.current>["store"]
    artifactDirectory: string
    artifactObjects: ReturnType<typeof Storage.current>["artifactObjects"]
    done: Promise<void>
  }
  const state = RuntimeContext.state(() => ({
    authority: undefined as SessionAuthority | undefined,
    hosts: new Map<string, HostAuthority | undefined>(),
    requests: new Set<Request>(),
  }))
  const captures = new WeakMap<object, Captured>()

  export function registerSessionAuthority(authority: SessionAuthority) {
    RuntimeContext.assertCompositionOpen("Environment Session origins")
    if (state().authority) throw new Error("Environment Session origins are already registered")
    state().authority = authority
  }

  function capture(value: Captured["value"]): Captured {
    const runtime = RuntimeContext.current()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const objectConfig = artifactObjects && {
      blobs: artifactObjects.blobs,
      writerID: artifactObjects.writerID,
      now: artifactObjects.now,
    }
    const captured: Captured = Object.freeze({
      [originBrand]: true as const,
      value: Object.freeze(value),
      assertCurrent() {
        const current = Storage.current()
        if (
          RuntimeContext.current() !== runtime ||
          current.store !== store ||
          JSON.stringify(store.options) !== namespace ||
          current.artifactDirectory !== artifactDirectory ||
          current.artifactObjects !== artifactObjects ||
          artifactObjects?.blobs !== objectConfig?.blobs ||
          artifactObjects?.writerID !== objectConfig?.writerID ||
          artifactObjects?.now !== objectConfig?.now
        )
          throw new Error("Environment origin belongs to another Runtime or Storage handle")
      },
    })
    captures.set(captured, captured)
    return captured
  }

  export function registerHost(owner: string, authority?: HostAuthority) {
    RuntimeContext.assertCompositionOpen("Environment host origins")
    owner = Schema.Host.shape.owner.parse(owner)
    const runtime = RuntimeContext.current()
    if (state().hosts.has(owner)) throw new Error("Environment host origin is already registered")
    state().hosts.set(
      owner,
      authority &&
        Object.freeze({
          admission: authority.admission.bind(authority),
          mutation: authority.mutation.bind(authority),
        }),
    )
    return Object.freeze({
      capture(invocationID: string): Token {
        if (RuntimeContext.current() !== runtime || !state().hosts.has(owner))
          throw new Error("Environment host origin belongs to another Runtime")
        return capture(Schema.Host.parse({ kind: "host", owner, invocationID }))
      },
    })
  }

  export function selected(input: unknown): Captured {
    if (input && typeof input === "object" && originBrand in input) {
      const captured = captures.get(input)
      if (!captured) throw new Error("Environment origin has no registered owner")
      captured.assertCurrent()
      return captured
    }
    return capture(Session.parse(input))
  }

  export async function request<T>(origin: Captured, body: () => Promise<T>): Promise<T> {
    origin.assertCurrent()
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const done = Promise.withResolvers<void>()
    const requests = state().requests
    const entry = { origin, store, artifactDirectory, artifactObjects, done: done.promise }
    requests.add(entry)
    try {
      return await body()
    } finally {
      requests.delete(entry)
      done.resolve()
    }
  }

  export function hasRequests() {
    return state().requests.size > 0
  }

  export function sessionRequests(scopeID: string, sessionID: string): readonly Promise<void>[] {
    const current = Storage.current()
    return [...state().requests]
      .filter(
        (entry) =>
          entry.store === current.store &&
          entry.artifactDirectory === current.artifactDirectory &&
          entry.artifactObjects === current.artifactObjects &&
          entry.origin.value.kind === "session" &&
          entry.origin.value.scopeID === scopeID &&
          entry.origin.value.sessionID === sessionID,
      )
      .map((entry) => entry.done)
  }

  export async function assertAdmission(origin: Captured, target: Readonly<Target>) {
    target = Object.freeze({ ...target })
    origin.assertCurrent()
    if (origin.value.kind === "session") {
      const authority = state().authority
      if (!authority) throw new Error("Environment Session origin authority is unavailable")
      if (origin.value.scopeID !== target.scopeID) throw new Error("Environment origin belongs to another Scope")
      await authority.admission(origin.value, target)
    } else {
      const authority = state().hosts.get(origin.value.owner)
      if (authority) await authority.admission(origin.value, target)
    }
    origin.assertCurrent()
  }

  export async function assertMutation(origin: Readonly<Info>) {
    if (origin.kind === "host") {
      const authority = state().hosts.get(origin.owner)
      if (authority) await authority.mutation(Object.freeze(Host.parse(origin)))
      return
    }
    if (origin.kind !== "session") return
    const authority = state().authority
    if (!authority) throw new Error("Environment Session origin authority is unavailable")
    await authority.mutation(origin)
  }
}
