import express from "express";
import helmet from "helmet";
import * as dotenv from "dotenv";
import { handleWebhook, getLogs } from "./webhook";
import { verifyGHLSignature, requestLogger } from "./middleware";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json());
app.use(requestLogger);

// ── Routes ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /webhook/ghl
 * Main endpoint for GoHighLevel webhook events.
 * Verifies signature before processing.
 */
app.post("/webhook/ghl", verifyGHLSignature, handleWebhook);

/**
 * GET /logs
 * Returns the last 50 processed webhook events.
 */
app.get("/logs", getLogs);

// ── 404 handler ─────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// ── Start server ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GHL Webhook Server running on port ${PORT}`);
  console.log(`   Health:  http://localhost:${PORT}/health`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook/ghl`);
  console.log(`   Logs:    http://localhost:${PORT}/logs\n`);
});

export default app;
