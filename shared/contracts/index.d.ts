export type Lifecycle = "active" | "trashed" | "purging" | "deleted";
export type Availability = "generating" | "ready" | "stale" | "needs_review" | "missing" | "damaged";
export type JobStatus = "queued" | "running" | "paused" | "blocked" | "interrupted" | "succeeded" | "failed" | "cancelled";
export interface ResourceRef {
  resourceId: string;
  versionId?: string;
  generationId?: string;
}
export interface JobRecord extends ResourceRef {
  id: string;
  type: string;
  status: JobStatus;
  stage?: string;
  progress?: number;
  revision?: number;
  epoch?: number;
  fingerprint: string;
  completedStages: string[];
  attempts: number;
  error?: string | null;
}
export interface Citation extends ResourceRef {
  recordId?: string;
  blockIds?: string[];
  elementId?: string;
  pages?: number[];
  sectionPath?: string[];
  sourceType?: string;
  sourceDate?: string;
  datePrecision?: "day" | "month" | "year" | "unknown";
}
export interface WorkspaceContext {
  workspace: "main" | "video";
  projectId?: string | null;
  paperId?: string | null;
}
