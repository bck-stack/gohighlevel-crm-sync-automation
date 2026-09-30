import crypto from "crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp, EventProcessor } from "../src/app";
import { loadConfig } from "../src/config";
import { DryRunClient } from "../src/crm";
import { normalizeEvent } from "../src/handlers";
import { computeHmac, verifyHmac, verifyRsa } from "../src/signature";
import { CrmClient } from "../src/types";

const SECRET = "shh";
const baseCfg = () =>
  loadConfig({
    GHL_WEBHOOK_SECRET: SECRET,
    LOGS_API_KEY: "k",
    GHL_WON_STAGE_ID: "stage-won",
    GHL_ONBOARDING_WORKFLOW_ID: "wf-1",
    DRY_RUN: "true",
  } as NodeJS.ProcessEnv);

function setup(crm: CrmClient = new DryRunClient(), cfg = baseCfg()) {
  const processor = new EventProcessor(crm, cfg, 1);
  const { app } = createApp(cfg, crm, processor);
  const post = (body: unknown, sig?: string) => {
    const raw = JSON.stringify(body);
    return request(app)
      .post("/webhook/ghl")
      .set("Content-Type", "application/json")
      .set("x-ghl-signature", sig ?? computeHmac(SECRET, raw))
      .send(raw);
  };
  return { app, processor, crm, post };
}

describe("signatures", () => {
  it("hmac: accepts hex with/without prefix, rejects wrong length without throwing", () => {
    const body = Buffer.from('{"a":1}');
    const sig = computeHmac(SECRET, body);
    expect(verifyHmac(body, sig, SECRET)).toBe(true);
    expect(verifyHmac(body, `sha256=${sig}`, SECRET)).toBe(true);
    expect(verifyHmac(body, "abc", SECRET)).toBe(false);
    expect(verifyHmac(body, undefined, SECRET)).toBe(false);
  });

  it("rsa: verifies GHL-style x-wh-signature", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const body = Buffer.from('{"type":"ContactCreate"}');
    const sig = crypto.sign("sha256", body, privateKey).toString("base64");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifyRsa(body, sig, pem)).toBe(true);
    expect(verifyRsa(Buffer.from("tampered"), sig, pem)).toBe(false);
  });
});

describe("normalizeEvent", () => {
  it("maps GHL flat payloads", () => {
    const c = normalizeEvent({ type: "ContactCreate", id: "c1", email: "a@b.c", tags: ["x"], webhookId: "w1" });
    expect(c.contact).toMatchObject({ id: "c1", email: "a@b.c", tags: ["x"] });
    expect(c.eventId).toBe("w1");
    const o = normalizeEvent({ type: "OpportunityStageUpdate", id: "o1", contactId: "c1", pipelineStageId: "s", monetaryValue: 500 });
    expect(o.opportunity).toMatchObject({ id: "o1", contactId: "c1", monetaryValue: 500 });
  });
  it("keeps nested payloads and derives a stable id", () => {
    const body = { type: "ContactCreate", contact: { id: "c9" } };
    expect(normalizeEvent(body).contact?.id).toBe("c9");
    expect(normalizeEvent(body).eventId).toBe(normalizeEvent({ ...body }).eventId);
  });
});

describe("webhook endpoint", () => {
  it("rejects bad or missing signatures", async () => {
    const { post, app } = setup();
    expect((await post({ type: "ContactCreate" }, "deadbeef")).status).toBe(401);
    expect((await request(app).post("/webhook/ghl").send({ type: "x" })).status).toBe(401);
  });

  it("processes a GHL ContactCreate: tags, note, workflow", async () => {
    const crm = new DryRunClient();
    const { post, processor } = setup(crm);
    const res = await post({ type: "ContactCreate", id: "c1", email: "jane@example.com", webhookId: "evt-1" });
    expect(res.status).toBe(200);
    await processor.idle();
    expect(crm.calls[0]).toBe("addTags c1 new-lead,webhook-processed");
    expect(crm.calls.some((c) => c.startsWith("addNote c1"))).toBe(true);
    expect(crm.calls).toContain("triggerWorkflow c1 wf-1");
    expect(processor.logs[0]).toMatchObject({ status: "success", attempts: 1 });
  });

  it("de-duplicates retried deliveries", async () => {
    const crm = new DryRunClient();
    const { post, processor } = setup(crm);
    const body = { type: "ContactCreate", id: "c1", webhookId: "same" };
    await post(body);
    const second = await post(body);
    expect(second.body.duplicate).toBe(true);
    await processor.idle();
    expect(crm.calls.filter((c) => c.startsWith("addTags")).length).toBe(1);
  });

  it("tags won deals by stage id or status", async () => {
    const crm = new DryRunClient();
    const { post, processor } = setup(crm);
    await post({ type: "OpportunityStageUpdate", id: "o1", contactId: "c1", pipelineStageId: "stage-won", webhookId: "a" });
    await post({ type: "OpportunityStatusUpdate", id: "o2", contactId: "c2", status: "lost", webhookId: "b" });
    await post({ type: "OpportunityStatusUpdate", id: "o3", contactId: "c3", status: "won", pipelineId: "p1", pipelineStageId: "s-open", webhookId: "c" });
    await processor.idle();
    expect(crm.calls).toContain("addTags c1 won");
    expect(crm.calls).toContain("addTags c2 lost");
    // won by status -> moved to the won stage of its pipeline; already in won stage -> not moved again
    expect(crm.calls).toContain("updateStage o3 p1 stage-won");
    expect(crm.calls.filter((c) => c.startsWith("updateStage o1"))).toHaveLength(0);
  });

  it("retries failing CRM calls and records the error", async () => {
    let n = 0;
    const flaky: CrmClient = {
      addTags: async () => { n++; throw new Error("GHL API error 500: boom"); },
      addNote: async () => {}, triggerWorkflow: async () => {}, updateOpportunityStage: async () => {},
    };
    const { post, processor } = setup(flaky);
    await post({ type: "ContactCreate", id: "c1", webhookId: "z" });
    await processor.idle();
    expect(n).toBe(3);
    expect(processor.logs[0]).toMatchObject({ status: "error", attempts: 3 });
  });

  it("validates payloads and JSON", async () => {
    const { post, app } = setup();
    expect((await post({ nope: 1 })).status).toBe(400);
    const raw = "{bad";
    const res = await request(app).post("/webhook/ghl").set("Content-Type", "application/json")
      .set("x-ghl-signature", computeHmac(SECRET, raw)).send(raw);
    expect(res.status).toBe(400);
  });
});

describe("logs", () => {
  it("require the API key and filter by status", async () => {
    const { app, post, processor } = setup();
    await post({ type: "Unknown", webhookId: "u" });
    await processor.idle();
    expect((await request(app).get("/logs")).status).toBe(401);
    const res = await request(app).get("/logs?status=ignored").set("x-api-key", "k");
    expect(res.body.count).toBe(1);
  });
});
