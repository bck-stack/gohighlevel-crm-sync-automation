export interface GHLContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  tags: string[];
  customFields: Record<string, string>;
  dateAdded: string;
}

export interface GHLWebhookPayload {
  type: string;
  locationId: string;
  id: string;
  contact?: GHLContact;
  opportunity?: {
    id: string;
    name: string;
    pipelineId: string;
    pipelineStageId: string;
    status: string;
    monetaryValue: number;
    contactId: string;
  };
  timestamp: string;
}

export interface GHLApiResponse<T> {
  data: T;
  status: number;
}

export interface PipelineStage {
  id: string;
  name: string;
  pipelineId: string;
}

export interface WebhookLog {
  id: string;
  type: string;
  payload: GHLWebhookPayload;
  processedAt: string;
  status: "success" | "error";
  message?: string;
}
