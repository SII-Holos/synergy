import { z } from "zod"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { StoreOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"

export namespace OrganizationRecoveryDatabase {
  export const Descriptor = z.strictObject({
    version: z.literal(1),
    backend: z.literal("postgres"),
    namespace: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  })
  export type Descriptor = z.infer<typeof Descriptor>

  function fail(message: string): never {
    throw new Error("Service native recovery database " + message)
  }
  function primary() {
    const handle = RuntimeContext.current().storage
    if (!handle || handle.store.options.readonly) fail("requires its writable original primary Store")
    return handle
  }
  export function capture(expected?: Extract<StoreOptions, { backend: "postgres" }>): Descriptor | undefined {
    const options = primary().store.options
    if (
      expected &&
      (options.backend !== "postgres" || options.namespace !== expected.namespace || options.url !== expected.url)
    )
      fail("declared composition differs from its actual primary Store")
    if (options.backend === "sqlite") return
    return Descriptor.parse({ version: 1, backend: "postgres", namespace: options.namespace })
  }
  export function verify(value: Descriptor | undefined, requirements: readonly string[]) {
    if (value) Descriptor.parse(value)
    const selected = requirements.filter((requirement) => requirement === "database-target")
    if (selected.length !== Number(value !== undefined)) fail("descriptor and reconstruction requirement disagree")
  }
  export function assertSource(value: Descriptor | undefined) {
    const current = capture()
    if (JSON.stringify(current) !== JSON.stringify(value)) fail("source backend or namespace changed")
  }
  export function assertTarget(value: Descriptor | undefined) {
    const handle = primary()
    if (Storage.current().store !== handle.store) fail("requires the actual target primary Store")
    assertOptions(value, handle.store.options)
  }
  export function assertOptions(
    value: Descriptor | undefined,
    options: Pick<StoreOptions, "backend" | "namespace" | "readonly">,
  ) {
    const selected = value && Descriptor.parse(value)
    Descriptor.shape.namespace.parse(options.namespace)
    if (options.readonly) fail("target requires writable storage")
    if (options.backend !== (selected?.backend ?? "sqlite")) fail("backend must match its archived database backend")
    if (selected && options.namespace === selected.namespace) fail("target requires a fresh PostgreSQL namespace")
  }
}
