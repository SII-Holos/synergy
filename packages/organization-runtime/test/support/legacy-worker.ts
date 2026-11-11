import { HomeOwnership } from "@ericsanchezok/synergy-harness/lifecycle/home-ownership"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { version } from "../../package.json" with { type: "json" }
import { RuntimeIdentity, runtimeIdentityDigest } from "../../src/home"

export const metadata = { id: "organization-runtime", version, apiVersion: 1 } as const

export function registerWorker() {
  const env = RuntimeContext.current().host.env
  const identity = RuntimeIdentity.parse(JSON.parse(env.SYNERGY_MEMBER_IDENTITY ?? ""))
  HomeOwnership.select({
    owner: "organization-runtime",
    identity: runtimeIdentityDigest(identity),
    ...(env.SYNERGY_LEGACY_READER === "maintenance" ? { readerContract: "purpose-bound-maintenance-v1" } : {}),
  })
}
