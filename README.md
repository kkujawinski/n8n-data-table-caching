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

A single read-through cache node, wired like the **Loop Over Items** node — one input, two
outputs, and a cycle:

```
        ┌────────── Data Table Cache ──────────┐
input ─▶ │  hit  → Continue (cached payload)    │──▶ continue
         │  miss → Process                      │──▶ expensive work ─┐
         │  (loop-back: store, then → Continue) │◀──────────────────-┘
         └──────────────────────────────────────┘
```

- **First pass (lookup).** Read the row by cache key. A fresh hit is emitted on **Continue**
  with the parsed payload (and `last_access` is bumped). A miss — or a hit older than **Max
  Age** — is emitted on **Process**, and the key is remembered for this execution. Expired
  hits also attach the stale row as `_staleRow` for debugging.
- **Loop-back pass (store).** Wire the **Process** output through your work and back into the
  node's input. When the processed item returns, the node upserts it (payload +
  `last_modified` + `last_access`) and emits it on **Continue**.

Outputs: index `0` = **Continue**, index `1` = **Process**.

### Important: the cache key must survive your processing

Pass detection (lookup vs. store) uses per-execution node state keyed by the **cache key**,
and the key is **recomputed from the returned item** on the loop-back. So derive the Cache Key
from a field your processing nodes preserve (a record key, order number, etc.). If the key
can't be recomputed to the same value on the way back, the item won't be recognised as a store
pass — it'll be treated as a fresh lookup and loop again. (This is the documented tradeoff of
the single-node loop design.)

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
| Data Table           | —               | Pick from list or enter the table ID             |
| Key Column           | `cache_key`     | Column matched against the cache key             |
| Cache Key            | —               | Expression-friendly; derive from a field that survives processing |
| Payload Column       | `payload`       | Holds the stringified payload                    |
| Last Modified Column | `last_modified` | ISO datetime of last write                       |
| Last Access Column   | `last_access`   | ISO datetime of last hit                         |
| Max Age + Unit       | `3600` seconds  | TTL; a hit older than this becomes a miss        |
| Measure From         | `Last Modified` | Whether TTL counts from `last_modified` or `last_access` |

## Example flow

```
Trigger ─▶ Data Table Cache ─ Continue ─▶ use payload (cached or freshly stored) ─▶ …
                            └ Process  ─▶ expensive work ─┐
                              ▲────────── loop back ──────┘
```

Wire **Process** through your work and back into the node's input; wire **Continue** onward.
On a hit it fires immediately; on a miss it fires after the loop-back stores the result.

## Notes & limitations

- **Cache key must survive processing** — see [above](#important-the-cache-key-must-survive-your-processing).
  If a returned item's key can't be recomputed, it loops again instead of being stored.
- **Concurrency:** last-write-wins. Acceptable for a cache; do not use as a transactional store.
- **Malformed payload:** a non-JSON / legacy payload degrades gracefully — a hit returns
  `{ _raw: <value> }` rather than throwing.
- **Expiry:** TTL only for now. Filter-condition ("reuse the IF builder") expiry is planned;
  it depends on a mutation-then-evaluate workaround that must be validated per n8n version.
- **Continue On Fail:** when enabled, a row that errors is emitted on **Continue** (never
  back into the loop) with an `error` field, instead of failing the execution.

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
