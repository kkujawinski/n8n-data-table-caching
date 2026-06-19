import type { CacheStore } from './CacheStore';
import type { RequestContext } from './client';
import { HttpCacheStore } from './HttpCacheStore';

/**
 * Factory for the active CacheStore implementation.
 *
 * Today this always returns the HTTP store (BRIEF Option 3). It is the single place to
 * switch strategies: a future DI-based store (Option 2) or the public-API store would
 * be selected here, e.g. from a node parameter, without touching `execute`.
 */
export function makeStore(ctx: RequestContext): CacheStore {
	return new HttpCacheStore(ctx);
}
