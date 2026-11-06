export type QuestionSnapshotToken = { scopeID: string; generation: number; revision: number }

export class QuestionSnapshotGate {
  private generation = 0
  private readonly revisions = new Map<string, number>()

  capture(scopeID: string): QuestionSnapshotToken {
    const revision = (this.revisions.get(scopeID) ?? 0) + 1
    this.revisions.set(scopeID, revision)
    return { scopeID, generation: this.generation, revision }
  }

  accept(token: QuestionSnapshotToken) {
    return token.generation === this.generation && token.revision === this.revisions.get(token.scopeID)
  }

  reset() {
    this.generation++
    this.revisions.clear()
  }
}
