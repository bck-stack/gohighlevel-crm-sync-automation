import crypto from "crypto";
import { Config } from "./config";
import { CrmClient, GHLContact, GHLOpportunity, GHLWebhookPayload, NormalizedEvent } from "./types";

const CONTACT_EVENTS = new Set(["ContactCreate", "ContactUpdate", "ContactTagUpdate", "ContactDelete"]);
const OPPORTUNITY_EVENTS = new Set([
  "OpportunityCreate",
  "OpportunityStageUpdate",
  "OpportunityStatusUpdate",
  "OpportunityUpdate",
  "OpportunityMonetaryValueUpdate",
]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * GoHighLevel sends flat payloads ({ type, id, email, contactId, pipelineStageId, ... });
 * custom senders often nest them ({ contact: {...} }). Normalise both into one shape.
 */
export function normalizeEvent(raw: GHLWebhookPayload): NormalizedEvent {
  const type = str(raw.type) ?? "Unknown";
  const eventId =
    str(raw.webhookId) ??
    str((raw as Record<string, unknown>).eventId) ??
    crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 32);

  let contact: GHLContact | undefined = raw.contact;
  let opportunity: GHLOpportunity | undefined = raw.opportunity;

  if (!contact && CONTACT_EVENTS.has(type) && str(raw.id)) {
    contact = {
      id: raw.id as string,
      firstName: str(raw.firstName),
      lastName: str(raw.lastName),
      name: str(raw.name),
      email: str(raw.email),
      phone: str(raw.phone),
      tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : undefined,
    };
  }
  if (!opportunity && OPPORTUNITY_EVENTS.has(type) && str(raw.id) && str(raw.contactId)) {
    opportunity = {
      id: raw.id as string,
      contactId: raw.contactId as string,
      name: str(raw.name),
      pipelineId: str(raw.pipelineId),
      pipelineStageId: str(raw.pipelineStageId),
      status: str(raw.status),
      monetaryValue: typeof raw.monetaryValue === "number" ? raw.monetaryValue : Number(raw.monetaryValue) || undefined,
    };
  }
  return { eventId, type, locationId: str(raw.locationId), contact, opportunity, raw };
}

export type HandlerResult = { status: "success" | "ignored"; actions: string[] };

const money = (v?: number) =>
  v === undefined ? "n/a" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

/** Business rules. Returns the list of actions taken (for logs / tests). */
export async function processEvent(evt: NormalizedEvent, crm: CrmClient, cfg: Config): Promise<HandlerResult> {
  const actions: string[] = [];
  const act = async (label: string, fn: () => Promise<void>) => {
    await fn();
    actions.push(label);
  };

  if (cfg.ghlLocationId && evt.locationId && evt.locationId !== cfg.ghlLocationId) {
    return { status: "ignored", actions: [`location ${evt.locationId} is not ${cfg.ghlLocationId}`] };
  }

  switch (evt.type) {
    case "ContactCreate": {
      const c = evt.contact;
      if (!c?.id) return { status: "ignored", actions: ["missing contact id"] };
      const existing = new Set(c.tags ?? []);
      const tags = cfg.newLeadTags.filter((t) => !existing.has(t));
      if (tags.length) await act(`tags:${tags.join(",")}`, () => crm.addTags(c.id, tags));
      await act("note", () => crm.addNote(c.id, `Contact created via webhook on ${new Date().toISOString()}`));
      if (cfg.onboardingWorkflowId) {
        await act(`workflow:${cfg.onboardingWorkflowId}`, () => crm.triggerWorkflow(c.id, cfg.onboardingWorkflowId));
      }
      break;
    }

    case "OpportunityCreate": {
      const o = evt.opportunity;
      if (!o?.contactId) return { status: "ignored", actions: ["missing opportunity contact"] };
      await act("tags:opportunity-created", () => crm.addTags(o.contactId, ["opportunity-created"]));
      await act("note", () => crm.addNote(o.contactId, `New opportunity "${o.name ?? o.id}" created — value: ${money(o.monetaryValue)}`));
      break;
    }

    case "OpportunityStageUpdate":
    case "OpportunityStatusUpdate": {
      const o = evt.opportunity;
      if (!o?.contactId) return { status: "ignored", actions: ["missing opportunity contact"] };
      const won = o.status === "won" || (!!cfg.wonStageId && o.pipelineStageId === cfg.wonStageId);
      const lost = o.status === "lost" || (!!cfg.lostStageId && o.pipelineStageId === cfg.lostStageId);
      // Keep the pipeline in sync: a deal marked won/lost is moved to the configured stage.
      const target = won ? cfg.wonStageId : lost ? cfg.lostStageId : "";
      if (target && o.pipelineId && o.pipelineStageId !== target) {
        await act(`stage:${target}`, () => crm.updateOpportunityStage(o.id, o.pipelineId!, target));
      }
      if (won) {
        await act("tags:won", () => crm.addTags(o.contactId, ["won"]));
        await act("note", () => crm.addNote(o.contactId, `Deal won: "${o.name ?? o.id}" (${money(o.monetaryValue)})`));
      } else if (lost) {
        await act("tags:lost", () => crm.addTags(o.contactId, ["lost"]));
      } else {
        return { status: "ignored", actions: ["stage is neither won nor lost"] };
      }
      break;
    }

    case "ContactUpdate":
    case "ContactTagUpdate":
      return { status: "ignored", actions: ["logged only"] };

    default:
      return { status: "ignored", actions: [`unhandled event type ${evt.type}`] };
  }

  return { status: "success", actions };
}
