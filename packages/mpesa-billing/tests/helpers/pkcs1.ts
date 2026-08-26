/**
 * Decrypt an RSA PKCS#1 v1.5 block portably across Node versions.
 *
 * `privateDecrypt` with `RSA_PKCS1_PADDING` is rejected from Node 18.19.1 and
 * 20.11.1 onward — the mitigation for CVE-2023-46809 (the Marvin attack), which
 * targets exactly this padding as a decryption oracle. Only the *decrypt*
 * direction is restricted; `publicEncrypt` with PKCS#1 v1.5 is untouched, which
 * is the direction the library uses and the only one Daraja accepts for the
 * B2C/B2B `SecurityCredential`.
 *
 * So the library is fine and these tests are the problem: verifying the
 * credential round-trips needs a decrypt Node will not perform. Doing the raw
 * modular exponentiation with `RSA_NO_PADDING` and stripping the padding by
 * hand keeps the assertion exact — it proves the ciphertext really is the
 * initiator password under that key — while working on every supported Node.
 */

import { constants, createPrivateKey, privateDecrypt } from 'node:crypto'

export function decryptPkcs1v15(privateKeyPem: string, ciphertextBase64: string): string {
  const block = privateDecrypt(
    { key: createPrivateKey(privateKeyPem), padding: constants.RSA_NO_PADDING },
    Buffer.from(ciphertextBase64, 'base64'),
  )

  // EB = 0x00 || 0x02 || PS || 0x00 || M, where PS is >= 8 non-zero bytes.
  // Node may or may not hand back the leading zero, so find the 0x02 rather
  // than assuming an offset. (RFC 8017 section 7.2.)
  let i = 0
  if (block[i] === 0x00) i += 1
  if (block[i] !== 0x02) {
    throw new Error('Ciphertext is not a PKCS#1 v1.5 encryption block')
  }
  i += 1

  const separator = block.indexOf(0x00, i)
  if (separator === -1) throw new Error('PKCS#1 v1.5 block has no padding separator')
  if (separator - i < 8) throw new Error('PKCS#1 v1.5 padding is too short to be valid')

  return block.subarray(separator + 1).toString('utf8')
}
