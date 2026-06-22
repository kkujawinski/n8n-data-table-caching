import type { IDataObject } from 'n8n-workflow';

import type { CacheRow } from './stores/CacheStore';

/** TTL unit value -> milliseconds multiplier (the option value IS the multiplier). */
export const TTL_UNITS = {
	seconds: 1000,
	minutes: 60000,
	hours: 3600000,
	days: 86400000,
} as const;

/**
 * Columns n8n creates and maintains automatically on every data table. The `/columns`
 * endpoint omits them, so they're added to the dropdowns by hand (e.g. `updatedAt` is a
 * natural "last modified" column). They are READ-ONLY: the API rejects any write to them
 * with HTTP 400, so they must be stripped from write payloads.
 */
export const SYSTEM_COLUMNS = ['updatedAt'] as const;

const SYSTEM_COLUMN_SET: ReadonlySet<string> = new Set(SYSTEM_COLUMNS);

/** True if `name` is a system column n8n maintains automatically. */
export function isSystemColumn(name: string): boolean {
	return SYSTEM_COLUMN_SET.has(name);
}

/**
 * Drop any system columns from a write payload. Selecting `updatedAt`/`createdAt` as a
 * timestamp column is valid for *reading* the TTL, but n8n maintains them itself and
 * rejects writes to them — so the node simply doesn't write them.
 */
export function stripSystemColumns(fields: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(fields)) {
		if (!isSystemColumn(key)) out[key] = value;
	}
	return out;
}

/**
 * Parse a stored payload, degrading gracefully (BRIEF §2). A malformed or legacy value
 * must never throw — it comes back wrapped as `{ _raw }` so the caller can decide.
 */
export function safeParse(value: unknown): IDataObject {
	if (typeof value !== 'string') {
		return { _raw: value } as IDataObject;
	}
	try {
		const parsed = JSON.parse(value);
		// Arrays / primitives are valid JSON but not an item `json` object; wrap them.
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as IDataObject)
			: ({ _value: parsed } as IDataObject);
	} catch {
		return { _raw: value } as IDataObject;
	}
}

/** True if a date-time's time portion already carries timezone info (Z or ±offset). */
function timePartHasTimezone(timePart: string): boolean {
	return /[zZ]$/.test(timePart) || timePart.includes('+') || timePart.includes('-');
}

/**
 * Parse a stored timestamp to epoch milliseconds, tolerant of how different column types
 * and database backends serialise dates.
 *
 * The node always WRITES ISO-8601 UTC (`new Date().toISOString()`, with a trailing `Z`), but a
 * value can come back in other shapes: a `date`-typed column on SQLite reads back without the
 * `Z` (e.g. `"2026-06-20 12:00:00.000"`), CSV-imported rows may use a space separator, and an
 * epoch number is possible. Mirroring n8n's own `normalizeDate`, a date-time with no explicit
 * timezone is treated as **UTC** (rather than the host's local time, which would skew the TTL).
 * Returns `NaN` for anything unparseable.
 */
export function parseTimestamp(raw: unknown): number {
	if (raw == null) return NaN;
	if (raw instanceof Date) return raw.getTime();
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
	if (typeof raw !== 'string') return NaN;

	const trimmed = raw.trim();
	if (!trimmed) return NaN;

	// Normalise a space-separated date-time to the ISO `T` form.
	const s = trimmed.replace(' ', 'T');
	const timePart = s.split('T')[1] ?? '';
	// Only date-times need a timezone; a date-only string is already treated as UTC.
	const assumeUtc = timePart.includes(':') && !timePartHasTimezone(timePart);

	return new Date(assumeUtc ? `${s}Z` : s).getTime();
}

export interface TtlConfig {
	/** Column the TTL is measured from. */
	fromCol: string;
	/** Max age, already expressed in milliseconds (ttl * unit). */
	maxAgeMs: number;
}

/**
 * TTL expiry check (BRIEF §3). A row is expired when its reference timestamp is older
 * than the max age. A missing or unparseable timestamp is treated as expired so the
 * lookup degrades to a miss rather than serving an undated row.
 */
export function isExpiredByTtl(row: CacheRow, { fromCol, maxAgeMs }: TtlConfig): boolean {
	const ts = parseTimestamp(row[fromCol]);
	if (Number.isNaN(ts)) return true;
	return Date.now() - ts > maxAgeMs;
}
