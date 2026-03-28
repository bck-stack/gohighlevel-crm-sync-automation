import axios, { AxiosInstance } from "axios";
import * as dotenv from "dotenv";
import { GHLContact, GHLApiResponse } from "./types";

dotenv.config();

/**
 * GoHighLevel API v2 client wrapper.
 * Handles authentication, contact management, and pipeline operations.
 */
class GHLClient {
  private client: AxiosInstance;
  private locationId: string;

  constructor() {
    this.locationId = process.env.GHL_LOCATION_ID!;
    this.client = axios.create({
      baseURL: "https://services.leadconnectorhq.com",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[GHL API] ${status}: ${message}`);
        throw new Error(`GHL API error ${status}: ${message}`);
      }
    );
  }

  /**
   * Fetch a contact by ID from GoHighLevel.
   */
  async getContact(contactId: string): Promise<GHLContact> {
    const response = await this.client.get<GHLApiResponse<GHLContact>>(
      `/contacts/${contactId}`
    );
    return response.data.data;
  }

  /**
   * Update a contact's tags and custom fields.
   */
  async updateContact(
    contactId: string,
    updates: Partial<GHLContact>
  ): Promise<GHLContact> {
    const response = await this.client.put<GHLApiResponse<GHLContact>>(
      `/contacts/${contactId}`,
      updates
    );
    console.log(`[GHL] Contact ${contactId} updated successfully`);
    return response.data.data;
  }

  /**
   * Add tags to a contact.
   */
  async addTags(contactId: string, tags: string[]): Promise<void> {
    await this.client.post(`/contacts/${contactId}/tags`, { tags });
    console.log(`[GHL] Tags added to ${contactId}: ${tags.join(", ")}`);
  }

  /**
   * Move an opportunity to a new pipeline stage.
   */
  async updateOpportunityStage(
    opportunityId: string,
    stageId: string
  ): Promise<void> {
    await this.client.put(`/opportunities/${opportunityId}`, {
      pipelineStageId: stageId,
    });
    console.log(`[GHL] Opportunity ${opportunityId} moved to stage ${stageId}`);
  }

  /**
   * Send an internal note to a contact's conversation.
   */
  async addNote(contactId: string, body: string): Promise<void> {
    await this.client.post(`/contacts/${contactId}/notes`, { body });
  }

  /**
   * Trigger a workflow for a contact.
   */
  async triggerWorkflow(
    contactId: string,
    workflowId: string
  ): Promise<void> {
    await this.client.post(`/contacts/${contactId}/workflow/${workflowId}`, {
      eventStartTime: new Date().toISOString(),
    });
    console.log(`[GHL] Workflow ${workflowId} triggered for ${contactId}`);
  }
}

export const ghlClient = new GHLClient();
