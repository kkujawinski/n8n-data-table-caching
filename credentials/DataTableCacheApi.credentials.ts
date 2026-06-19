import type { ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * Connection details for reaching the n8n data-table REST API.
 *
 * As of n8n 2.x there is no public (`/api/v1`) row-CRUD endpoint for data tables
 * (see the BRIEF, §0). The working route is the internal one mounted under
 * `/rest/projects/{projectId}/data-tables/...`, which is authenticated with the
 * browser session cookie rather than an API key. This credential therefore lets you
 * supply either:
 *
 *   - Session Cookie + Browser Id — the path that works today against `/rest`, or
 *   - API Key — forward-compatible for when the public data-table API ships.
 *
 * The node sends whichever fields are populated. Revisit this on every n8n upgrade.
 */
export class DataTableCacheApi implements ICredentialType {
	name = 'dataTableCacheApi';

	displayName = 'Data Table Cache API';

	documentationUrl = 'https://docs.n8n.io/data/data-tables/';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:5678',
			placeholder: 'http://localhost:5678',
			description: 'Root URL of your n8n instance, without a trailing slash',
			required: true,
		},
		{
			displayName: 'Project ID',
			name: 'projectId',
			type: 'string',
			default: '',
			description:
				'The project that owns the data table. Open the project in n8n and copy the ID from the URL (/projects/&lt;id&gt;/...). For a single-user instance this is your personal project.',
			required: true,
		},
		{
			displayName: 'Authentication',
			name: 'authMethod',
			type: 'options',
			default: 'cookie',
			options: [
				{
					name: 'Session Cookie',
					value: 'cookie',
					description: 'Works today against the internal /rest route',
				},
				{
					name: 'API Key',
					value: 'apiKey',
					description: 'Forward-compatible, once the public data-table API ships',
				},
			],
		},
		{
			displayName: 'Session Cookie (n8n-auth)',
			name: 'sessionCookie',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Value of the n8n-auth cookie from a logged-in browser session (DevTools → Application → Cookies)',
			displayOptions: { show: { authMethod: ['cookie'] } },
		},
		{
			displayName: 'Browser ID',
			name: 'browserId',
			type: 'string',
			default: '',
			description: 'Value of the browser-id header sent by the n8n UI; required alongside the cookie',
			displayOptions: { show: { authMethod: ['cookie'] } },
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'An n8n API key (Settings → n8n API)',
			displayOptions: { show: { authMethod: ['apiKey'] } },
		},
	];
}
