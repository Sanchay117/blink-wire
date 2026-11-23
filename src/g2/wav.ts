// Encodes raw 16-bit little-endian mono 16kHz PCM frames from Even G2 mic into a RIFF WAV buffer.

export function encodePcm16kToWavBase64(chunks: Uint8Array[], sampleRate = 16000): string {
  let totalBytes = 0
  for (const c of chunks) totalBytes += c.byteLength

  const buffer = new ArrayBuffer(44 + totalBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + totalBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // AudioFormat = PCM
  view.setUint16(22, 1, true) // Mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // ByteRate = sampleRate * channels * 2
  view.setUint16(32, 2, true) // BlockAlign
  view.setUint16(34, 16, true) // BitsPerSample
  writeAscii(view, 36, 'data')
  view.setUint32(40, totalBytes, true)

  const out = new Uint8Array(buffer)
  let offset = 44
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }

  let binary = ''
  const step = 0x8000
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
