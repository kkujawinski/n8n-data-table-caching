import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { CacheRow } from './CacheStore';

export const CREDENTIALS_NAME = 'dataTableCacheApi';

/** Either context that can make authenticated HTTP calls and read credentials. */
export type RequestContext = IExecuteFunctions | ILoadOptionsFunctions;

export type FilterCondition = 'eq' | 'neq' | 'like' | 'ilike' | 'gt' | 'gte' | 'lt' | 'lte';

export interface DataTableFilter {
	type: 'and' | 'or';
	filters: Array<{ columnName: string; condition: FilterCondition; value: unknown }>;
}

/** Build a `<keyCol> eq <key>` filter, the only matcher this node needs. */
export function keyFilter(keyCol: string, key: string): DataTableFilter {
	return { type: 'and', filters: [{ columnName: keyCol, condition: 'eq', value: key }] };
}

interface DataTableRequestOptions {
	method: IHttpRequestMethods;
	/** Path under `/rest/projects/{projectId}/data-tables` — leading slash optional. */
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
}

/**
 * Low-level call against the n8n data-table REST API.
 *
 * THIS IS THE SINGLE FRAGILE LINE TO REVISIT ON EVERY n8n UPGRADE (BRIEF §0).
 * It targets the internal `/rest/projects/{projectId}/data-tables/...` controller,
 * which is cookie-authenticated today. When the public `/api/v1` data-table API ships,
 * swap the base path and the auth header here; nothing else in the node changes.
 */
export async function dataTableRequest(
	ctx: RequestContext,
	{ method, path, qs, body }: DataTableRequestOptions,
): Promise<unknown> {
	const credentials = await ctx.getCredentials(CREDENTIALS_NAME);

	const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');
	const projectId = String(credentials.projectId ?? '');
	if (!baseUrl || !projectId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Data Table Cache API credential is missing the Base URL or Project ID.',
		);
	}

	const headers: IDataObject = { Accept: 'application/json' };
	if (credentials.authMethod === 'apiKey') {
		headers['X-N8N-API-KEY'] = credentials.apiKey;
	} else {
		headers.Cookie = `n8n-auth=${credentials.sessionCookie ?? ''}`;
		if (credentials.browserId) headers['browser-id'] = credentials.browserId;
	}

	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}/rest/projects/${projectId}/data-tables${normalizedPath}`,
		headers,
		json: true,
		...(qs ? { qs } : {}),
		...(body ? { body } : {}),
	};

	return await ctx.helpers.httpRequest(options);
}

/**
 * n8n's `/rest` endpoints wrap their payload in `{ data: ... }`, and the rows endpoint
 * itself returns `{ count, data: [...] }`. Peel both layers and return the row array.
 */
export function unwrapRows(response: unknown): CacheRow[] {
	let payload = response as IDataObject | undefined;

	// Outer REST envelope: { data: { count, data: [...] } }
	if (
		payload &&
		typeof payload === 'object' &&
		!Array.isArray(payload.data) &&
		payload.data &&
		typeof payload.data === 'object'
	) {
		payload = payload.data as IDataObject;
	}

	const rows = payload?.data ?? payload;
	return Array.isArray(rows) ? (rows as CacheRow[]) : [];
}
