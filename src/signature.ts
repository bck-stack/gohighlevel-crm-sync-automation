import crypto from "crypto";

/** HMAC-SHA256 of the raw request body, hex encoded (optionally prefixed with "sha256="). */
export function computeHmac(secret: string, rawBody: Buffer | string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyHmac(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const provided = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  const expected = computeHmac(secret, rawBody);
  // timingSafeEqual throws on length mismatch — compare lengths first.
  if (provided.length !== expected.length || !/^[0-9a-f]+$/.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

/** GoHighLevel marketplace webhooks: base64 RSA-SHA256 signature in the x-wh-signature header. */
export function verifyRsa(rawBody: Buffer, signature: string | undefined, publicKeyPem: string): boolean {
  if (!signature || !publicKeyPem) return false;
  try {
    const verifier = crypto.createVerify("sha256");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKeyPem, signature, "base64");
  } catch {
    return false;
  }
}
