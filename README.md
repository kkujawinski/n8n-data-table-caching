# n8n-nodes-datatable-cache

A community node that turns the "store cache in a data table" pattern into a single,
reusable **Data Table Cache** node for n8n. It gives you a read-through / write-back cache
backed by an n8n [data table](https://docs.n8n.io/data/data-tables/), with hit/miss routing
and TTL expiry.

> **Status: experimental.** n8n data tables are a Beta feature and have **no public,
> supported API for nodes** yet (see [Data access](#data-access--the-fragile-part) below).
> This node talks to the internal REST endpoint, which can change between n8n versions.
> Pin your n8n version and re-test after upgrades.

## What it does

- **Lookup** — read a row by cache key and route the item to **Cache Hit** or **Cache Miss**.
  Hits older than the configured **Max Age** are routed to **Cache Miss** instead (and the
  stale row is attached as `_staleRow` for debugging). A hit bumps `last_access`.
- **Store** — upsert the input item's JSON as the payload plus `last_modified` / `last_access`
  timestamps, keyed by cache key.

Two outputs: index `0` = **Cache Hit**, index `1` = **Cache Miss**. `Store` always emits on
the **Cache Hit** output with `{ updated, key, payload }`, where `updated` is `true` if a row
for that key already existed (overwrite) or `false` if a new row was inserted.

## Install

Community node (n8n **Settings → Community Nodes → Install**):

```
n8n-nodes-datatable-cache
```

Or build and link locally:

```bash
npm install
npm run build
# then link the built package into your n8n custom nodes dir, e.g.
#   ln -s "$(pwd)" ~/.n8n/custom/n8n-nodes-datatable-cache
```

## Prepare a data table

Create a data table (n8n **Data tables** tab) with these **string** columns (names are
configurable on the node — these are the defaults):

| Column          | Purpose                                   |
| --------------- | ----------------------------------------- |
| `cache_key`     | The cache key (lookup/upsert match column) |
| `payload`       | `JSON.stringify` of the cached item        |
| `last_modified` | ISO timestamp of the last write            |
| `last_access`   | ISO timestamp of the last cache hit        |

The auto columns `id`, `createdAt`, `updatedAt` are added by n8n and are not used by the node.

## Credentials — `Data Table Cache API`

| Field            | Notes                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| **Base URL**     | Root URL of your n8n instance, e.g. `http://localhost:5678`            |
| **Project ID**   | The project that owns the table. From the project URL `/projects/<id>` |
| **Authentication** | `Session Cookie` (works today) or `API Key` (forward-compatible)    |
| **Session Cookie** | The `n8n-auth` cookie value from a logged-in browser session         |
| **Browser ID**   | The `browser-id` header value sent by the n8n UI                       |
| **API Key**      | An n8n API key (only once the public data-table API ships)             |

### Why a session cookie?

As of n8n 2.x, data-table row CRUD is only reachable via the internal
`/rest/projects/{projectId}/data-tables/...` route, which is authenticated by the browser
session cookie — **not** by an n8n API key (the public `/api/v1` data-table endpoints are
still an open feature request). To grab the values: open n8n in your browser while logged in,
open DevTools → **Application → Cookies** for the `n8n-auth` value, and **Network** → any
`/rest/...` request → Request Headers for `browser-id`. When the public API ships, switch the
credential to **API Key** — no workflow changes needed.

## Node parameters

| Parameter            | Default         | Notes                                            |
| -------------------- | --------------- | ------------------------------------------------ |
| Operation            | `Lookup`        | `Lookup` or `Store`                              |
| Data Table           | —               | Pick from list or enter the table ID             |
| Key Column           | `cache_key`     | Column matched against the cache key             |
| Cache Key            | —               | Expression-friendly; the value to look up / store |
| Payload Column       | `payload`       | Holds the stringified payload                    |
| Last Modified Column | `last_modified` | ISO datetime of last write                       |
| Last Access Column   | `last_access`   | ISO datetime of last hit                         |
| Max Age + Unit       | `3600` seconds  | TTL; a hit older than this becomes a miss        |
| Measure From         | `Last Modified` | Whether TTL counts from `last_modified` or `last_access` |

## Example flow

```
Trigger ─▶ Data Table Cache (Lookup)
                 ├─ Cache Hit  ─▶ use cached payload
                 └─ Cache Miss ─▶ do the expensive work ─▶ Data Table Cache (Store) ─▶ continue
```

## Notes & limitations

- **Concurrency:** last-write-wins. Acceptable for a cache; do not use as a transactional store.
- **Malformed payload:** a non-JSON / legacy payload degrades gracefully — a hit returns
  `{ _raw: <value> }` rather than throwing.
- **Expiry:** TTL only for now. Filter-condition ("reuse the IF builder") expiry is planned;
  it depends on a mutation-then-evaluate workaround that must be validated per n8n version.
- **Continue On Fail:** when enabled, a row that errors is routed to **Cache Miss** with an
  `error` field instead of failing the execution.

## Data access — the fragile part

All data-table I/O is isolated behind a small `CacheStore` interface
(`nodes/DataTableCache/stores/`). Today the only implementation is `HttpCacheStore`, which
calls the internal REST API. The single line to revisit on every n8n upgrade is the route /
auth construction in `stores/client.ts` (`dataTableRequest`). Swapping to a future in-process
DI service or the public `/api/v1` API means adding one `CacheStore` implementation and
selecting it in `stores/makeStore.ts` — `execute` does not change.

## Development

```bash
npm install
npm run build   # tsc + copy icon/codex assets to dist/
npm run lint
npm run dev     # tsc --watch
```

## License

[MIT](LICENSE)
