export namespace GithubWatchPolicy {
  export interface Value {
    enabled: boolean
    defaultIntervalMs?: number
  }

  type Reader = () => Promise<Value>
  let reader: Reader | undefined

  export function register(value: Reader) {
    const previous = reader
    reader = value
    return () => {
      if (reader === value) reader = previous
    }
  }

  export async function read(): Promise<Value> {
    if (!reader) throw new Error("GitHub watch policy is not registered in this runtime")
    return reader()
  }
}
