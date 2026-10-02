import type { RolloutEvidenceContent } from "@ericsanchezok/synergy-sdk/client"

export class EvidencePages {
  private entries = new Map<number, RolloutEvidenceContent>()
  private version = ""
  size = 0
  constructor(readonly budget = 8 * 1024 * 1024) {}
  private bytes(page: RolloutEvidenceContent) {
    return Math.max(page.text.length * 2, (page.nextOffset ?? page.bytes) - page.offset)
  }
  put(page: RolloutEvidenceContent) {
    if (this.version && this.version !== page.contentVersion) throw new Error("Execution content version changed")
    this.version = page.contentVersion
    const previous = this.entries.get(page.offset)
    if (previous) {
      this.entries.delete(page.offset)
      this.size -= this.bytes(previous)
    }
    while (this.size + this.bytes(page) > this.budget && this.entries.size) {
      const [offset, value] = this.entries.entries().next().value!
      this.entries.delete(offset)
      this.size -= this.bytes(value)
    }
    if (this.bytes(page) > this.budget) throw new RangeError("Content page exceeds the reading budget")
    this.entries.set(page.offset, page)
    this.size += this.bytes(page)
  }
  get(offset: number) {
    return this.entries.get(offset)
  }
  touch(offset: number) {
    const page = this.entries.get(offset)
    if (page) {
      this.entries.delete(offset)
      this.entries.set(offset, page)
    }
  }
  delete(offset: number) {
    const page = this.entries.get(offset)
    if (page) {
      this.entries.delete(offset)
      this.size -= this.bytes(page)
    }
  }
  pages() {
    return [...this.entries.values()].sort((a, b) => a.offset - b.offset)
  }
  clear() {
    this.entries.clear()
    this.version = ""
    this.size = 0
  }
}
