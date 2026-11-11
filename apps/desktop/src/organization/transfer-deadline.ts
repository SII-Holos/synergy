export function downloadIdleDeadline(parent:AbortSignal,milliseconds=30_000,expired?:() => void) {
  const controller = new AbortController()
  const signal = AbortSignal.any([parent,controller.signal])
  let timer:ReturnType<typeof setTimeout>|undefined
  const dispose = () => {clearTimeout(timer);signal.removeEventListener("abort",dispose)}
  const renew = () => {
    signal.throwIfAborted()
    clearTimeout(timer)
    timer=setTimeout(() => {controller.abort(new DOMException("Download stopped making progress","TimeoutError"));expired?.()},milliseconds)
  }
  signal.addEventListener("abort",dispose,{once:true})
  renew()
  return {
    signal,
    progress(bytes:number) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Transfer did not advance")
      renew()
    },
    dispose,
  }
}
