// Shared job types for the durable queue. See
// .agents/skills/job-queue for the invariants.

export const JOB_STATUSES = [
	'queued',
	'claimed',
	'running',
	'succeeded',
	'failed',
	'rolled_back',
	'unknown'
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ['deploy', 'teardown', 'agent-task', 'scan'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'rolled_back'];
export function isTerminal(status: JobStatus): boolean {
	return TERMINAL.includes(status);
}

export interface Job {
	id: number;
	jobKey: string;
	kind: JobKind;
	target: string | null;
	status: JobStatus;
	spec: string;
	result: string | null;
	log: string | null;
	leaseOwner: string | null;
	leaseUntil: number | null;
	attempts: number;
	maxAttempts: number;
	createdAt: number;
	updatedAt: number;
}

// Payload an agent receives when it claims a job. spec is the frozen
// snapshot string; the executor parses per kind.
export interface ClaimedJob {
	id: number;
	kind: JobKind;
	spec: string;
	lease: string;
	leaseUntil: number;
	attempt: number;
}
