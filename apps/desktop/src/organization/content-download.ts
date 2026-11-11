import { createHash } from "node:crypto"
import {
  OrganizationDesktop as Desktop,
  OrganizationReadProtocol as Read,
  OrganizationReadContent,
} from "@ericsanchezok/synergy-organization-protocol"

class PreparingContent extends Error {
  constructor(readonly result: Extract<Read.Result,{operation:"partContent";state:"preparing"}>) {
    super("Native content is preparing")
  }
}
function preparation(result: Extract<Read.Result,{operation:"partContent";state:"preparing"}>):Desktop.ContentDownloadOutcome {
  return {kind:"preparing",version:result.version,progress:result.progress}
}
export async function downloadOrganizationContent(input: Desktop.ContentDownload, options: {
  signal:AbortSignal
  read:(query:Read.Query,signal:AbortSignal) => Promise<Read.Result>
  save:(fileName:string,write:(append:(chunk:Uint8Array) => Promise<void>) => Promise<number>) => Promise<Desktop.DownloadResult>
}):Promise<Desktop.ContentDownloadOutcome> {
  const request = Desktop.ContentDownload.parse(input)
  if (request.query.operation !== "partContent" || request.reference.kind !== "native") throw new Error("Invalid native content target")
  const query = request.query
  const reference = request.reference
  options.signal.throwIfAborted()
  const firstQuery = {...query,length:1}
  const first = Read.Result.parse(await options.read(firstQuery,options.signal))
  options.signal.throwIfAborted()
  if (!Read.matches(firstQuery,first,request.binding) || first.operation !== "partContent") throw new Error("Native content identity changed")
  if (first.state === "preparing") return preparation(first)
  const part = first.value.part
  const fields = part.type === "tool" ? [part.input,part.output,part.error] : part.type === "text" || part.type === "reasoning" || part.type === "notice" ? [part.content] : []
  if (!fields.some((field) => field?.kind === "native" && field.field === reference.field && field.version === reference.version && field.bytes === reference.bytes && field.sha256 === reference.sha256 && field.original === reference.original)) throw new Error("Native content descriptor changed")
  try {
    const result = await options.save(request.fileName,async (append) => {
      const hash = createHash("sha256")
      const result = await OrganizationReadContent.stream({
        rootSessionID:query.rootSessionID,sourceSessionID:query.sourceSessionID,messageID:query.messageID,partID:query.partID,
        reference,expectedBinding:request.binding,signal:options.signal,read:options.read,append,
        hash:{update:(bytes) => hash.update(bytes),digest:() => hash.digest("hex")},
      })
      if (result.state === "preparing") throw new PreparingContent(result.pending)
      return result.bytes
    })
    options.signal.throwIfAborted()
    return {kind:"result",result,original:reference.original}
  } catch (error) {
    if (error instanceof PreparingContent) return preparation(error.result)
    throw error
  }
}
