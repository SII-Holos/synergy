import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { NativeNamespaceIdentity } from "@ericsanchezok/synergy-harness/lifecycle/namespace-identity"
import { RuntimeIdentity, readRuntimeHome } from "./home"
import { readRuntimeRegistration } from "./registration"
import { MemberHomeError } from "./record"

export function registerOrganizationNamespaceIdentity(input: RuntimeIdentity) {
  const identity = Object.freeze(RuntimeIdentity.parse(input))
  NativeNamespaceIdentity.register({
    owner: "organization-runtime",
    async read() {
      const context = RuntimeContext.current()
      const home = await readRuntimeHome(context.host.home, identity)
      if (home.root !== context.host.root)
        throw new MemberHomeError("Runtime namespace does not match its enrolled Home")
      const registration = await readRuntimeRegistration(home.home, identity)
      if (!registration) throw new MemberHomeError("Runtime namespace has no enrolled identity")
      return {
        kind: registration.runtimeKind,
        orgID: registration.orgID,
        deploymentIncarnation: registration.deploymentIncarnation,
        runtimeID: registration.runtimeID,
        publicKey: registration.publicKey,
      }
    },
  })
}
