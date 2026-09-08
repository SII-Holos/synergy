import { describe, expect, test } from "bun:test"
import { isPcm16Wav, peakNormalizeWavPcm16, wavDataRange } from "../../src/voice/wav-loudness"

/** Build a minimal mono 16-bit PCM RIFF/WAVE byte buffer. */
function buildWav(samples: number[]): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new Uint8Array(44 + dataBytes)
  const view = new DataView(buffer.buffer)

  function ascii(offset: number, text: string) {
    for (let i = 0; i < text.length; i++) buffer[offset + i] = text.charCodeAt(i)
  }

  ascii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 24000, true)
  view.setUint32(28, 48000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true)
  return buffer
}

describe("wav-loudness peak normalization", () => {
  test("recognizes canonical PCM16 WAVE data", () => {
    const wav = buildWav([1000, -2000, 3000])
    expect(isPcm16Wav(wav)).toBe(true)
    expect(wavDataRange(wav)).toEqual({ dataOffset: 44, dataLength: 6 })
  })

  test("rejects non-RIFF, non-WAVE, and truncated payloads", () => {
    expect(isPcm16Wav(new Uint8Array([1, 2, 3]))).toBe(false)
    const noRiff = buildWav([1, 2, 3])
    noRiff[0] = 88
    expect(isPcm16Wav(noRiff)).toBe(false)
    const noWave = buildWav([1, 2, 3])
    noWave[8] = 88
    expect(isPcm16Wav(noWave)).toBe(false)
  })

  test("amplifies a quiet clip to the target peak (-1 dBFS)", () => {
    // Peak 3277 ≈ -20 dBFS. Normalization should lift it to ≈ 29286 (-1 dBFS).
    const quiet = buildWav([-3277, 3277, 0, -1000, 500])
    const normalized = peakNormalizeWavPcm16(quiet)
    expect(isPcm16Wav(normalized)).toBe(true)

    const view = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength)
    let peak = 0
    for (let i = 0; i < 5; i++) {
      const value = Math.abs(view.getInt16(44 + i * 2, true))
      if (value > peak) peak = value
    }
    // target: 10^(-1/20) * 32768 ≈ 29286, within rounding of a scaled sample.
    expect(peak).toBeGreaterThan(28000)
    expect(peak).toBeLessThanOrEqual(29286)
  })
  test("leaves clips at or above the target peak untouched (no attenuation)", () => {
    const loud = buildWav([-29300, 29300, 0, 10000])
    const result = peakNormalizeWavPcm16(loud)
    expect(result).toBe(loud)
  })

  test("silent clips and non-PCM16 payloads pass through unchanged", () => {
    const silent = buildWav([0, 0, 0, 0])
    expect(peakNormalizeWavPcm16(silent)).toBe(silent)

    const notWav = new Uint8Array([9, 9, 9])
    expect(peakNormalizeWavPcm16(notWav)).toBe(notWav)
  })

  test("preserves waveform shape (positive samples stay positive)", () => {
    const quiet = buildWav([1000, -2000, 3000, -4000, 5000])
    const normalized = peakNormalizeWavPcm16(quiet)
    const view = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength)
    const signs = [0, 1, 2, 3, 4].map((i) => Math.sign(view.getInt16(44 + i * 2, true)))
    expect(signs).toEqual([1, -1, 1, -1, 1])
  })
})
