# n8n-nodes-datatable-cache

A **Data Table Cache** node for n8n: a read-through / write-back cache backed by an n8n
[data table](https://docs.n8n.io/data/data-tables/), with hit/miss routing and TTL expiry.

> **Requirements:** an n8n version whose public API serves `/api/v1/data-tables` (older
> instances return 404), and `executionOrder: v1` (the default on recent n8n).

## What it does

Two inputs (`Input`, `Update`), two outputs (`Cache Hit`, `Cache Miss`), wired as a loop:

```
 Input  ─▶ ┌─ Data Table Cache ─┐ ─▶ Cache Hit  → use payload
 Update ─▶ └────────────────────┘ ─▶ Cache Miss → work ─┐
                ▲──────────────── Update ───────────────┘
```

- **Input** — look up by key. A fresh hit emits the cached payload on **Cache Hit**; a miss or
  expired hit emits the item on **Cache Miss** (with the stale row under `_staleRow`).
- **Update** — write processed items back; each is upserted and re-emitted on **Cache Hit**.

Wire it as a loop: **Cache Miss → your work → the Update input**; take **Cache Hit** onward.

➡️ **[Usage guide](docs/USAGE.md)** — table setup, credential, an importable example workflow,
TTL, and evicting expired rows.

## Install

Community node (n8n **Settings → Community Nodes → Install**): `n8n-nodes-datatable-cache`.

## Setup (quick)

- **Data table** with columns `cache_key`, `payload`, `last_modified` (and optional
  `last_access`) — see the [guide](docs/USAGE.md#1-create-the-data-table-recommended-setup).
- **Credential:** the built-in **n8n API** credential — an API key (with `dataTable*` scopes)
  and a Base URL ending in `/api/v1`.

## Parameters

| Parameter            | Default         | Notes                                                |
| -------------------- | --------------- | ---------------------------------------------------- |
| Data Table           | —               | Pick from list or enter the table ID                 |
| Key Column           | `cache_key`     | Column matched against the cache key                 |
| Cache Key            | —               | Value to look up (Input) or store under (Update)     |
| Payload Column       | `payload`       | Holds the JSON-stringified payload                   |
| Last Modified Column | `last_modified` | ISO timestamp of the last write                      |
| Last Access Column   | `last_access`   | ISO timestamp of the last hit (optional; leave empty to skip) |
| Max Age + Unit       | `3600` s        | A hit older than this becomes a miss                 |
| Measure From         | `Last Modified` | Whether TTL counts from `last_modified` or `last_access` |

## Limitations

- **Expiry:** TTL only (filter-condition mode planned).
- **Concurrency:** last-write-wins — fine for a cache, not for transactional data.
- **Malformed payload:** degrades to `{ _raw: <value> }` rather than throwing.
- **Continue On Fail:** errored items are emitted with an `error` field (lookup → Cache Miss,
  store → Cache Hit) instead of failing the run.

## Development

```bash
npm install
npm run build   # tsc + copy assets to dist/
npm run lint
```

All data-table I/O is isolated in `nodes/DataTableCache/stores/` behind the `CacheStore`
interface; `client.ts` (`dataTableRequest`) is the single line to revisit on n8n API changes.

## License

[MIT](LICENSE)
