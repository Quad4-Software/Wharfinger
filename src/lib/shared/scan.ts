// Shared types for image vulnerability scans and the hardening
// recommendations derived from them. The agent runs trivy and posts a
// compact result; the hub stores the report and evaluates findings
// into recommendations. See .agents/skills/job-queue for the job
// lifecycle.

export type ScanStatus = 'queued' | 'running' | 'done' | 'failed';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type RecommendationKind =
	| 'pin-image-tag'
	| 'add-healthcheck'
	| 'run-non-root'
	| 'unexpose-ports'
	| 'upgrade-base-image'
	| 'set-resource-limits';

export type RecommendationStatus = 'open' | 'applied' | 'dismissed' | 'wontfix';

// Storage and wire bounds. Findings are deduped on (vulnId, pkg) and
// capped per report; the agent additionally truncates to 300
// findings so the job result stays under the queue's 256KB result
// limit (see wireFindings in agent/internal/scan).
export const MAX_FINDINGS_PER_REPORT = 5000;
export const MAX_VULN_ID = 64;
export const MAX_PKG = 160;
export const MAX_VERSION = 80;
export const MAX_TITLE = 200;
export const MAX_REC_TITLE = 160;
export const MAX_REC_DETAIL = 2000;
export const MAX_TARGET = 300;
export const MAX_SCAN_ERROR = 500;

export interface ScanSummary {
	critical: number;
	high: number;
	medium: number;
	low: number;
	unknown: number;
}

export function emptySummary(): ScanSummary {
	return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}

export interface ScanReport {
	id: string;
	appId: string;
	releaseId?: string;
	/** Image reference the scanner ran against. */
	target: string;
	scanner: 'trivy';
	startedAt: number;
	finishedAt?: number;
	status: ScanStatus;
	summary: ScanSummary;
	durationMs?: number;
	/** Failure detail when status is 'failed'. */
	error?: string;
}

export interface ScanFinding {
	reportId: string;
	vulnId: string;
	pkg: string;
	installed?: string;
	fixed?: string;
	severity: Severity;
	title?: string;
	cvss?: number;
}

export interface Recommendation {
	id: string;
	appId: string;
	kind: RecommendationKind;
	/** Kind-scoped variant key so changed conditions raise a fresh rec. */
	dedupeKey: string;
	severity: Exclude<Severity, 'unknown'>;
	title: string;
	detail: string;
	/** Kind-specific context fixFor needs to build the app patch. */
	data?: Record<string, unknown>;
	autoFixable: boolean;
	status: RecommendationStatus;
	createdAt: number;
	appliedAt?: number;
}

/** Fields evaluate() produces; the store assigns id/status/timestamps. */
export type NewRecommendation = Pick<
	Recommendation,
	'kind' | 'dedupeKey' | 'severity' | 'title' | 'detail' | 'autoFixable'
> & { data?: Record<string, unknown> };

// Frozen spec baked into a scan job. The agent parses this; the hub
// never mutates it after enqueue.
export interface ScanJobSpec {
	scanId: string;
	appId: string;
	imageRef: string;
	releaseId?: string;
	jobKey: string;
}

/** Compact finding shape the agent posts inside the job result. */
export interface ScanWireFinding {
	vulnId: string;
	pkg: string;
	installed?: string;
	fixed?: string;
	severity: string;
	title?: string;
	cvss?: number;
}

/** Result payload the agent posts on a successful scan job. */
export interface ScanJobResult {
	scanId: string;
	summary?: Partial<ScanSummary>;
	findings?: ScanWireFinding[];
	/** Repo digests trivy observed, used by the pin-image-tag fix. */
	repoDigests?: string[];
}
