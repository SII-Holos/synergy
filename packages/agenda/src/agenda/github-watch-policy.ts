import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
export namespace GithubWatchPolicy {
  export interface Value {
    enabled: boolean
    defaultIntervalMs?: number
  }

  type Reader = () => Promise<Value>
  const runtimeState = RuntimeContext.state(() => ({
    reader: undefined as Reader | undefined,
  }))

  export function register(value: Reader) {
    const instanceState = runtimeState()

    const previous = instanceState.reader
    instanceState.reader = value
    return () => {
      const instanceState = runtimeState()

      if (instanceState.reader === value) instanceState.reader = previous
    }
  }

  export async function read(): Promise<Value> {
    const instanceState = runtimeState()

    if (!instanceState.reader) throw new Error("GitHub watch policy is not registered in this runtime")
    return instanceState.reader()
  }
}
