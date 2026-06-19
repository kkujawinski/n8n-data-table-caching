import {
	NodeOperationError,
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

export class DataTableCache implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Data Table Cache',
		name: 'dataTableCache',
		icon: 'file:datatablecache.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Read-through / write-back cache backed by an n8n data table',
		defaults: { name: 'Data Table Cache' },
		inputs: ['main'],
		outputs: ['main', 'main'],
		outputNames: ['Cache Hit', 'Cache Miss'],
		credentials: [{ name: 'dataTableCacheApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Lookup',
						value: 'lookup',
						description: 'Check the cache and route the item to Hit or Miss',
						action: 'Look up a cached item',
					},
					{
						name: 'Store',
						value: 'store',
						description: 'Write the item payload and timestamps to the cache',
						action: 'Store an item in the cache',
					},
				],
				default: 'lookup',
			},
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
				description: 'Value to look up / store under in the key column',
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
				description: 'A hit older than this is treated as a miss',
				displayOptions: { show: { operation: ['lookup'] } },
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
				displayOptions: { show: { operation: ['lookup'] } },
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
				displayOptions: { show: { operation: ['lookup'] } },
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
		const hit: INodeExecutionData[] = [];
		const miss: INodeExecutionData[] = [];
		const store = makeStore(this);

		for (let i = 0; i < items.length; i++) {
			const operation = this.getNodeParameter('operation', i) as string;
			const tableId = this.getNodeParameter('dataTableId', i, '', {
				extractValue: true,
			}) as string;
			const keyCol = this.getNodeParameter('keyCol', i) as string;
			const key = this.getNodeParameter('cacheKey', i) as string;
			const payloadCol = this.getNodeParameter('payloadCol', i) as string;
			const modifiedCol = this.getNodeParameter('modifiedCol', i) as string;
			const accessCol = this.getNodeParameter('accessCol', i) as string;

			try {
				if (operation === 'store') {
					const existing = await store.get(tableId, keyCol, key);
					const now = new Date().toISOString();
					await store.upsert(tableId, keyCol, key, {
						[payloadCol]: JSON.stringify(items[i].json),
						[modifiedCol]: now,
						[accessCol]: now,
					});
					hit.push({
						json: { updated: existing !== null, key, payload: items[i].json },
						pairedItem: { item: i },
					});
					continue;
				}

				// lookup
				const row = await store.get(tableId, keyCol, key);
				if (!row) {
					miss.push({ json: items[i].json, pairedItem: { item: i } });
					continue;
				}

				const ttl = this.getNodeParameter('ttl', i) as number;
				const ttlUnit = this.getNodeParameter('ttlUnit', i) as number;
				const ttlFrom = this.getNodeParameter('ttlFrom', i) as string;
				const fromCol = ttlFrom === 'access' ? accessCol : modifiedCol;

				if (isExpiredByTtl(row, { fromCol, maxAgeMs: ttl * ttlUnit })) {
					miss.push({
						json: { ...items[i].json, _staleRow: row },
						pairedItem: { item: i },
					});
					continue;
				}

				await store.touch(tableId, keyCol, key, { [accessCol]: new Date().toISOString() });
				hit.push({ json: safeParse(row[payloadCol]), pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					miss.push({
						json: { ...items[i].json, error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [hit, miss];
	}
}
