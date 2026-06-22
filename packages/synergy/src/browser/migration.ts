import { BrowserOwner } from "./owner.js"

export namespace BrowserMigration {
  export interface Result {
    ownerKey: string
    changed: boolean
    version: number
  }

  export async function run(owner: BrowserOwner.Info): Promise<Result> {
    return {
      ownerKey: BrowserOwner.key(owner),
      changed: false,
      version: 1,
    }
  }
}
