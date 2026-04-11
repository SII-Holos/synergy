import type { MetaProtocolBash } from "@ericsanchezok/meta-protocol"
import { ProcessRegistry } from "./process-registry"

export class BashRunner {
  constructor(private readonly processes: ProcessRegistry) {}

  async run(request: MetaProtocolBash.ExecutePayload, envID: string): Promise<MetaProtocolBash.Result> {
    return this.processes.executeBash(request, envID)
  }
}
