import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Verify GoHighLevel webhook signature.
 * GHL sends X-GHL-Signature header with HMAC-SHA256 of the raw body.
 */
export function verifyGHLSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const signature = req.headers["x-ghl-signature"] as string;
  const secret = process.env.GHL_WEBHOOK_SECRET;

  if (!secret) {
    console.warn("[Auth] GHL_WEBHOOK_SECRET not set — skipping verification");
    return next();
  }

  if (!signature) {
    res.status(401).json({ error: "Missing webhook signature" });
    return;
  }

  const rawBody = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  next();
}

/**
 * Request logger middleware.
 */
export function requestLogger(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
}
