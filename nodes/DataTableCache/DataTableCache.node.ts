import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodeListSearchResult,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { isExpiredByTtl, safeParse } from './helpers';
import { dataTableRequest, unwrapRows } from './stores/client';
import { makeStore } from './stores/makeStore';

/**
 * Read-through cache as a single node, wired like the Loop Over Items node:
 * one input, two outputs, and a cycle.
 *
 *   input ─▶ [Cache] ─ hit  ─▶ Continue
 *                  └ miss ─▶ Process ─▶ your work ─┐
 *                    ▲────────── loop back ────────┘
 *
 *   - First pass (lookup): a fresh hit is emitted on **Continue**; a miss (or expired
 *     row) is emitted on **Process** and the key is remembered for this execution.
 *   - Loop-back pass (store): when the processed item returns on the same input, the node
 *     stores it and emits it on **Continue**.
 *
 * Pass detection uses per-execution node state (`getContext('node')`), the same mechanism
 * Loop Over Items uses, keyed by the cache key. The key is recomputed from the returned
 * item, so the field(s) the Cache Key expression derives from must survive your processing
 * — otherwise the loop-back item won't be recognised as a store pass.
 */
export class DataTableCache implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Data Table Cache',
		name: 'dataTableCache',
		icon: 'file:datatablecache.svg',
		group: ['transform'],
		version: 1,
		description: 'Read-through cache backed by an n8n data table; loops misses out for processing',
		defaults: { name: 'Data Table Cache' },
		inputs: ['main'],
		outputs: ['main', 'main'],
		outputNames: ['Continue', 'Process'],
		credentials: [{ name: 'dataTableCacheApi', required: true }],
		properties: [
			{
				displayName: 'Data Table',
				name: 'dataTableId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The data table that backs the cache',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'searchDataTables',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-zA-Z0-9]+$',
									errorMessage: 'Not a valid data table ID',
								},
							},
						],
						placeholder: 'e.g. aBcD1234',
					},
				],
			},
			{
				displayName: 'Key Column',
				name: 'keyCol',
				type: 'string',
				default: 'cache_key',
				required: true,
				description: 'Column that stores the cache key (must exist on the table)',
			},
			{
				displayName: 'Cache Key',
				name: 'cacheKey',
				type: 'string',
				default: '',
				required: true,
				description:
					'Value to look up / store under. Derive it from a field that survives your processing nodes (such as a record key or order number) so the loop-back item is recognised on its way back.',
			},
			{
				displayName: 'Payload Column',
				name: 'payloadCol',
				type: 'string',
				default: 'payload',
				description: 'Column holding the JSON-stringified payload',
			},
			{
				displayName: 'Last Modified Column',
				name: 'modifiedCol',
				type: 'string',
				default: 'last_modified',
				description: 'Column holding the ISO timestamp of the last write',
			},
			{
				displayName: 'Last Access Column',
				name: 'accessCol',
				type: 'string',
				default: 'last_access',
				description: 'Column holding the ISO timestamp of the last cache hit',
			},
			{
				displayName: 'Max Age',
				name: 'ttl',
				type: 'number',
				default: 3600,
				typeOptions: { minValue: 0 },
				description: 'A hit older than this is treated as a miss and looped out for reprocessing',
			},
			{
				displayName: 'Unit',
				name: 'ttlUnit',
				type: 'options',
				options: [
					{ name: 'Seconds', value: 1000 },
					{ name: 'Minutes', value: 60000 },
					{ name: 'Hours', value: 3600000 },
					{ name: 'Days', value: 86400000 },
				],
				default: 1000,
			},
			{
				displayName: 'Measure From',
				name: 'ttlFrom',
				type: 'options',
				options: [
					{ name: 'Last Modified', value: 'modified' },
					{ name: 'Last Access', value: 'access' },
				],
				default: 'modified',
				description: 'Which timestamp the max age is measured from',
			},
		],
	};

	methods = {
		listSearch: {
			async searchDataTables(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const response = await dataTableRequest(this, { method: 'GET', path: '/' });
				const needle = (filter ?? '').toLowerCase();
				const results = unwrapRows(response)
					.map((table) => ({
						name: String(table.name ?? table.id),
						value: String(table.id),
					}))
					.filter((entry) => !needle || entry.name.toLowerCase().includes(needle));
				return { results };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const cont: INodeExecutionData[] = [];
		const process: INodeExecutionData[] = [];
		const store = makeStore(this);

		// Per-execution scratch space: keys we emitted for processing and now expect back.
		const context = this.getContext('node');
		const pending = (context.pendingKeys as Record<string, boolean>) ?? {};
		context.pendingKeys = pending;

		for (let i = 0; i < items.length; i++) {
			const tableId = this.getNodeParameter('dataTableId', i, '', {
				extractValue: true,
			}) as string;
			const keyCol = this.getNodeParameter('keyCol', i) as string;
			const key = this.getNodeParameter('cacheKey', i) as string;
			const payloadCol = this.getNodeParameter('payloadCol', i) as string;
			const modifiedCol = this.getNodeParameter('modifiedCol', i) as string;
			const accessCol = this.getNodeParameter('accessCol', i) as string;

			try {
				// Store pass: this item is a previously-missed key coming back after processing.
				if (pending[key]) {
					delete pending[key];
					const now = new Date().toISOString();
					await store.upsert(tableId, keyCol, key, {
						[payloadCol]: JSON.stringify(items[i].json),
						[modifiedCol]: now,
						[accessCol]: now,
					});
					cont.push({ json: items[i].json, pairedItem: { item: i } });
					continue;
				}

				// Lookup pass.
				const row = await store.get(tableId, keyCol, key);

				const ttl = this.getNodeParameter('ttl', i) as number;
				const ttlUnit = this.getNodeParameter('ttlUnit', i) as number;
				const ttlFrom = this.getNodeParameter('ttlFrom', i) as string;
				const fromCol = ttlFrom === 'access' ? accessCol : modifiedCol;

				const missed = !row || isExpiredByTtl(row, { fromCol, maxAgeMs: ttl * ttlUnit });
				if (missed) {
					pending[key] = true;
					const json: IDataObject = { ...items[i].json };
					if (row) json._staleRow = row as IDataObject;
					process.push({ json, pairedItem: { item: i } });
					continue;
				}

				// Fresh hit: bump last_access and emit the cached payload.
				await store.touch(tableId, keyCol, key, { [accessCol]: new Date().toISOString() });
				cont.push({ json: safeParse(row![payloadCol]), pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					// Emit on Continue (not Process) so a failure never re-enters the loop.
					cont.push({
						json: { ...items[i].json, error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [cont, process];
	}
}
