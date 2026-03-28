import { Request, Response } from "express";
import { GHLWebhookPayload, WebhookLog } from "./types";
import { ghlClient } from "./crm";
import { v4 as uuidv4 } from "uuid";

// In-memory log (use DB in production)
const webhookLogs: WebhookLog[] = [];

/**
 * Handle incoming GoHighLevel webhook events.
 * Dispatches to the appropriate handler based on event type.
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body as GHLWebhookPayload;
  const logEntry: WebhookLog = {
    id: uuidv4(),
    type: payload.type,
    payload,
    processedAt: new Date().toISOString(),
    status: "success",
  };

  try {
    console.log(`[Webhook] Received event: ${payload.type}`);

    switch (payload.type) {
      case "ContactCreate":
        await handleContactCreate(payload);
        break;
      case "ContactUpdate":
        await handleContactUpdate(payload);
        break;
      case "OpportunityCreate":
        await handleOpportunityCreate(payload);
        break;
      case "OpportunityStageUpdate":
        await handleOpportunityStageUpdate(payload);
        break;
      default:
        console.log(`[Webhook] Unhandled event type: ${payload.type}`);
    }

    webhookLogs.unshift(logEntry);
    res.status(200).json({ received: true, id: logEntry.id });
  } catch (err) {
    logEntry.status = "error";
    logEntry.message = err instanceof Error ? err.message : "Unknown error";
    webhookLogs.unshift(logEntry);
    console.error(`[Webhook] Error processing ${payload.type}:`, err);
    res.status(500).json({ error: logEntry.message });
  }
}

/**
 * Handle new contact creation:
 * - Tag with 'new-lead'
 * - Add a welcome note
 */
async function handleContactCreate(payload: GHLWebhookPayload): Promise<void> {
  const { contact } = payload;
  if (!contact) return;

  await ghlClient.addTags(contact.id, ["new-lead", "webhook-processed"]);
  await ghlClient.addNote(
    contact.id,
    `Contact created via webhook on ${new Date().toLocaleString()}`
  );

  // Trigger onboarding workflow if configured
  const workflowId = process.env.GHL_ONBOARDING_WORKFLOW_ID;
  if (workflowId) {
    await ghlClient.triggerWorkflow(contact.id, workflowId);
  }

  console.log(`[Handler] New contact processed: ${contact.email}`);
}

/**
 * Handle contact update events.
 */
async function handleContactUpdate(payload: GHLWebhookPayload): Promise<void> {
  const { contact } = payload;
  if (!contact) return;
  console.log(`[Handler] Contact updated: ${contact.id}`);
}

/**
 * Handle new opportunity creation.
 * Tags the associated contact and logs the pipeline entry.
 */
async function handleOpportunityCreate(payload: GHLWebhookPayload): Promise<void> {
  const { opportunity } = payload;
  if (!opportunity) return;

  await ghlClient.addTags(opportunity.contactId, ["opportunity-created"]);
  await ghlClient.addNote(
    opportunity.contactId,
    `New opportunity "${opportunity.name}" created — value: $${opportunity.monetaryValue}`
  );

  console.log(`[Handler] Opportunity created: ${opportunity.name}`);
}

/**
 * Handle opportunity stage transitions.
 * Applies appropriate tags based on the new stage.
 */
async function handleOpportunityStageUpdate(
  payload: GHLWebhookPayload
): Promise<void> {
  const { opportunity } = payload;
  if (!opportunity) return;

  const wonStageId = process.env.GHL_WON_STAGE_ID;
  const lostStageId = process.env.GHL_LOST_STAGE_ID;

  if (opportunity.pipelineStageId === wonStageId) {
    await ghlClient.addTags(opportunity.contactId, ["won"]);
    await ghlClient.addNote(opportunity.contactId, "🎉 Deal won!");
  } else if (opportunity.pipelineStageId === lostStageId) {
    await ghlClient.addTags(opportunity.contactId, ["lost"]);
  }

  console.log(`[Handler] Stage updated for opportunity: ${opportunity.id}`);
}

/** Return recent webhook logs. */
export function getLogs(_req: Request, res: Response): void {
  res.json({ count: webhookLogs.length, logs: webhookLogs.slice(0, 50) });
}
