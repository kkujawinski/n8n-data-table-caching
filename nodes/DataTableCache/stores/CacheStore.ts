/**
 * The swappable data-access layer for the cache node.
 *
 * The whole point of this interface (see BRIEF §0) is to isolate the only fragile
 * part of the node — talking to n8n data tables — behind three small methods, so the
 * concrete strategy (HTTP today, an in-process DI service or the public API later) can
 * be swapped without touching any node logic.
 *
 * A "row" is a flat record of column name -> value, exactly as the data-table API
 * returns it (so it includes the auto columns `id`, `createdAt`, `updatedAt` plus the
 * cache columns).
 */
export type CacheRow = Record<string, unknown>;

export interface CacheStore {
	/** Fetch the single row whose key column equals `key`, or null on a miss. */
	get(tableId: string, keyCol: string, key: string): Promise<CacheRow | null>;

	/**
	 * Insert-or-update the row identified by `key`. `fields` are the columns to write
	 * (payload + timestamps); the key column is added automatically.
	 */
	upsert(tableId: string, keyCol: string, key: string, fields: CacheRow): Promise<void>;

	/** Patch a subset of columns (e.g. bump last_access) on the row identified by `key`. */
	touch(tableId: string, keyCol: string, key: string, fields: CacheRow): Promise<void>;
}
