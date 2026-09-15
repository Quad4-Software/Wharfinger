// Machine-readable mirror of the sqlite SCHEMA + lazy DDL +
// migrate() indexes. The sqlite path keeps using the DDL text in
// db.ts; the SurrealDB path uses this spec to emit DEFINE
// TABLE/INDEX statements and to synthesize record ids.
import type { TableMeta } from './surrealql';

export interface TableSpec extends TableMeta {
	/** unique secondary indexes (col lists); empty cols = none */
	uniques: string[][];
	/** non-unique indexes */
	indexes: string[][];
	/** write-side case-folded shadow cols for NOCASE uniques */
	folds: Record<string, string>;
	/** FK cols with ON DELETE CASCADE: col -> parent table */
	cascades: Record<string, string>;
}

const spec = (s: Partial<TableSpec> & { pk: TableSpec['pk'] }): TableSpec => ({
	pkCols: [],
	uniques: [],
	indexes: [],
	folds: {},
	cascades: {},
	...s
});

const TABLES: Record<string, TableSpec> = {
	checks: spec({ pk: 'none', indexes: [['service_id', 'ts']] }),
	incidents: spec({ pk: 'int', pkCols: ['id'], indexes: [['service_id', 'started_at']] }),
	service_state: spec({ pk: 'text', pkCols: ['service_id'] }),
	users: spec({
		pk: 'int',
		pkCols: ['id'],
		uniques: [['username_lc'], ['source', 'external_id']],
		folds: { username: 'username_lc' }
	}),
	roles: spec({ pk: 'text', pkCols: ['name'] }),
	sessions: spec({
		pk: 'text',
		pkCols: ['token_hash'],
		indexes: [['user_id']],
		cascades: { user_id: 'users' }
	}),
	invites: spec({ pk: 'text', pkCols: ['token_hash'], cascades: { user_id: 'users' } }),
	login_attempts: spec({ pk: 'none', indexes: [['key', 'at']] }),
	config_sections: spec({ pk: 'text', pkCols: ['section'] }),
	audit_log: spec({ pk: 'int', pkCols: ['id'], indexes: [['at']] }),
	notification_log: spec({ pk: 'int', pkCols: ['id'], indexes: [['at']] }),
	incident_updates: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [['incident_id', 'at']],
		cascades: { incident_id: 'incidents' }
	}),
	agents: spec({ pk: 'text', pkCols: ['id'], uniques: [['token_hash']] }),
	agent_samples: spec({ pk: 'none', uniques: [['agent_id', 'ts']], indexes: [] }),
	edge_reports: spec({ pk: 'none', uniques: [['agent_id', 'ts']], indexes: [] }),
	hub_keys: spec({ pk: 'int', pkCols: ['id'] }),
	telemetry_projects: spec({ pk: 'int', pkCols: ['id'], uniques: [['public_key']] }),
	telemetry_issues: spec({ pk: 'composite', pkCols: ['project_id', 'fingerprint'] }),
	telemetry_events: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [['project_id', 'issue_fp', 'ts']]
	}),
	telemetry_traces: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [
			['project_id', 'ts'],
			['project_id', 'trace_id']
		]
	}),
	telemetry_spans: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [['trace_row_id']],
		cascades: { trace_row_id: 'telemetry_traces' }
	}),
	agent_release_files: spec({ pk: 'text', pkCols: ['name'] }),
	push_beats: spec({ pk: 'text', pkCols: ['service_id'] }),
	markers: spec({ pk: 'int', pkCols: ['id'], indexes: [['ts']] }),
	api_keys: spec({ pk: 'int', pkCols: ['id'], uniques: [['key_hash']] }),
	subscribers: spec({ pk: 'int', pkCols: ['id'], uniques: [['url']] }),
	webauthn_credentials: spec({
		pk: 'int',
		pkCols: ['id'],
		uniques: [['credential_id']],
		indexes: [['user_id']],
		cascades: { user_id: 'users' }
	}),
	webauthn_challenges: spec({
		pk: 'text',
		pkCols: ['token_hash'],
		cascades: { user_id: 'users' }
	}),
	chat_rooms: spec({ pk: 'text', pkCols: ['id'], uniques: [['dm_key']] }),
	chat_members: spec({
		pk: 'composite',
		pkCols: ['room_id', 'user_id'],
		indexes: [['user_id']],
		cascades: { room_id: 'chat_rooms' }
	}),
	chat_messages: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [['room_id', 'id']],
		cascades: { room_id: 'chat_rooms' }
	}),
	jobs: spec({
		pk: 'int',
		pkCols: ['id'],
		uniques: [['job_key']],
		indexes: [['status', 'kind', 'target', 'id']]
	}),
	deploy_apps: spec({
		pk: 'text',
		pkCols: ['id'],
		uniques: [['name'], ['webhook_hash']]
	}),
	deploy_keys: spec({ pk: 'text', pkCols: ['app_id'], cascades: { app_id: 'deploy_apps' } }),
	deploy_releases: spec({
		pk: 'text',
		pkCols: ['id'],
		indexes: [['app_id', 'created_at']],
		cascades: { app_id: 'deploy_apps' }
	}),
	service_groups: spec({ pk: 'text', pkCols: ['id'], uniques: [['name']] }),
	service_group_members: spec({
		pk: 'composite',
		pkCols: ['group_id', 'member_kind', 'member_id'],
		indexes: [['member_kind', 'member_id']],
		cascades: { group_id: 'service_groups' }
	}),
	teams: spec({ pk: 'text', pkCols: ['id'], uniques: [['name']] }),
	team_members: spec({
		pk: 'composite',
		pkCols: ['team_id', 'user_id'],
		indexes: [['user_id']],
		cascades: { team_id: 'teams' }
	}),
	team_groups: spec({
		pk: 'composite',
		pkCols: ['team_id', 'group_id'],
		cascades: { team_id: 'teams', group_id: 'service_groups' }
	}),
	secret_sets: spec({ pk: 'text', pkCols: ['id'], uniques: [['name']] }),
	scan_reports: spec({ pk: 'text', pkCols: ['id'], indexes: [['app_id', 'started_at']] }),
	scan_findings: spec({ pk: 'none', indexes: [['report_id']] }),
	recommendations: spec({
		pk: 'text',
		pkCols: ['id'],
		uniques: [['app_id', 'kind', 'dedupe_key']],
		indexes: [['app_id', 'status']]
	}),
	anomaly_baselines: spec({ pk: 'text', pkCols: ['metric'] }),
	anomalies: spec({
		pk: 'int',
		pkCols: ['id'],
		indexes: [['created_at'], ['metric', 'created_at']]
	})
};

export const TABLE_META = new Map<string, TableMeta>(
	Object.entries(TABLES).map(([name, s]) => [name, { pk: s.pk, pkCols: s.pkCols, folds: s.folds }])
);

/**
 * SurrealQL schema statements. Tables are schemaless; indexes map
 * 1:1. Partial sqlite indexes are handled in code, not the DB.
 */
export function surrealSchema(): string {
	const out: string[] = [];
	for (const [name, s] of Object.entries(TABLES)) {
		out.push(`DEFINE TABLE ${name} TYPE ANY SCHEMALESS`);
		for (const cols of s.uniques) {
			out.push(
				`DEFINE INDEX idx_${name}_${cols.join('_')}_uniq ON ${name} FIELDS ${cols.join(', ')} UNIQUE`
			);
		}
		for (const cols of s.indexes) {
			out.push(`DEFINE INDEX idx_${name}_${cols.join('_')} ON ${name} FIELDS ${cols.join(', ')}`);
		}
	}
	return out.join(';\n') + ';';
}
