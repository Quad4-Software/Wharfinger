import { randomBytes } from 'node:crypto';
import type { RequestHandler } from './$types';
import { getRuntime } from '$lib/server/runtime';
import { hashToken, verifyPassword } from '$lib/server/admin/crypto';
import { generateTotpSecret, totpUri, verifyTotp } from '$lib/server/admin/totp';
import { apiError, apiJson, audit, readJson, requireUser } from '$lib/server/admin/http';
import { TOTP_BACKUP_CODES } from '$lib/server/constants';

function backupCodes(): { codes: string[]; hashes: string[] } {
	const codes = Array.from(
		{ length: TOTP_BACKUP_CODES },
		() => `${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`
	);
	return { codes, hashes: codes.map(hashToken) };
}

/**
 * TOTP enrollment is a two-step flow:
 *  begin   -> returns a fresh secret + otpauth URI (nothing stored)
 *  confirm -> verifies a code against that secret, then enables 2FA
 *  disable -> requires the account password
 */
export const POST: RequestHandler = async (event) => {
	const rt = getRuntime();
	const user = requireUser(event);
	const body = await readJson<{
		action?: unknown;
		secret?: unknown;
		code?: unknown;
		password?: unknown;
	}>(event.request, 8192);

	if (body.action === 'begin') {
		const secret = generateTotpSecret();
		return apiJson({ secret, uri: totpUri(secret, user.username, 'Status Panel') });
	}

	if (body.action === 'confirm') {
		const secret = typeof body.secret === 'string' ? body.secret : '';
		const code = typeof body.code === 'string' ? body.code.trim() : '';
		if (!secret || !verifyTotp(secret, code)) {
			return apiError(422, 'that code did not match; check your authenticator clock');
		}
		const { codes, hashes } = backupCodes();
		await rt.users.setTotp(user.id, secret, hashes);
		await rt.sessions.revokeUserSessions(user.id, event.locals.sessionHash ?? undefined);
		await audit(rt, event, 'account.totp.enable');
		return apiJson({ ok: true, backup_codes: codes });
	}

	if (body.action === 'disable') {
		const password = typeof body.password === 'string' ? body.password : '';
		const row = await rt.users.rowById(user.id);
		if (!row || !verifyPassword(password, row.password_hash)) {
			return apiError(403, 'password is incorrect');
		}
		await rt.users.setTotp(user.id, null, null);
		await audit(rt, event, 'account.totp.disable');
		return apiJson({ ok: true });
	}

	return apiError(422, 'unknown action');
};
