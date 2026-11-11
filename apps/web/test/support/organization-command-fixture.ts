export const organizationCommandFixtureSource = `
const commandTransfers = new Map()
async function commandStream(frame) {
  const progress = nextOffset => ({ok:true,value:{kind:"progress",requestID:frame.requestID,nextOffset}})
  if(frame.type === "begin") {
    commandTransfers.set(frame.requestID,{begin:frame,chunks:[],offset:0})
    return progress(0)
  }
  const pending = commandTransfers.get(frame.requestID)
  if(!pending || pending.begin.connectionID !== frame.connectionID) return {ok:false,error:{code:"invalid_request"}}
  if(frame.type === "chunk") {
    if(frame.offset !== pending.offset) return {ok:false,error:{code:"invalid_request"}}
    const bytes = Uint8Array.from(atob(frame.data.replaceAll("-","+").replaceAll("_","/")), char => char.charCodeAt(0))
    pending.chunks.push(bytes)
    pending.offset += bytes.byteLength
    return progress(pending.offset)
  }
  commandTransfers.delete(frame.requestID)
  if(pending.offset !== pending.begin.bytes) return {ok:false,error:{code:"invalid_request"}}
  const bytes = new Uint8Array(pending.offset)
  let offset = 0
  for(const chunk of pending.chunks){bytes.set(chunk,offset);offset += chunk.byteLength}
  const payload = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))
  const operation = pending.begin.operation
  const result = await window.hostRequest({requestID:frame.requestID,connectionID:frame.connectionID,method:"POST",path:"/org/v1/sessions/" + pending.begin.header.sessionID + (operation === "input" ? "/commands/input" : "/interactions/reply"),body:JSON.stringify({...pending.begin.header,[operation === "input" ? "input" : "decision"]:payload})})
  if(!result.ok) return result
  return {ok:true,value:{kind:"response",requestID:frame.requestID,response:result.value}}
}
`
