# Usage guide — Data Table Cache

A step-by-step guide to setting up the cache: the recommended data-table schema, the
credential, importing the example workflow, and keeping the cache healthy.

---

## 1. Create the data table (recommended setup)

The node stores each cached item as one row. The full schema is four columns (n8n adds `id`,
`createdAt`, `updatedAt` automatically); only the first three are required:

| Column          | Type               | Required?                         | Holds                                     | Why                                                           |
| --------------- | ------------------ | --------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| `cache_key`     | `string`           | Yes                               | The lookup key (e.g. a record id, a hash) | Matched on every lookup/upsert                                |
| `payload`       | `string`           | Yes                               | `JSON.stringify` of the cached item       | The node writes/reads text — **must be `string`**, not `json` |
| `last_modified` | `string` or `date` | Yes                               | ISO-8601 timestamp of the last write      | Default TTL source                                            |
| `last_access`   | `string` or `date` | **Optional**                      | ISO-8601 timestamp of the last cache hit  | Only for **Measure From = Last Access** (idle TTL) or LRU eviction |

> - **`payload` must be `string`** — a `json` column breaks the `JSON.stringify` / `JSON.parse`
>   round-trip (hits come back as `{ "_raw": ... }`).
> - **Timestamps can be `string` or `date`** — the node writes ISO-8601 UTC and parses
>   read-back values as UTC either way, so the TTL stays correct.
> - **`last_access` is optional** — leave the node's **Last Access Column** empty to skip it (a
>   minimal table is `cache_key` + `payload` + `last_modified`). You only need it for
>   **Measure From = Last Access** or idle-time eviction.

### Create it in the UI

**From the example CSV (easiest).** Importing a CSV makes one column per header — use
[`examples/cache-table.csv`](../examples/cache-table.csv):

```csv
cache_key,payload,last_modified,last_access
example-key,"{""value"":""hello"",""count"":42}",2026-06-20T12:00:00.000Z,2026-06-20T12:00:00.000Z
```

**Data tables → Create → Import from CSV** → pick the file. After import, ensure **`payload`**
is **String** (re-set if n8n inferred `json`); timestamps may be String or Date. Delete the
seed row if you don't want it.

**By hand.** **Data tables → Create** → add the columns from the table above (omit
`last_access` unless you need idle-time TTL or eviction).

Copy the table id from the URL when done.

---

## 2. Configure the credential

The node uses the **built-in `n8n API` credential** (no custom credential):

1. In n8n: **Settings → n8n API → Create an API key**. Give the key the data-table scopes:
   `dataTable:list`, `dataTableRow:read`, `dataTableRow:upsert`, `dataTableRow:update`.
2. **Credentials → New → n8n API**:
   - **Base URL** — must end in `/api/v1`, e.g. `http://localhost:5678/api/v1`.
   - **API Key** — the key from step 1.

> A 404 when opening the **Data Table** list almost always means the Base URL is missing
> `/api/v1`, or your n8n version predates the public `/api/v1/data-tables` API. See
> [Troubleshooting](#6-troubleshooting).

---

## 3. Import the example workflow

Import [`examples/datatable-cache.example.workflow.json`](../examples/datatable-cache.example.workflow.json)
via **Workflows → Import from File**. Then on the **Data Table Cache** node:

- set **Data Table** to your table (or paste the id over `REPLACE_WITH_TABLE_ID`),
- pick your **n8n API** credential.

> If import errors with *"unknown node type"*, install the community node first
> (`n8n-nodes-datatable-cache`) and reload.

The workflow demonstrates the full read-through loop:

```
Build Request ─▶ [Input] Data Table Cache [Cache Hit] ─▶ Use Result
                                          [Cache Miss] ─▶ Simulate Expensive Work
                                                                   │
                              [Update] ◀──────────────────────────┘
```

---

## 4. How the wiring works

- **Input** (input 1) receives items to look up.
- **Cache Hit** (output 1) carries the payload — both fresh hits and items that were just
  stored — so it's your "continue with the data" path.
- **Cache Miss** (output 2) carries items that need work. Wire it through your processing and
  back into **Update** (input 2).
- **Update** (input 2) upserts the processed item and re-emits it on **Cache Hit**.

Derive **Cache Key** from a field present on both the lookup item and the processed item (e.g.
`={{ $json.id }}`). Requires `executionOrder: v1` (default on recent n8n).

---

## 5. TTL & expiry guidance

- **Max Age + Unit** — how long a hit stays fresh. Older hits route to **Cache Miss**.
- **Measure From**:
  - `Last Modified` — time since the value was cached (most caches want this). The default;
    needs no `last_access` column.
  - `Last Access` — time since it was last read; combine with a scheduled eviction job for
    LRU-style eviction. **Requires the Last Access Column** to be set (the node errors if it
    isn't).
- Expired lookups attach the stale row under `_staleRow` on the miss item, for debugging or
  serve-stale-on-error patterns.

---

## 6. Maintenance — evict expired rows

Data tables don't auto-delete expired rows, so the table grows until you prune it. Do this with
a separate n8n **Data Table** node pointed at the same Cache data table:

- Add a **Schedule Trigger** → **Data Table** node (operation **Delete Rows**) over the Cache
  table.
- Filter on `last_modified` **less than** a cutoff timestamp, e.g.
  `={{ $now.minus({ days: 7 }).toUTC().toISO() }}`. Because timestamps are ISO-8601 **text**, a
  less-than comparison sorts them chronologically.
- To evict by idle time instead, filter on `last_access`.

This keeps eviction entirely inside n8n — no API key or extra scopes required.

> Keep payloads compact — all data tables in an instance share a default **50 MB** limit
> (`N8N_DATA_TABLES_MAX_SIZE_BYTES` to raise it on self-hosted).

---

## 7. Key-design tips

- Make the key **deterministic** for the same logical request (sort/normalise inputs before
  hashing). Hash long or structured keys, e.g. `={{ $json.url.toLowerCase() }}`.
- Use **one table per cache** (or prefix keys with a namespace) so unrelated caches don't
  collide and can be pruned independently.
- Concurrency is **last-write-wins** — fine for a cache, not for transactional data.

---

## 8. Troubleshooting

| Symptom                                              | Likely cause / fix                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `404` opening the Data Table list                    | Base URL missing `/api/v1`; or n8n too old for `/api/v1/data-tables` (see below)    |
| `404` on both `/workflows` and `/data-tables`        | Base URL is wrong — must end in `/api/v1`                                           |
| `/workflows` 200 but `/data-tables` 404              | Your n8n build predates the public data-table API — upgrade n8n                     |
| `403`                                                | API key is missing the required `dataTable*` scopes                                |
| Hits always come back as `{ "_raw": ... }`           | `payload` column isn't `string`, or rows were written outside this node            |

Reproduce the API check directly:

```bash
curl -s -o /dev/null -w "workflows:   %{http_code}\n" -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_BASE_URL/workflows?limit=1"
curl -s -o /dev/null -w "data-tables: %{http_code}\n" -H "X-N8N-API-KEY: $N8N_API_KEY" "$N8N_BASE_URL/data-tables?limit=1"
```

For verbose node logs, set `N8N_LOG_LEVEL=debug` — the node logs every request URL and the
full URL + status on failure (visible via `docker logs <container>`).
