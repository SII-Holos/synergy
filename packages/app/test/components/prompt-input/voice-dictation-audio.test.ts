import { describe, expect, test } from "bun:test"
import {
  applyGain,
  audioPeak,
  encodePcm16WavBlob,
  gainToTarget,
  normalizeDictationBlob,
  SILENCE_PEAK_THRESHOLD,
  TARGET_PEAK,
} from "../../../src/components/prompt-input/voice-dictation-audio"

describe("voice dictation audio preparation", () => {
  test("audioPeak finds the largest absolute sample", () => {
    expect(audioPeak(new Float32Array([0.1, -0.5, 0.3]))).toBeCloseTo(0.5)
    expect(audioPeak(new Float32Array([0, 0, 0]))).toBe(0)
    expect(audioPeak(new Float32Array([1, -1]))).toBe(1)
  })

  test("gainToTarget amplifies only below-target peaks", () => {
    expect(gainToTarget(0.05)).toBeCloseTo(TARGET_PEAK / 0.05)
    expect(gainToTarget(TARGET_PEAK)).toBe(1)
    expect(gainToTarget(0.9)).toBe(1)
    expect(gainToTarget(0)).toBe(1)
  })

  test("applyGain scales and clips", () => {
    expect(applyGain(new Float32Array([0.5, -0.25]), 2)).toEqual(new Float32Array([1, -0.5]))
    const unchanged = new Float32Array([0.5])
    expect(applyGain(unchanged, 1)).toBe(unchanged)
    expect(applyGain(new Float32Array([0.8]), 2)).toEqual(new Float32Array([1]))
  })

  test("encodePcm16WavBlob writes a canonical RIFF/WAVE header with PCM16 samples", async () => {
    const blob = encodePcm16WavBlob(new Float32Array([0, 0.5, -0.5, 1]), 16000)
    expect(blob.type).toBe("audio/wav")
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...Array.from(bytes.slice(offset, offset + length)))
    const le16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8)
    const le32 = (offset: number) =>
      bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)

    expect(ascii(0, 4)).toBe("RIFF")
    expect(ascii(8, 4)).toBe("WAVE")
    expect(ascii(12, 4)).toBe("fmt ")
    expect(le16(20)).toBe(1) // PCM
    expect(le16(22)).toBe(1) // mono
    expect(le32(24)).toBe(16000) // sample rate
    expect(le16(34)).toBe(16) // bits per sample
    expect(ascii(36, 4)).toBe("data")
    expect(le32(40)).toBe(8) // 4 samples × 2 bytes
    expect(bytes.length).toBe(52)

    const readSample = (i: number) => {
      const v = le16(44 + i * 2)
      return v & 0x8000 ? v - 0x10000 : v
    }
    expect(readSample(0)).toBe(0)
    expect(readSample(1)).toBe(16384) // 0.5 × 32767 = 16383.5 → rounds up
    expect(readSample(2)).toBe(-16383) // -0.5 × 32767 = -16383.5 → Math.round toward +∞
    expect(readSample(3)).toBe(32767) // 1.0 clipped to int16 max
  })

  test("normalizeDictationBlob turns audible audio into a normalized wav", async () => {
    const blob = new Blob(["fake-webm"], { type: "audio/webm" })
    const result = await normalizeDictationBlob(blob, async () => ({
      channelData: new Float32Array([0.01, -0.02, 0.03]),
      sampleRate: 48000,
    }))
    expect(result.kind).toBe("audio")
    if (result.kind !== "audio") return
    expect(result.file.name).toBe("dictation.wav")
    expect(result.file.type).toBe("audio/wav")
    expect(result.peak).toBeCloseTo(0.03)
  })

  test("normalizeDictationBlob reports silence for near-zero clips", async () => {
    const blob = new Blob(["fake-webm"], { type: "audio/webm" })
    const result = await normalizeDictationBlob(blob, async () => ({
      channelData: new Float32Array([0.0001, 0, -0.0002]),
      sampleRate: 48000,
    }))
    expect(result.kind).toBe("silence")
  })

  test("normalizeDictationBlob falls back to the original blob when decoding fails", async () => {
    const blob = new Blob(["not-decodable"], { type: "audio/webm" })
    const result = await normalizeDictationBlob(blob, async () => {
      throw new Error("decode failed")
    })
    expect(result.kind).toBe("audio")
    if (result.kind !== "audio") return
    expect(result.file.name).toBe("dictation.webm")
    expect(result.file.type).toBe("audio/webm")
  })

  test("silence threshold sits far below speech-level peaks", () => {
    // A real whisper still lands well above the digital-silence threshold.
    expect(SILENCE_PEAK_THRESHOLD).toBeLessThan(0.01)
    expect(SILENCE_PEAK_THRESHOLD).toBeGreaterThan(0)
  })
})
