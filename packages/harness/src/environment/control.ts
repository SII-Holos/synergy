import { z } from "zod"
import { Environment } from "."
import { EnvironmentExecution } from "./execution"
import { EnvironmentSchema } from "./schema"
import { WorkspaceOperations } from "../workspace/operations"
import { Storage } from "../storage/storage"

export namespace EnvironmentControl {
  export const Activity = z
    .object({
      environment: Environment.Info,
      uses: EnvironmentSchema.Use.array(),
      executions: EnvironmentExecution.Info.array(),
      files: WorkspaceOperations.Summary.array(),
    })
    .meta({ ref: "EnvironmentActivity" })
  export type Selection = { environmentID: string; scopeID: string }

  export async function activity(input: Selection): Promise<z.infer<typeof Activity>> {
    const environment = await Environment.get(input.environmentID, input.scopeID)
    const [uses, executions, files] = await Promise.all([
      Environment.uses(environment.id),
      EnvironmentExecution.listActive(input.scopeID),
      WorkspaceOperations.listActive(input.scopeID),
    ])
    return {
      environment,
      uses,
      executions: executions.filter((operation) => operation.target.environmentID === environment.id),
      files: files.filter((operation) => operation.target?.environmentID === environment.id),
    }
  }

  async function execution(input: Selection & { operationID: string }) {
    await Environment.get(input.environmentID, input.scopeID)
    const info = await EnvironmentExecution.get(input.operationID, input.scopeID)
    if (info.target.environmentID !== input.environmentID)
      throw new Storage.NotFoundError({ message: "Execution does not belong to this Environment" })
    return info
  }

  export async function recoverExecution(input: Selection & { operationID: string }) {
    await execution(input)
    await Environment.reconcile(input.environmentID, input.scopeID)
    const info = await EnvironmentExecution.reconcile(input.operationID, input.scopeID)
    return ["exited", "unsaved", "saved"].includes(info.state)
      ? EnvironmentExecution.complete(info.id, input.scopeID)
      : info
  }

  export async function cancelExecution(input: Selection & { operationID: string }) {
    await execution(input)
    await EnvironmentExecution.cancel(input.operationID, input.scopeID)
    return EnvironmentExecution.get(input.operationID, input.scopeID)
  }

  export async function recoverFile(input: Selection & { operationID: string }) {
    await Environment.get(input.environmentID, input.scopeID)
    const operation = await WorkspaceOperations.get(input.operationID, input.scopeID)
    if (operation.target?.environmentID !== input.environmentID)
      throw new Storage.NotFoundError({ message: "File operation does not belong to this Environment" })
    await Environment.reconcile(input.environmentID, input.scopeID)
    return WorkspaceOperations.Summary.parse(await WorkspaceOperations.reconcile(operation.id, input.scopeID))
  }
}
