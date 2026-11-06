export function testResources() {
  const releases: Array<{ name: string; release: () => unknown | Promise<unknown> }> = []
  let closed: Promise<void> | undefined
  const close = () => {
    closed ??= Promise.resolve().then(async () => {
      const failures: Error[] = []
      for (const resource of releases.reverse()) {
        try {
          await resource.release()
        } catch (cause) {
          failures.push(new Error(`Fixture cleanup failed: ${resource.name}`, { cause }))
        }
      }
      if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join("; "))
    })
    return closed
  }
  return {
    defer(name: string, release: () => unknown | Promise<unknown>) {
      if (closed) throw new Error("Fixture resources already closed")
      releases.push({ name, release })
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
