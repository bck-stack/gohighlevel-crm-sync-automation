import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";
import { CrmClient } from "./types";

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GHLApiError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(`GHL API error ${status ?? "network"}: ${message}`);
  }
}

/**
 * GoHighLevel API v2 client.
 * Retries 429 / 5xx / network errors with backoff (honours Retry-After).
 */
export class GHLClient implements CrmClient {
  private http: AxiosInstance;

  constructor(apiKey: string, http?: AxiosInstance) {
    this.http =
      http ??
      axios.create({
        baseURL: BASE_URL,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: API_VERSION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 15000,
      });
  }

  private async request<T>(config: AxiosRequestConfig): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.http.request<T>(config);
        return res.data;
      } catch (err) {
        const error = err as AxiosError<{ message?: string | string[] }>;
        const status = error.response?.status;
        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable || attempt >= MAX_RETRIES) {
          const msg = error.response?.data?.message ?? error.message;
          throw new GHLApiError(status, Array.isArray(msg) ? msg.join("; ") : String(msg));
        }
        const retryAfter = Number(error.response?.headers?.["retry-after"]);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        console.warn(`[GHL] ${config.method?.toUpperCase()} ${config.url} failed (${status ?? "network"}), retry ${attempt} in ${wait}ms`);
        await sleep(wait);
      }
    }
  }

  async addTags(contactId: string, tags: string[]): Promise<void> {
    if (!tags.length) return;
    await this.request({ method: "post", url: `/contacts/${encodeURIComponent(contactId)}/tags`, data: { tags } });
    console.log(`[GHL] Tags added to ${contactId}: ${tags.join(", ")}`);
  }

  async addNote(contactId: string, body: string): Promise<void> {
    await this.request({ method: "post", url: `/contacts/${encodeURIComponent(contactId)}/notes`, data: { body } });
  }

  async triggerWorkflow(contactId: string, workflowId: string): Promise<void> {
    await this.request({
      method: "post",
      url: `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(workflowId)}`,
      data: { eventStartTime: new Date().toISOString() },
    });
    console.log(`[GHL] Workflow ${workflowId} triggered for ${contactId}`);
  }

  async updateOpportunityStage(opportunityId: string, pipelineId: string, stageId: string): Promise<void> {
    // GHL API v2 requires pipelineId together with pipelineStageId.
    await this.request({
      method: "put",
      url: `/opportunities/${encodeURIComponent(opportunityId)}`,
      data: { pipelineId, pipelineStageId: stageId },
    });
    console.log(`[GHL] Opportunity ${opportunityId} moved to stage ${stageId}`);
  }
}

/** Logs what would happen instead of calling the API (DRY_RUN=true). */
export class DryRunClient implements CrmClient {
  public calls: string[] = [];
  private log(line: string) {
    this.calls.push(line);
    console.log(`[DRY RUN] ${line}`);
  }
  async addTags(contactId: string, tags: string[]) { this.log(`addTags ${contactId} ${tags.join(",")}`); }
  async addNote(contactId: string, body: string) { this.log(`addNote ${contactId} "${body}"`); }
  async triggerWorkflow(contactId: string, workflowId: string) { this.log(`triggerWorkflow ${contactId} ${workflowId}`); }
  async updateOpportunityStage(opportunityId: string, pipelineId: string, stageId: string) { this.log(`updateStage ${opportunityId} ${pipelineId} ${stageId}`); }
}
