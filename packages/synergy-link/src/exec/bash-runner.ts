import type { SynergyLinkBash } from "@ericsanchezok/synergy-link-protocol"
import { ProcessRegistry } from "./process-registry"
import type { ExecutionLease } from "../types"

export class BashRunner {
  constructor(private readonly processes: ProcessRegistry) {}

  async run(
    request: SynergyLinkBash.ExecutePayload,
    linkID: string,
    lease: ExecutionLease,
  ): Promise<SynergyLinkBash.Result> {
    return this.processes.executeBash(request, linkID, lease)
  }
}
