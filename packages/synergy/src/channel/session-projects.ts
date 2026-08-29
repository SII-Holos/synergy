import { SessionManagedProjects } from "../session/managed-projects"
import { ManagedProjectOwnership } from "./managed-project-ownership"

/**
 * S9c source inversion: the L1 session navigation index annotates managed
 * Project scopes through the SessionManagedProjects registry instead of
 * importing the channel product domain's ownership store. Loaded through
 * src/product-registration.ts.
 */
export function registerChannelSessionProjects() {
  SessionManagedProjects.register(() => ManagedProjectOwnership.listAll())
}
