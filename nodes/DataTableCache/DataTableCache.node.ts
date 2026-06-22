import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodeListSearchResult,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';

import { isExpiredByTtl, safeParse, SYSTEM_COLUMNS } from './helpers';
import { dataTableRequest, unwrapRows } from './stores/client';
import { makeStore } from './stores/makeStore';

/** Load the selected table's column names as dropdown options (empty if no table yet). */
async function fetchColumnOptions(ctx: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const tableId = ctx.getCurrentNodeParameter('dataTableId', { extractValue: true }) as string;
	if (!tableId) return [];

	// The columns endpoint returns a bare array, not the `{ data: [...] }` envelope.
	const response = await dataTableRequest(ctx, { method: 'GET', path: `/${tableId}/columns` });
	const columns = Array.isArray(response)
		? (response as IDataObject[])
		: ((response as IDataObject)?.data as IDataObject[]) ?? [];

	const names = columns.map((column) => String(column.name ?? '')).filter((name) => name);

	// Append any system columns the endpoint didn't already report.
	const seen = new Set(names);
	for (const name of SYSTEM_COLUMNS) {
		if (!seen.has(name)) names.push(name);
	}

	return names.map((name) => ({ name, value: name }));
}

/**
 * Read-through / write-back cache with two inputs:
 *
 *            ┌──────────── Data Table Cache ────────────┐
 *   Input  ─▶│ lookup → Cache Hit / Cache Miss            │
 *   Update ─▶│ store the item, then emit on Cache Hit     │
 *            └────────────────────────────────────────────┘
 *
 *   - **Input** (index 0): items to look up. A hit emits the parsed payload on **Cache Hit**;
 *     a miss (or expired row) emits the item on **Cache Miss**.
 *   - **Update** (index 1): processed items to write back. They are upserted and emitted on
 *     **Cache Hit** so the flow continues with the now-cached payload.
 *
 * Wire it like a loop: Cache Miss → your work → the Update input.
 *
 * `requiredInputs: 1` lets the node run as soon as *either* input has data (it would
 * otherwise wait for all inputs, deadlocking the lookup→process→update cycle). Under
 * `executionOrder: 'v1'` the engine resolves expressions against whichever input carries the
 * items, so the Cache Key expression works for both the Input and Update passes.
 */
export class DataTableCache implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Data Table Cache',
		name: 'dataTableCache',
		icon: 'file:datatablecache.svg',
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ $parameter["dataTableId"].cachedResultName || $parameter["dataTableId"].value || "data table" }}',
		description: 'Read-through / write-back cache backed by an n8n data table',
		defaults: { name: 'Data Table Cache' },
		inputs: [
			{ type: 'main', displayName: 'Input' },
			{ type: 'main', displayName: 'Update', required: false },
		],
		requiredInputs: 1,
		outputs: ['main', 'main'],
		outputNames: ['Cache Hit', 'Cache Miss'],
		credentials: [{ name: 'n8nApi', required: true }],
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
				displayName: 'Key Column Name or ID',
				name: 'keyCol',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['dataTableId.value'],
				},
				default: 'cache_key',
				required: true,
				description: 'Column that stores the cache key. Pick from the table\'s columns, or switch to an expression for a custom value. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Cache Key',
				name: 'cacheKey',
				type: 'string',
				default: '',
				required: true,
				description: 'Value to look up (on the Input) or store under (on the Update)',
			},
			{
				displayName: 'Payload Column Name or ID',
				name: 'payloadCol',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['dataTableId.value'],
				},
				default: 'payload',
				description: 'Column holding the JSON-stringified payload. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Last Modified Column Name or ID',
				name: 'modifiedCol',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumns',
					loadOptionsDependsOn: ['dataTableId.value'],
				},
				default: 'last_modified',
				description: 'Column holding the ISO timestamp of the last write. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Last Access Column Name or ID',
				name: 'accessCol',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getColumnsOrNone',
					loadOptionsDependsOn: ['dataTableId.value'],
				},
				default: 'last_access',
				description:
					'Optional. Column for the last-hit timestamp; pick "None" to skip last-access tracking (one fewer write per hit). Required only when Measure From is Last Access. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Max Age',
				name: 'ttl',
				type: 'number',
				default: 3600,
				typeOptions: { minValue: 0 },
				description: 'A hit older than this is treated as a miss',
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
				const response = await dataTableRequest(this, { method: 'GET', path: '' });
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
		loadOptions: {
			async getColumns(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return fetchColumnOptions(this);
			},
			// Same list, prefixed with an explicit "None" so an optional column field can be
			// cleared from the dropdown in list mode (no expression-mode workaround needed).
			async getColumnsOrNone(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return [{ name: 'None', value: '' }, ...(await fetchColumnOptions(this))];
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const lookupItems = this.getInputData(0);
		const updateItems = this.getInputData(1);
		const hit: INodeExecutionData[] = [];
		const miss: INodeExecutionData[] = [];
		const store = makeStore(this);

		const params = (i: number) => ({
			tableId: this.getNodeParameter('dataTableId', i, '', { extractValue: true }) as string,
			keyCol: this.getNodeParameter('keyCol', i) as string,
			key: this.getNodeParameter('cacheKey', i) as string,
			payloadCol: this.getNodeParameter('payloadCol', i) as string,
			modifiedCol: this.getNodeParameter('modifiedCol', i) as string,
			accessCol: this.getNodeParameter('accessCol', i) as string,
		});

		// --- Input (index 0): lookups ---
		for (let i = 0; i < lookupItems.length; i++) {
			try {
				const { tableId, keyCol, key, payloadCol, modifiedCol, accessCol } = params(i);
				const row = await store.get(tableId, keyCol, key);

				const ttl = this.getNodeParameter('ttl', i) as number;
				const ttlUnit = this.getNodeParameter('ttlUnit', i) as number;
				const ttlFrom = this.getNodeParameter('ttlFrom', i) as string;
				if (ttlFrom === 'access' && !accessCol) {
					throw new NodeOperationError(
						this.getNode(),
						'Measure From is "Last Access" but no Last Access Column is set. Configure the Last Access Column, or measure from Last Modified.',
						{ itemIndex: i },
					);
				}
				const fromCol = ttlFrom === 'access' ? accessCol : modifiedCol;

				if (!row || isExpiredByTtl(row, { fromCol, maxAgeMs: ttl * ttlUnit })) {
					const json: IDataObject = { ...lookupItems[i].json };
					if (row) json._staleRow = row as IDataObject;
					miss.push({ json, pairedItem: { item: i, input: 0 } });
					continue;
				}

				// last_access is optional: only bump it when an access column is configured.
				if (accessCol) {
					await store.touch(tableId, keyCol, key, { [accessCol]: new Date().toISOString() });
				}
				hit.push({ json: safeParse(row[payloadCol]), pairedItem: { item: i, input: 0 } });
			} catch (error) {
				if (this.continueOnFail()) {
					miss.push({
						json: { ...lookupItems[i].json, error: (error as Error).message },
						pairedItem: { item: i, input: 0 },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		// --- Update (index 1): write-back, then continue on Cache Hit ---
		for (let j = 0; j < updateItems.length; j++) {
			try {
				const { tableId, keyCol, key, payloadCol, modifiedCol, accessCol } = params(j);
				const now = new Date().toISOString();
				const fields: IDataObject = {
					[payloadCol]: JSON.stringify(updateItems[j].json),
					[modifiedCol]: now,
				};
				// last_access is optional: only write it when an access column is configured.
				if (accessCol) fields[accessCol] = now;
				await store.upsert(tableId, keyCol, key, fields);
				hit.push({ json: updateItems[j].json, pairedItem: { item: j, input: 1 } });
			} catch (error) {
				if (this.continueOnFail()) {
					hit.push({
						json: { ...updateItems[j].json, error: (error as Error).message },
						pairedItem: { item: j, input: 1 },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: j });
			}
		}

		return [hit, miss];
	}
}
