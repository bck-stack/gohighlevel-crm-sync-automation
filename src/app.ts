import crypto from "crypto";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { Config } from "./config";
import { normalizeEvent, processEvent } from "./handlers";
import { verifyHmac, verifyRsa } from "./signature";
import { CrmClient, GHLWebhookPayload, NormalizedEvent, WebhookLog } from "./types";

type RawRequest = Request & { rawBody?: Buffer };

const MAX_LOGS = 200;
const DEDUP_WINDOW = 5000;
const MAX_ATTEMPTS = 3;

/** In-process job runner: acknowledges GHL immediately, processes in the background with retries. */
export class EventProcessor {
  readonly logs: WebhookLog[] = [];
  private seen = new Map<string, true>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private crm: CrmClient, private cfg: Config, private retryDelayMs = 1000) {}

  isDuplicate(eventId: string): boolean {
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, true);
    if (this.seen.size > DEDUP_WINDOW) this.seen.delete(this.seen.keys().next().value as string);
    return false;
  }

  record(entry: WebhookLog): WebhookLog {
    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOGS) this.logs.pop();
    return entry;
  }

  enqueue(evt: NormalizedEvent): WebhookLog {
    const entry = this.record({
      id: crypto.randomUUID(),
      eventId: evt.eventId,
      type: evt.type,
      contactId: evt.contact?.id ?? evt.opportunity?.contactId,
      receivedAt: new Date().toISOString(),
      status: "queued",
      actions: [],
      attempts: 0,
    });
    // Sequential processing keeps API usage predictable and avoids tag races on the same contact.
    this.chain = this.chain.then(() => this.run(evt, entry));
    return entry;
  }

  private async run(evt: NormalizedEvent, entry: WebhookLog): Promise<void> {
    while (entry.attempts < MAX_ATTEMPTS) {
      entry.attempts++;
      try {
        const result = await processEvent(evt, this.crm, this.cfg);
        entry.status = result.status;
        entry.actions = result.actions;
        entry.message = undefined;
        break;
      } catch (err) {
        entry.status = "error";
        entry.message = err instanceof Error ? err.message : String(err);
        console.error(`[Webhook] ${evt.type} ${evt.eventId} attempt ${entry.attempts} failed: ${entry.message}`);
        if (entry.attempts < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, this.retryDelayMs * entry.attempts));
      }
    }
    entry.processedAt = new Date().toISOString();
  }

  /** Resolves when everything queued so far has been processed (used by tests and shutdown). */
  idle(): Promise<void> {
    return this.chain;
  }
}

export function createApp(cfg: Config, crm: CrmClient, processor = new EventProcessor(crm, cfg)) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  // Keep the exact bytes: signatures must be computed over the raw body, not re-serialised JSON.
  app.use(
    express.json({
      limit: "1mb",
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  const verifySignature = (req: RawRequest, res: Response, next: NextFunction) => {
    const raw = req.rawBody ?? Buffer.from("");
    const rsaSig = req.header("x-wh-signature");
    const hmacSig = req.header("x-ghl-signature") ?? req.header("x-hub-signature-256");

    if (cfg.webhookPublicKey && rsaSig && verifyRsa(raw, rsaSig, cfg.webhookPublicKey)) return next();
    if (cfg.webhookSecret && hmacSig && verifyHmac(raw, hmacSig, cfg.webhookSecret)) return next();
    if (!cfg.webhookPublicKey && !cfg.webhookSecret && cfg.allowUnsigned) return next();

    const missing = !rsaSig && !hmacSig;
    res.status(401).json({ error: missing ? "Missing webhook signature" : "Invalid webhook signature" });
  };

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header("x-api-key") ?? "";
    if (!cfg.logsApiKey) return void res.status(403).json({ error: "Logs are disabled (LOGS_API_KEY not set)" });
    const a = Buffer.from(provided);
    const b = Buffer.from(cfg.logsApiKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return void res.status(401).json({ error: "Invalid API key" });
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: "2.0.0",
      dryRun: cfg.dryRun,
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * POST /webhook/ghl — verifies the signature, de-duplicates, acknowledges with 200 right away
   * (GHL retries slow endpoints) and processes the event in the background.
   */
  app.post("/webhook/ghl", verifySignature, (req: Request, res: Response) => {
    const body = req.body as GHLWebhookPayload;
    if (!body || typeof body !== "object" || typeof body.type !== "string") {
      return void res.status(400).json({ error: "Payload must be a JSON object with a 'type' field" });
    }
    const evt = normalizeEvent(body);
    if (processor.isDuplicate(evt.eventId)) {
      processor.record({
        id: crypto.randomUUID(), eventId: evt.eventId, type: evt.type, receivedAt: new Date().toISOString(),
        status: "duplicate", actions: [], attempts: 0,
      });
      return void res.status(200).json({ received: true, duplicate: true, eventId: evt.eventId });
    }
    const entry = processor.enqueue(evt);
    res.status(200).json({ received: true, id: entry.id, eventId: evt.eventId });
  });

  /** GET /logs?status=error — recent events (requires X-API-Key; contains contact IDs). */
  app.get("/logs", requireApiKey, (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_LOGS);
    const logs = processor.logs.filter((l) => !status || l.status === status).slice(0, limit);
    res.json({ count: logs.length, logs });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Endpoint not found" });
  });

  // Malformed JSON and other errors -> JSON response instead of an HTML stack trace.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error("[Server]", err);
    res.status(status).json({ error: err.type === "entity.parse.failed" ? "Invalid JSON body" : status >= 500 ? "Internal error" : err.message });
  });

  return { app, processor };
}
