/* global Buffer */

// One 300×1 uint8 TIFF written by tifffile 2026.6.1 with imagecodecs 2026.6.6.
// The strip crosses TIFF LZW's 9-to-10-bit early-change boundary.
const REFERENCE_TIFF_BASE64 = 'SUkqAAgAAAAMAAABBAABAAAALAEAAAEBBAABAAAAAQAAAAIBAwABAAAACAAAAAMBAwABAAAABQAAAAYBAwABAAAAAQAAABEBBAABAAAAsAAAABUBAwABAAAAAQAAABYBBAABAAAAAQAAABcBBAABAAAAWgEAABoBBQABAAAAngAAABsBBQABAAAApgAAACgBAwABAAAAAQAAAAAAAAABAAAAAQAAAAEAAAABAAAAAACAAAuN5DlUkmRSApLkkQiAiI5/pUojQeGpfjlsqBGJ5rjVcmQaCojol4oAaA4HjVAvRGEoXjk0sAeN5TpVUuQiMo7kkgmBSA5PlUYjQuKoPrk8mA2J57nUMuRqOoTokIsBKI5XvUwvRWIpHrkEoAON5jtUEmRyIorkkwqACI4fhUIjQ+Oo/jkMiAmJ4LrU8mQ6KoDokYgB6A4nrUgvRmMp3jlUkB+N5zhU0uRCEobklAuAyA5vtV4jROCpvrlcuAWJ4bvVsuQKGpzokokAqI53nUQvR2AonrkkgBuN4DlVkmQSAoLklQiBiI4/pVojReGofjksqAGJ4rjUcmRaCpjok4oBaA5HjUAvQGEpXjl0sBeN4TpUUuRiMp7klgmASAcD4qliGhuFUT5cnyMB2E8O46kycgqHUU5EkiYAKEcF56nCegWEUB5ckSQBOG8I5qkSMgyEUa4knCgI';

export const LZW_REFERENCE_PIXELS = Object.freeze(Array.from(
  { length: 300 },
  (_, index) => (index * 73 + index * index * 19 + Math.floor(index / 3)) & 0xff,
));

export function createLzwReferenceTiff() {
  const bytes = Buffer.from(REFERENCE_TIFF_BASE64, 'base64');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
