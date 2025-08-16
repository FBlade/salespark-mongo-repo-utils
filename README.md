# SalesPark Mongo Repository Utilities v1 - Documentation

## @salespark/mongo-repo-utils

Utility helpers for MongoDB/Mongoose repositories with caching hooks, metrics, safe return contract, and flexible model resolution.

All exported functions return a consistent shape:

```js
{ status: Boolean, data: any }
```

- `status: true` → success, `data` holds the result
- `status: false` → failure, `data` holds the error object

---

## Installation

```bash
npm install @salespark/mongo-repo-utils
# or
yarn add @salespark/mongo-repo-utils
```

Peer requirement:

- `mongoose >= 7`

---

## Quick start

```js
const path = require("path");
const repo = require("@salespark/mongo-repo-utils");

// 1) Tell the repo where your models live
repo.setModelsDir(path.join(__dirname, "models"));
// or via environment variable:
// export SP_MONGO_REPO_MODELS_DIR=/abs/path/to/models

// 2) (Optional) Inject a error logger implementing (err, ctx)
repo.setLogger(console.log);

// 3) (Optional) Inject a cache with { get, put, del, keys }
const simpleCache = new Map();
repo.setCache({
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
  const r = await repo.getOne("users", { email: "a@b.com" }, null, { enabled: true, ttl: 120_000 });
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
3. Otherwise an error is thrown on first model resolution

```js
repo.setModelsDir(path.join(__dirname, "models"));
// or
// export SP_MONGO_REPO_MODELS_DIR=/abs/path/to/models
```

**Resolution rules:**

- You can pass a Mongoose Model instance directly _or_ a string name.
- When a string name is used, the module will:
  1. Try `mongoose.models[name]`
  2. Require a file at `<MODELS_DIR>/<name>` that exports/registers the model
- A simple pluralization is applied if `name` does not end with `s` (e.g. `"user"` → `"users"`).

### Error Logger injection (optional)

Provide any object exposing `.error(err, ctx)`.

```js
repo.setLogger(console.log); // basic
// repo.setLogger(Sentry.captureException); // Sentry
// repo.setLogger(rollbar.error); // Rollbar
// repo.setLogger(pinoInstance); // any logger
// repo.setLogger(myCustomFunction); // or custom function
```

### Cache injection (optional)

Provide an object with the interface `{ get(key), put(key, value, ttlMs), del(key), keys() }`.  
If no cache is provided, reads run uncached and writes still work (they will try to invalidate only if a cache exists).

```js
repo.setCache({
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
```

---

## Caching on reads

Read helpers accept `cacheOpts`:

```ts
// shape (JS only, shown as reference)
{
  enabled?: boolean;          // default true if object provided
  key?: string;               // explicit cache key; otherwise an auto key is built
  ttl?: number;               // default 60_000 ms
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
await repo.updateOne("users", { _id }, { $set: { name: "Alice" } }, "user:42");

// Combined: runValidators + invalidate prefixes
await repo.updateMany(
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

- `getOne(modelOrName, filter, select?, cacheOpts?)`
- `getMany(modelOrName, filter, select?, sort?, cacheOpts?)`
- `getManyWithPagination(modelOrName, filter, select?, sort?, page?, limit?, cacheOpts?)`
- `countDocuments(modelOrName, filter, cacheOpts?)`

**Examples**

```js
await repo.getOne("users", { email: "a@b.com" }, null, { enabled: true, ttl: 120_000 });

await repo.getMany("orders", { status: "paid" }, ["_id", "total"], { createdAt: -1 }, { enabled: true, key: "orders:paid:list:v1", ttl: 30_000 });

const paged = await repo.getManyWithPagination("products", { active: true }, ["_id", "title"], { createdAt: -1 }, 2, 20, {
  enabled: true,
  key: "products:active:p2:l20",
});

await repo.countDocuments("orders", { status: "processing" }, { enabled: true, ttl: 10_000 });
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
await repo.createOne("logs", { type: "signup", user: userId });

await repo.createMany("products", [{ sku: "X" }, { sku: "Y" }], { options: { ordered: false, runValidators: true } });

await repo.upsertOne("inventory", { sku: "ABC-001" }, { $inc: { stock: 10 } }, { invalidatePrefixes: ["inventory:"] });
```

### Transactions

- `withTransaction(workFn, txOptions?)`

```js
await repo.withTransaction(
  async (session) => {
    const a = await repo.updateOne("wallets", { _id: fromId }, { $inc: { balance: -100 } }, { session });
    if (!a.status) throw a.data;

    const b = await repo.updateOne("wallets", { _id: toId }, { $inc: { balance: +100 } }, { session });
    if (!b.status) throw b.data;

    await repo.createOne("transfers", { fromId, toId, amount: 100 }, { session });
  },
  { readConcern: "snapshot", writeConcern: { w: "majority" }, maxCommitRetries: 2 }
);
```

### Utilities

- `safeQuery(fnOrExportedName, ...args)` — runs and always returns `{ status, data }`
- `getMetrics()` — snapshot of DB/cache timings per operation
- `resetMetrics()` — clears metrics
- `resolveModel(modelOrName)` — resolves a model instance or requires from `<MODELS_DIR>/<name>`

---

## Error handling

- On failure, functions return `{ status: false, data: error }`.
- If a logger was injected, errors are reported via `logger.error(err, ctx)`.

---

## Notes & conventions

- Model name strings are auto-pluralized if they do not end with `s` (e.g. `"user"` → `"users"`).
- When requiring by name, files are loaded from `SP_MONGO_REPO_MODELS_DIR` (or the value set with `setModelsDir`).
- Cache is **opt-in**: reads only use it if `cacheOpts` is provided; writes can request invalidation via `writeArg`.

---

## 📄 License

MIT © [SalesPark](https://salespark.io)

---

_Document version: 1_  
_Last update: 16-08-2025_
