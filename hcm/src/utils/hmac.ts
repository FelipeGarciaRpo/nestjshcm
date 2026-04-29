import crypto from 'crypto';

/**
 * Signs a payload using HMAC-SHA256.
 * The NestJS webhook receiver verifies this signature via the x-hcm-signature header.
 */
export function signPayload(payload: object | string, secret: string): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time comparison to prevent timing attacks.
 */
export function verifySignature(payload: object | string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}