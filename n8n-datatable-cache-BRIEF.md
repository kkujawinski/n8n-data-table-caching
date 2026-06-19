# n8n Community Node — Data Table Cache

**Build brief for Claude Code.** This document is the grounding spec for building an n8n
community node that turns a "store cache in a data table" workflow pattern into a single
reusable node. Treat it as the source of truth; everything below is either a verified fact,
a design decision, or an explicit open decision flagged as such.

- **Package name (proposed):** `n8n-nodes-datatable-cache`
- **Node display name:** `Data Table Cache`
- **Language / style:** TypeScript, programmatic-style node (needs custom `execute`).
- **Target:** self-hosted n8n (data tables are a Beta feature).

---

## 0. The one hard constraint — read first

n8n **data tables have no clean, supported, programmatic API for nodes** as of early 2026.

- Data tables are **Beta**, introduced in **v1.113.0**. New tables ship with default columns
  `id`, `createdAt`, `updatedAt`.
- The official docs state directly: *direct programmatic access to data tables from a Code node
  is not supported; you cannot access data table values via built-in methods or variables.*
- There is **no** documented node helper (no `this.helpers.dataTable`).
- The three sanctioned access paths are: the **Data Table node**, the **UI tab**, and a
  **REST endpoint**. Public-API (`/api/v1/`) row CRUD for data tables is still an **open feature
  request (Dec 2025)**. The working internal route `/rest/data-tables-global/...` is
  **cookie-authenticated**, not API-key — not cleanly reachable from a node.

**Implication:** the data read/write layer is the only genuinely hard/fragile part of this node.
The whole design isolates it behind an interface (`CacheStore`) so it can be swapped without
touching the node logic. Everything else (params, expiry, routing) is straightforward and
upgrade-safe.

### Data-access options (DECISION REQUIRED)

| Option | What it is | Robustness | Works on Cloud? | Recommendation |
|---|---|---|---|---|
| **1. Brain node + Data Table nodes** | Node owns logic only; real reads/writes done by standard Data Table `Get`/`Upsert` nodes wired around it | High, upgrade-safe | Yes | Ship-today fallback |
| **2. Self-contained via internal DI service** | `execute()` pulls the internal data-store service from n8n's DI container in-process | Fragile — internal `@n8n/*` packages, no semver guarantee, breaks on upgrade | No | The "one node" UX, self-hosted + pinned version only |
| **3. HTTP to n8n API** | Node calls REST endpoints via `this.helpers.httpRequest` | Clean *once public API lands*; unreliable today | Yes (future) | Forward-compatible target |

> **Default for this build:** implement the `CacheStore` interface (below) and wire **Option 2**
> for the immediate self-hosted use case, while keeping the interface ready for **Option 3**.
> If portability/Cloud matters more than the single-node UX, switch to **Option 1**.
> **Kamil to confirm before scaffolding the access layer.**

For **Option 2**, do **not** hardcode a guessed import path. Locate the service the built-in
Data Table node actually injects: search the installed n8n source for the data-table row
repository/service that is registered in the DI container (`@n8n/di` `Container.get(...)`),
confirm the export path on the *pinned* n8n version, and depend on it explicitly. Treat that
import as the single fragile line to revisit on every n8n upgrade.

---

## 1. Node interface

### Inputs / outputs (DECISION — defaulted)

Original idea was two physical inputs (`input`, `update`). Two named inputs are legal but
inherit **Merge-style execution semantics** (the node waits for all connected inputs to have
run), which is awkward when an execution does *either* a lookup *or* a write, never both.

**Default decision:** **single input + `operation` selector** (`Lookup` / `Store`). Two outputs.

- **Input:** 1 × `Main`
- **Outputs:** 2 × `Main` → `outputNames: ['Cache Hit', 'Cache Miss']` (index 0 = hit, 1 = miss)
- The `hit`/`miss` split is only meaningful for `Lookup`. `Store` returns on a single path
  (decide: pass-through input, or emit a small status object).

> If a genuine graph reason requires two physical inputs, switch `inputs` to
> `[Main, Main]` with `inputNames: ['Input', 'Update']` and branch in `execute` on which
> input index carries data — but expect the Merge-style "wait for all inputs" behavior.

### Parameters

| Param | Name (internal) | Type | Notes |
|---|---|---|---|
| Operation | `operation` | `options` | `lookup` \| `store`; `noDataExpression: true` |
| Data Table | `dataTableId` | `resourceLocator` | Mirror the built-in Data Table node's locator (modes: list / by id / by name) |
| Cache Key | `cacheKey` | `string` | required; expression-friendly |
| Payload Column | `payloadCol` | `string` | default `payload`; holds `JSON.stringify(payload)` |
| Last Modified Column | `modifiedCol` | `string` | default `last_modified` (ISO datetime) |
| Last Access Column | `accessCol` | `string` | default `last_access` (ISO datetime) |
| Expiry Mode | `expiryMode` | `options` | `ttl` \| `filter`; shown only for `lookup` |
| Max Age | `ttl` | `number` | shown for `lookup` + `ttl` |
| Unit | `ttlUnit` | `options` | ms multipliers: sec=1000, min=60000, hour=3600000, day=86400000 |
| Measure From | `ttlFrom` | `options` | `modified` \| `access`; which timestamp TTL counts from |
| Expired When | `expiry` | `filter` | shown for `lookup` + `filter`; see §3 |

---

## 2. Behavior spec

**`Lookup`** (per input item):
1. Read the row from the configured table by `cacheKey`.
2. **Cache miss** (no row) → route item to **Cache Miss** output.
3. **Cache hit + expired** → route to **Cache Miss** output (optionally attach the stale row
   under `_staleRow` for debugging).
4. **Cache hit + not expired** → update `last_access` to now, then emit the parsed payload
   on the **Cache Hit** output.

**`Store`** (per input item):
1. Upsert the row keyed by `cacheKey` with:
   - `payloadCol = JSON.stringify(item.json)`
   - `modifiedCol = now (ISO)`
   - `accessCol   = now (ISO)`
2. Emit status/pass-through.

**Notes**
- All timestamps ISO 8601 (`new Date().toISOString()`).
- `JSON.parse` of the stored payload must be guarded (`safeParse`) — a malformed/legacy row
  should degrade to a miss rather than throw.
- Decide concurrency expectations: last-write-wins is acceptable for a cache; document it.

---

## 3. Expiry — "reuse the IF conditions"

Two supported modes.

### TTL (default, robust)
Deterministic, no expression-context issues:
```
const ageMs = Date.now() - new Date(row[fromCol]).getTime();
const expired = ageMs > (ttl * ttlUnit);   // fromCol = modifiedCol or accessCol per ttlFrom
```

### Filter conditions (the "reuse IF node UI" path)
- A property of `type: 'filter'` renders the **exact IF/Filter conditions builder**, and
  `this.getNodeParameter('expiry', i)` returns an **evaluated boolean**.
- **Caveat that must be handled:** the filter's left-hand expressions resolve against the
  **current input item's `$json`**, *not* against the fetched cache row. So
  `{{ $json.last_modified }}` points at the input, not the row.
- **Workaround:** before reading the `expiry` param, merge the fetched row's fields into the
  item's `json` that the expression engine sees, then read the boolean. This mutation-then-
  evaluate pattern works but is **not contractually guaranteed across versions** — gate it
  behind a test on the pinned n8n version. If it proves unstable, fall back to TTL or to a
  single expression string evaluated via `this.evaluateExpression`.

---

## 4. Code skeleton

`nodes/DataTableCache/DataTableCache.node.ts` (skeleton — fill `makeStore`, `isExpired`,
`safeParse`):

```typescript
import {
  IExecuteFunctions,
  INodeType,
  INodeTypeDescription,
  INodeExecutionData,
  NodeConnectionType,
} from 'n8n-workflow';

export class DataTableCache implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Data Table Cache',
    name: 'dataTableCache',
    icon: 'file:datatablecache.svg',
    group: ['transform'],
    version: 1,
    description: 'Read-through / write-back cache backed by an n8n data table',
    defaults: { name: 'Data Table Cache' },
    inputs: [NodeConnectionType.Main],
    outputs: [NodeConnectionType.Main, NodeConnectionType.Main],
    outputNames: ['Cache Hit', 'Cache Miss'],
    properties: [
      {
        displayName: 'Operation', name: 'operation', type: 'options', noDataExpression: true,
        options: [
          { name: 'Lookup', value: 'lookup', description: 'Check cache; route hit/miss' },
          { name: 'Store',  value: 'store',  description: 'Write payload + timestamps' },
        ],
        default: 'lookup',
      },
      {
        displayName: 'Data Table', name: 'dataTableId', type: 'resourceLocator',
        default: { mode: 'list', value: '' },
        modes: [ /* mirror the built-in Data Table node's locator: list + byId + byName */ ],
      },
      { displayName: 'Cache Key', name: 'cacheKey', type: 'string', default: '', required: true },
      { displayName: 'Payload Column',       name: 'payloadCol',  type: 'string', default: 'payload' },
      { displayName: 'Last Modified Column', name: 'modifiedCol', type: 'string', default: 'last_modified' },
      { displayName: 'Last Access Column',   name: 'accessCol',   type: 'string', default: 'last_access' },
      {
        displayName: 'Expiry Mode', name: 'expiryMode', type: 'options',
        options: [ { name: 'TTL', value: 'ttl' }, { name: 'Conditions', value: 'filter' } ],
        default: 'ttl',
        displayOptions: { show: { operation: ['lookup'] } },
      },
      {
        displayName: 'Max Age', name: 'ttl', type: 'number', default: 3600,
        displayOptions: { show: { operation: ['lookup'], expiryMode: ['ttl'] } },
      },
      {
        displayName: 'Unit', name: 'ttlUnit', type: 'options',
        options: [
          { name: 'Seconds', value: 1000 }, { name: 'Minutes', value: 60000 },
          { name: 'Hours', value: 3600000 }, { name: 'Days', value: 86400000 },
        ],
        default: 1000,
        displayOptions: { show: { operation: ['lookup'], expiryMode: ['ttl'] } },
      },
      {
        displayName: 'Measure From', name: 'ttlFrom', type: 'options',
        options: [ { name: 'Last Modified', value: 'modified' }, { name: 'Last Access', value: 'access' } ],
        default: 'modified',
        displayOptions: { show: { operation: ['lookup'], expiryMode: ['ttl'] } },
      },
      {
        displayName: 'Expired When', name: 'expiry', type: 'filter', default: {},
        displayOptions: { show: { operation: ['lookup'], expiryMode: ['filter'] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const hit: INodeExecutionData[] = [];
    const miss: INodeExecutionData[] = [];
    const store = makeStore(this); // <-- swappable CacheStore impl (DI / HTTP / wired)

    for (let i = 0; i < items.length; i++) {
      const op = this.getNodeParameter('operation', i) as string;
      const key = this.getNodeParameter('cacheKey', i) as string;
      const tableId = this.getNodeParameter('dataTableId', i, '', { extractValue: true }) as string;
      const payloadCol  = this.getNodeParameter('payloadCol', i) as string;
      const modifiedCol = this.getNodeParameter('modifiedCol', i) as string;
      const accessCol   = this.getNodeParameter('accessCol', i) as string;

      if (op === 'store') {
        const now = new Date().toISOString();
        await store.upsert(tableId, key, {
          [payloadCol]: JSON.stringify(items[i].json),
          [modifiedCol]: now,
          [accessCol]: now,
        });
        hit.push({ json: { cached: true, key } }); // or pass through items[i]
        continue;
      }

      // lookup
      const row = await store.get(tableId, key);
      if (!row) { miss.push(items[i]); continue; }

      const expired = await isExpired(this, i, row, modifiedCol, accessCol);
      if (expired) { miss.push({ json: { ...items[i].json, _staleRow: row } }); continue; }

      await store.touch(tableId, key, { [accessCol]: new Date().toISOString() });
      hit.push({ json: safeParse(row[payloadCol]) });
    }

    return [hit, miss];
  }
}
```

### `CacheStore` interface (the swappable access layer)

```typescript
export interface CacheStore {
  get(tableId: string, key: string): Promise<Record<string, unknown> | null>;
  upsert(tableId: string, key: string, fields: Record<string, unknown>): Promise<void>;
  touch(tableId: string, key: string, fields: Record<string, unknown>): Promise<void>;
}
// makeStore(ctx): returns one of:
//   - DiCacheStore   (Option 2: Container.get(<internal data-store service>))
//   - HttpCacheStore (Option 3: this.helpers.httpRequest to the n8n REST endpoint)
```

`safeParse`: `try { return JSON.parse(s); } catch { return { _raw: s }; }`

`isExpired`: branch on `expiryMode` → TTL math (see §3) or filter-boolean (with the
merge-into-item caveat in §3).

---

## 5. Package layout to scaffold

```
n8n-nodes-datatable-cache/
├── package.json            # includes the "n8n" block (below) + keyword "n8n-community-node-package"
├── tsconfig.json
├── gulpfile.js             # copies the SVG icon into dist/
├── eslint config           # eslint-plugin-n8n-nodes-base (community-node lint rules)
├── .prettierrc.js
├── README.md
├── LICENSE
└── nodes/
    └── DataTableCache/
        ├── DataTableCache.node.ts
        ├── DataTableCache.node.json   # codex metadata (categories, docs links) — optional
        ├── stores/                    # CacheStore implementations
        │   ├── CacheStore.ts
        │   ├── DiCacheStore.ts
        │   └── HttpCacheStore.ts
        └── datatablecache.svg
```

`package.json` essentials:
```json
{
  "name": "n8n-nodes-datatable-cache",
  "keywords": ["n8n-community-node-package"],
  "n8n": {
    "n8nNodesApiVersion": 1,
    "nodes": ["dist/nodes/DataTableCache/DataTableCache.node.js"]
  },
  "scripts": {
    "build": "tsc && gulp build:icons",
    "dev": "tsc --watch",
    "lint": "eslint nodes --ext .ts"
  },
  "peerDependencies": { "n8n-workflow": "*" },
  "devDependencies": {
    "n8n-workflow": "*",
    "typescript": "*",
    "gulp": "*",
    "eslint-plugin-n8n-nodes-base": "*"
  }
}
```

> No credentials package is needed for Option 1/2. Option 3 (HTTP) may need an n8n API
> credential type — add a `credentials/` dir and `"credentials"` array under the `n8n` block
> only if you go that route.

---

## 6. Build plan (checklist for Claude Code)

1. [ ] Confirm the data-access option (§0). Default: Option 2, interface ready for Option 3.
2. [ ] Scaffold the package structure (§5); init git; set up tsconfig + lint + gulp.
3. [ ] Implement `DataTableCache.node.ts` description + `execute` per §4.
4. [ ] Implement `CacheStore` interface + chosen impl. For DI: discover the real service/export
       on the pinned n8n version — do not guess the import.
5. [ ] Implement `isExpired` (TTL first; filter mode behind a test — §3).
6. [ ] Add the SVG icon + gulp copy step.
7. [ ] `npm run build`; link into a local self-hosted n8n
       (`~/.n8n/custom` or `npm link`) and verify the node appears.
8. [ ] Manual acceptance tests (§7).
9. [ ] README with install + usage + the Beta/version caveats.

---

## 7. Acceptance test scenarios

- **Miss → store → hit:** lookup unknown key routes to Miss; store it; lookup again routes to
  Hit with the correct parsed payload.
- **Expiry (TTL):** stored row older than Max Age routes to Miss; fresh row routes to Hit.
- **last_access bump:** a Hit updates `last_access` but leaves `last_modified` unchanged.
- **Store overwrites:** re-storing an existing key updates payload + both timestamps (upsert).
- **Malformed payload:** a row with non-JSON payload degrades gracefully (miss or `_raw`),
  no thrown error.
- **Expiry (filter mode):** conditions referencing the row's timestamp evaluate correctly
  (validates the merge-into-item workaround on the pinned version).

---

## 8. Verified reference facts (for grounding; re-check on your n8n version)

- Data tables: Beta, since **v1.113.0**; default columns `id`, `createdAt`, `updatedAt`.
- Code node **cannot** access data tables; no node helper exists.
- Data Table node row ops: `get`, `insert`, `update`, `upsert`, `delete`.
  **Upsert** = update if the row exists, else insert.
- Row condition operators: Equals, Not Equals, Greater Than, ≥, Less Than, ≤, Is Empty,
  Is Not Empty.
- Public-API (`/api/v1/`) data-table row CRUD: **open feature request (Dec 2025)** — verify
  whether it has shipped before relying on Option 3.
- `type: 'filter'` parameter → `getNodeParameter` returns an evaluated **boolean**.

### Useful docs
- Data tables overview: https://docs.n8n.io/data/data-tables/
- Data Table node: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable/
- Row operations: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.datatable/rows/
- Creating nodes / HTTP helpers: https://docs.n8n.io/integrations/creating-nodes/build/reference/http-helpers/
- n8n public API: https://docs.n8n.io/api/

---

## 9. Open decisions to resolve in Claude Code

1. **Data-access option** (§0) — the one blocking decision.
2. **`Store` output shape** — pass-through input item vs. emit a status object.
3. **Filter expiry** — keep it, or ship TTL-only first and add filter mode once the
   merge-into-item workaround is verified on the target n8n version.
4. **Cloud support** — if required, Option 2 is out; use Option 1 or wait for Option 3.
