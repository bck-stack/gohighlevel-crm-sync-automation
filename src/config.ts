import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

export interface Config {
  port: number;
  ghlApiKey: string;
  ghlLocationId: string;
  webhookSecret: string;       // HMAC-SHA256 shared secret (custom senders / workflow webhooks)
  webhookPublicKey: string;    // GHL marketplace RSA public key (x-wh-signature)
  allowUnsigned: boolean;
  logsApiKey: string;
  onboardingWorkflowId: string;
  wonStageId: string;
  lostStageId: string;
  newLeadTags: string[];
  dryRun: boolean;
}

const list = (v: string | undefined, fallback: string[]): string[] =>
  v === undefined ? fallback : v.split(",").map((s) => s.trim()).filter(Boolean);

const unescapePem = (v: string | undefined): string => (v ?? "").replace(/\\n/g, "\n").trim();

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT) || 3000,
    ghlApiKey: env.GHL_API_KEY ?? "",
    ghlLocationId: env.GHL_LOCATION_ID ?? "",
    webhookSecret: env.GHL_WEBHOOK_SECRET ?? "",
    webhookPublicKey: unescapePem(env.GHL_WEBHOOK_PUBLIC_KEY),
    allowUnsigned: (env.ALLOW_UNSIGNED ?? "false").toLowerCase() === "true",
    logsApiKey: env.LOGS_API_KEY ?? "",
    onboardingWorkflowId: env.GHL_ONBOARDING_WORKFLOW_ID ?? "",
    wonStageId: env.GHL_WON_STAGE_ID ?? "",
    lostStageId: env.GHL_LOST_STAGE_ID ?? "",
    newLeadTags: list(env.NEW_LEAD_TAGS, ["new-lead", "webhook-processed"]),
    dryRun: (env.DRY_RUN ?? "false").toLowerCase() === "true",
  };
}

/** Problems that make the service unusable — reported at start-up. */
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
  if (!cfg.ghlApiKey && !cfg.dryRun) problems.push("GHL_API_KEY is required (or set DRY_RUN=true).");
  if (!cfg.webhookSecret && !cfg.webhookPublicKey && !cfg.allowUnsigned) {
    problems.push("Set GHL_WEBHOOK_SECRET or GHL_WEBHOOK_PUBLIC_KEY (or ALLOW_UNSIGNED=true for local testing).");
  }
  return problems;
}
