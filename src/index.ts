import { createApp } from "./app";
import { loadConfig, validateConfig } from "./config";
import { DryRunClient, GHLClient } from "./crm";

const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  console.error("Configuration error:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

const crm = cfg.dryRun ? new DryRunClient() : new GHLClient(cfg.ghlApiKey);
const { app, processor } = createApp(cfg, crm);

const server = app.listen(cfg.port, () => {
  console.log(`\nGHL Webhook Server running on port ${cfg.port}${cfg.dryRun ? " (DRY RUN — no API calls)" : ""}`);
  console.log(`   Health:  http://localhost:${cfg.port}/health`);
  console.log(`   Webhook: http://localhost:${cfg.port}/webhook/ghl`);
  console.log(`   Logs:    http://localhost:${cfg.port}/logs (X-API-Key)\n`);
});

// Finish queued events before exiting (PM2 / Docker send SIGTERM).
const shutdown = (signal: string) => {
  console.log(`${signal} received — finishing queued events…`);
  server.close();
  Promise.race([processor.idle(), new Promise((r) => setTimeout(r, 10000))]).then(() => process.exit(0));
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
