import type { VoiceDictationRecorderHandlers, VoiceDictationStream } from "./voice-dictation-core"
import type { DecodedAudio } from "./voice-dictation-audio"

export async function decodeDictationAudio(arrayBuffer: ArrayBuffer): Promise<DecodedAudio> {
  const context = new OfflineAudioContext(1, 1, 48000)
  const buffer = await context.decodeAudioData(arrayBuffer)
  const channelData = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) channelData[i]! += data[i]! / buffer.numberOfChannels
  }
  return { channelData, sampleRate: buffer.sampleRate }
}

export function createDictationRecorder(
  stream: VoiceDictationStream,
  mimeType: string | undefined,
  handlers: VoiceDictationRecorderHandlers,
) {
  const recorder = new MediaRecorder(stream as MediaStream, mimeType ? { mimeType } : undefined)
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) handlers.onData(event.data)
  })
  recorder.addEventListener("stop", handlers.onStop)
  recorder.addEventListener("error", handlers.onError)
  return { mimeType: recorder.mimeType, start: () => recorder.start(), stop: () => recorder.stop() }
}
