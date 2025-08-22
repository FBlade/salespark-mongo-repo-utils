# SalesPark Mongo Repository Utilities v1 - Documentation

## @salespark/mongo-repo-utils

Utility helpers for MongoDB/Mongoose repositories with caching hooks, metrics, safe return contract, and flexible model resolution.

---

## 📦 Installation

```bash
yarn add @salespark/mongo-repo-utils
# or
npm install @salespark/mongo-repo-utils
```

Peer requirement:

- `mongoose >= 7`

---

All exported functions return a consistent shape:

```js
{ status: Boolean, data: any }
```

- `status: true` → success, `data` holds the result
- `status: false` → failure, `data` holds the error object

### Examples (return shape):

```js
// getOne - document found
{
  status: true,
  data: {
    _id: "507f1f77bcf86cd799439011",
    email: "user@example.com",
    name: "John Doe",
    createdAt: "2025-08-20T10:30:00.000Z"
  }
}

// Error / Catch
{
  status: false,
  data:  "<error content>"
}

```

---

## Quick start

```js
const path = require("path");
const db = require("@salespark/mongo-repo-utils");

// 1) Tell the repo where your models live
db.setModelsDir(path.join(__dirname, "models"));

// or via environment variable (.env):
// SP_MONGO_REPO_MODELS_DIR=/abs/path/to/models

// 2) (Optional) Inject a logger
// Preferred: a function (err, ctx) => void
db.setLogger((err, ctx) => {
  console.error("LOG:", ctx, err);
});

// Alternative: an object, e.g. console
db.setLogger(console);

// 3) (Optional) Inject a cache with { get, put, del, keys }
const simpleCache = new Map();
db.setCache({
  get: (k) => simpleCache.get(k),
  put: (k, v, ttlMs) => {
    simpleCache.set(k, v);
    setTimeout(() => simpleCache.delete(k), ttlMs || 60_000);
  },
  del: (k) => simpleCache.delete(k),
  keys: () => Array.from(simpleCache.keys()),
});

// 4) Use repository helpers
(async () => {
  const r = await db.getOne("users", { email: "a@b.com" }, null, { enabled: true, ttl: 120_000 });
  if (!r.status) {
    console.error("Failed:", r.data);
  } else {
    console.log("User:", r.data);
  }
})();
```

---

## Configuration

### Models directory (required)

Priority:

1. Value provided via `setModelsDir(dir)`
2. Environment variable `SP_MONGO_REPO_MODELS_DIR`
3. Default models directory (`./models`) if none defined
4. Otherwise an error is thrown on first model resolution

```js
db.setModelsDir(path.join(__dirname, "models"));
// or via environment variable (.env):
// SP_MONGO_REPO_MODELS_DIR=/abs/path/to/models
```

**Resolution rules:**

- You can pass a Mongoose Model instance directly _or_ a string name.
- When a string name is used, the module will:
  1. Try `mongoose.models[name]`
  2. Require a file at `<MODELS_DIR>/<name>` that exports/registers the model
- A simple pluralization is applied if `name` does not end with `s` (e.g. `"user"` → `"users"`).

### Logger injection (optional)

Preferred: provide a function `(err, ctx) => void`.

```js
db.setLogger((err, ctx) => {
  console.error("LOG:", ctx, err);
});

// Or adapt an object logger
db.setLogger(console.error);
```

### Cache injection (optional)

Provide an object with the interface `{ get(key), put(key, value, ttlMs), del(key), keys() }`.  
If the provided cache doesn't have the required `get` function, it falls back to a no-op cache.
If no cache is provided, reads run uncached and writes still work (they will try to invalidate only if a cache exists).

```js
db.setCache({
  get: (key) => {
    /* ... */
  },
  put: (key, val, ttlMs) => {
    /* ... */
  },
  del: (key) => {
    /* ... */
  },
  keys: () => {
    /* ... */
  },
});

// Invalid cache will fallback to no-op
db.setCache({}); // Falls back to no-op cache
```

---

## Caching on reads

Read helpers accept `cacheOpts`:

```ts
// shape (JS only, shown as reference)
{
  enabled?: boolean;          // default true if object provided
  key?: string;               // explicit cache key; otherwise an auto key is built
  ttl?: number | string;      // milliseconds (number) or string: \"500ms\", \"30s\", \"5m\", \"4h\", \"2d\"; default 60_000 ms
  cacheIf?: (res) => boolean; // default: caches only if res.status === true
}
```

When `key` is omitted, the module builds a deterministic key from:
`<fnName>:<normalizedModelName>:<hash(args)>`.

---

## Cache invalidation on writes

All write helpers accept a flexible `writeArg`:

- **Legacy (string or string[])** → invalidation keys
- **Direct options** → `{ session, runValidators, writeConcern, ordered, ... }`
- **Combined** → `{ options: {...}, invalidateKeys?: string|string[], invalidatePrefixes?: string|string[] }`

Examples:

```js
// Invalidate a specific key (legacy style)
await db.updateOne("users", { _id }, { $set: { name: "Alice" } }, "user:42");

// Combined: runValidators + invalidate prefixes
await db.updateMany(
  "orders",
  { status: "processing" },
  { $set: { status: "paid" } },
  { options: { runValidators: true }, invalidatePrefixes: ["orders:list:", "getMany:orders:"] }
);
```

> Note: manual `invalidateCache()` is internal; writes can trigger invalidation if you pass keys/prefixes as above.

---

## API surface (selected)

> All functions return `{ status, data }`.

### Read

- `getOne(modelOrName, filter, select?, populate?, cacheOpts?)`
- `getMany(modelOrName, filter, select?, sort?, populate?, cacheOpts?)`
- `aggregate(modelOrName, pipeline, cacheOpts?)` — Executes a MongoDB aggregation pipeline.
- `getManyWithPagination(modelOrName, filter, select?, sort?, page?, limit?, populate?, cacheOpts?)`
- `countDocuments(modelOrName, filter, cacheOpts?)`

---

**Examples**

```js
// getOne with populate
await db.getOne(
  "orders", // collection
  { _id: "123" }, // filter
  null, // projection
  { path: "customer", select: "name email" }, // populate
  { enabled: true, ttl: "1h" } // cache
);

// getMany with single populate
await db.getMany(
  "orders", // collection
  { status: "paid" }, // filter
  ["_id", "total"], // projection
  { createdAt: -1 }, // sort
  { path: "customer", select: "name email" }, // populate
  { enabled: true, key: "orders:paid:list:v1", ttl: 30_000 } // cache
);

// getMany with multiple populates
await db.getMany(
  "orders", // collection
  { status: "paid" }, // filter
  ["_id", "total"], // projection
  { createdAt: -1 }, // sort
  // populate (multiple)
  [
    { path: "products", select: ["field1", "field2"] },
    { path: "customer", select: "name email" },
  ],
  { enabled: true } // cache
);

// aggregate
await db.aggregate("orders", [{ $match: { status: "paid" } }, { $group: { _id: "$userId", total: { $sum: "$amount" } } }], { enabled: true, ttl: "5m" });

// getManyWithPagination with populate
const paged = await db.getManyWithPagination(
  "products", // collection
  { active: true }, // filter
  ["_id", "title"], // projection
  { createdAt: -1 }, // sort
  2, // page
  20, // limit
  { path: "category", select: "name" }, // populate
  { enabled: true, key: "products:active:p2:l20" } // cache
);

// getManyWithPagination with multiple populates
const pagedMulti = await db.getManyWithPagination(
  "orders", // collection
  { status: "active" }, // filter
  ["_id", "total"], // projection
  { createdAt: -1 }, // sort
  1, // page
  10, // limit
  // populate
  [
    { path: "products", select: ["field1", "field2"] },
    { path: "customer", select: "name email" },
  ],
  { enabled: true } // cache
);

// countDocuments
await db.countDocuments("orders", { status: "processing" }, { enabled: true, ttl: "5m" });
```

### Write

- `createOne(modelOrName, payload, writeArg?)`
- `createMany(modelOrName, docs, writeArg?)`
- `updateOne(modelOrName, filter, data, writeArg?)`
- `updateMany(modelOrName, filter, data, writeArg?)`
- `deleteOne(modelOrName, filter, writeArg?)`
- `deleteMany(modelOrName, filter, writeArg?)`
- `upsertOne(modelOrName, filter, data, writeArg?)` (always enforces `{ upsert: true }`)

**Examples**

```js
await db.createOne("logs", { type: "signup", user: userId });

await db.createMany("products", [{ sku: "X" }, { sku: "Y" }], { options: { ordered: false, runValidators: true } });

await db.upsertOne("inventory", { sku: "ABC-001" }, { $inc: { stock: 10 } }, { invalidatePrefixes: ["inventory:"] });
```

### Transactions

- `withTransaction(workFn, txOptions?)`

```js
await db.withTransaction(
  async (session) => {
    const a = await db.updateOne("wallets", { _id: fromId }, { $inc: { balance: -100 } }, { session });
    if (!a.status) throw a.data;

    const b = await db.updateOne("wallets", { _id: toId }, { $inc: { balance: +100 } }, { session });
    if (!b.status) throw b.data;

    await db.createOne("transfers", { fromId, toId, amount: 100 }, { session });
  },
  { readConcern: "snapshot", writeConcern: { w: "majority" }, maxCommitRetries: 2 }
);
```

### Utilities

- `safeQuery(fnOrExportedName, ...args)` — runs and always returns `{ status, data }`
- `getMetrics()` — snapshot of DB/cache timings per operation
- `resetMetrics()` — clears metrics
- `resolveModel(modelOrName)` — resolves a model instance or requires from `<MODELS_DIR>/<name>`
- `invalidateCache(input)` — manually invalidate cache by keys and/or prefixes

**invalidateCache examples:**

```js
// Invalidate specific keys
await db.invalidateCache("user:123");
await db.invalidateCache(["user:123", "user:456"]);

// Invalidate by prefixes
await db.invalidateCache({ prefixes: "orders:list:" });

// Combined
await db.invalidateCache({
  keys: ["user:123"],
  prefixes: ["orders:", "products:"],
});
```

---

### Monitoring & Metrics

```js
// Get current metrics
const metrics = db.getMetrics();
console.log("Cache hit rate:", metrics.cache.hits / (metrics.cache.hits + metrics.cache.misses));
console.log("DB operations:", Object.keys(metrics.db.perOp));

// Reset metrics (useful for periodic monitoring)
db.resetMetrics();
```

---

### Metrics Structure

`getMetrics()` returns:

```js
{
  cache: {
    hits: number,
    misses: number,
    puts: number,
    invalidations: number
  },
  db: {
    perOp: {
      "operationName:modelName": {
        count: number,
        totalMs: number,
        minMs: number,
        maxMs: number
      }
    }
  }
}
```

---

### TTL (Time To Live) Support

TTL accepts:

- **number**: milliseconds (0 disables caching for most stores)
- **string**: `"<int>[unit]"` where unit is `ms|s|m|h|d` (case-insensitive)
  - Examples: `"500ms"`, `"30s"`, `"5m"`, `"4h"`, `"2d"`, `"60000"`
  - Unit defaults to `ms` when omitted: `"60000"` = `"60000ms"`

**Fallback behavior:**

- Invalid/unparseable values → `DEFAULT_TTL` (60,000ms)
- Negative numbers → 0 (no caching)
- `null`/`undefined` → `DEFAULT_TTL`

---

## Error handling

- On failure, functions return `{ status: false, data: error }`.
- If a logger was injected, errors are reported via `logger(err, ctx)`.

---

## Notes & conventions

- Model name strings are auto-pluralized if they do not end with `s` (e.g. `"user"` → `"users"`).
- When requiring by name, files are loaded from `SP_MONGO_REPO_MODELS_DIR` (or the value set with `setModelsDir`).
- Cache is **opt-in**: reads only use it if `cacheOpts` is provided; writes can request invalidation via `writeArg`.

---

### 🔒 Internal Usage Notice

This package is primarily designed and maintained for internal use within the SalesPark ecosystem.
While it can technically be used in other Node.js/Mongoose projects, no official support or guarantees are provided outside of SalesPark-managed projects.

All code follows the same engineering standards applied across the SalesPark platform, ensuring consistency, reliability, and long-term maintainability of our internal systems.

⚡ Note: This package is most efficient and works best when used together with other official SalesPark packages, where interoperability and optimizations are fully leveraged.

Disclaimer: This software is provided “as is”, without warranties of any kind, express or implied. SalesPark shall not be held liable for any issues, damages, or losses arising from its use outside the intended SalesPark environment.

Organization packages: https://www.npmjs.com/org/salespark

---

## 📄 License

MIT © [SalesPark](https://salespark.io)

---

_Document version: 6_  
_Last update: 22-08-2025_
