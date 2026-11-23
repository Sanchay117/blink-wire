// Encodes raw 16-bit little-endian mono 16kHz PCM frames from Even G2 mic into a RIFF WAV base64 payload,
// and computes live RMS amplitude (0..1) for the G2 ASCII VU meter.

export function computePcm16Rms(chunk: Uint8Array): number {
  const sampleCount = Math.floor(chunk.byteLength / 2)
  if (sampleCount === 0) return 0
  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2)
  let sumSq = 0
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sumSq += s * s
  }
  return Math.min(1, Math.sqrt(sumSq / sampleCount) * 3.5)
}

export function encodePcm16kToWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  let totalBytes = 0
  for (const c of chunks) totalBytes += c.byteLength

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  // Safe chunk step (0x2000) prevents stack overflow in iOS WKWebView Function.apply
  let binary = ''
  const step = 0x2000
  for (let i = 0; i < out.length; i += step) {
    binary += String.fromCharCode(...out.subarray(i, i + step))
  }
  return btoa(binary)
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}
