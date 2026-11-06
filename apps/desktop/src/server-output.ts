import { StringDecoder } from "node:string_decoder"

export class ManagedServerOutput {
  private readonly stdout = new StringDecoder("utf8")
  private readonly stderr = new StringDecoder("utf8")
  private tail = ""
  private errorTail = ""

  constructor(private readonly onStdout: (text: string) => void) {}

  receive(stream: "stdout" | "stderr", chunk: Buffer) {
    const text = this[stream].write(chunk)
    this.tail = this.bound(this.tail + text)
    if (stream === "stdout") this.onStdout(text)
    else this.errorTail = this.bound(this.errorTail + text)
  }

  get details() {
    return this.tail
  }

  get portConflict() {
    return this.errorTail.includes("Failed to start server on port")
  }

  private bound(text: string) {
    const tail = text.slice(-8192)
    return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail
  }
}
