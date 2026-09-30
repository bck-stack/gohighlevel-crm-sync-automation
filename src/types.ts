export interface GHLContact {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  tags?: string[];
  customFields?: Array<{ id: string; value: unknown }> | Record<string, unknown>;
  dateAdded?: string;
}

export interface GHLOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string; // open | won | lost | abandoned
  monetaryValue?: number;
  contactId: string;
}

/** Raw body as delivered by GoHighLevel (flat) or by custom senders (nested). */
export interface GHLWebhookPayload {
  type: string;
  locationId?: string;
  id?: string;
  webhookId?: string;
  contactId?: string;
  contact?: GHLContact;
  opportunity?: GHLOpportunity;
  timestamp?: string;
  [key: string]: unknown;
}

/** Payload after normalisation — handlers only ever see this shape. */
export interface NormalizedEvent {
  eventId: string;
  type: string;
  locationId?: string;
  contact?: GHLContact;
  opportunity?: GHLOpportunity;
  raw: GHLWebhookPayload;
}

export interface WebhookLog {
  id: string;
  eventId: string;
  type: string;
  contactId?: string;
  receivedAt: string;
  processedAt?: string;
  status: "queued" | "success" | "error" | "ignored" | "duplicate";
  actions: string[];
  message?: string;
  attempts: number;
}

/** The subset of CRM operations the handlers need — lets tests inject a fake. */
export interface CrmClient {
  addTags(contactId: string, tags: string[]): Promise<void>;
  addNote(contactId: string, body: string): Promise<void>;
  triggerWorkflow(contactId: string, workflowId: string): Promise<void>;
  updateOpportunityStage(opportunityId: string, pipelineId: string, stageId: string): Promise<void>;
}
