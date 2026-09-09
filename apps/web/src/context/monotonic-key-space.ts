export class MonotonicKeySpace {
  private readonly values = new Map<string, number>()
  private next = 1

  get(key: string): number {
    return this.values.get(key) ?? 0
  }

  ensure(key: string): number {
    const existing = this.values.get(key)
    if (existing !== undefined) return existing
    const created = this.next++
    this.values.set(key, created)
    return created
  }

  allocate(key: string): number {
    const created = this.next++
    this.values.set(key, created)
    return created
  }

  set(key: string, value: number) {
    this.values.set(key, value)
  }

  delete(key: string) {
    this.values.delete(key)
  }

  deletePrefix(prefix: string) {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key)
    }
  }

  *entries(): IterableIterator<[string, number]> {
    yield* this.values.entries()
  }
}
