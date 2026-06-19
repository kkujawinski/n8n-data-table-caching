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
	const raw = row[fromCol];
	const ts = raw == null ? NaN : new Date(raw as string).getTime();
	if (Number.isNaN(ts)) return true;
	return Date.now() - ts > maxAgeMs;
}
