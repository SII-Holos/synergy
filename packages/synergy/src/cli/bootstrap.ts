import { InstanceBootstrap } from "../project/bootstrap"
import { Instance } from "../scope/instance"
import { Scope } from "@/scope"

export async function bootstrap<T>(directory: string, cb: () => Promise<T>) {
  return Instance.provide({
    scope: (await Scope.fromDirectory(directory)).scope,
    init: InstanceBootstrap,
    fn: async () => {
      try {
        const result = await cb()
        return result
      } finally {
        await Instance.dispose()
      }
    },
  })
}
