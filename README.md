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

All exported functions return a consistent contract:

```js
{ status: Boolean, data: any }
```

- `status: true` → success, `data` holds the result
- `status: false` → failure, `data` holds the error object

### Examples (return contract):

```js
 // getOne - document found
{
  status: true,
  data: {
    _id: "507f1f77bcf86cd799439011",
    email: "user@example.com",
    name: "John Doe",
    createdAt: "2024-08-20T10:30:00.000Z"
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
// With parameters
(async () => {
  const r = await db.getOne("users", { email: "a@b.com" }, null, { enabled: true, ttl: 120_000 });
  if (!r.status) {
    console.error("Failed:", r.data);
  } else {
    console.log("User:", r.data);
  }
})();

// With object
(async () => {
  const r = await db.getOne({ model: "users", filter: { email: "a@b.com" }, cacheOpts: { enabled: true, ttl: 120_000 } });
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
3. If neither is set, defaults to the `./models` directory
4. An error is only thrown if the default directory does not exist or the requested model cannot be found

```js
const { setModelsDir, setMongoose, loadModels } = require("@salespark/mongo-repo-utils");
const mongoose = require("mongoose"); // Your project's mongoose instance

// IMPORTANT: Share your mongoose instance with the package
setMongoose(mongoose);

setModelsDir(path.join(__dirname, "models"));
// or via environment variable (.env):
// SP_MONGO_REPO_MODELS_DIR=/abs/path/to/models
// Or folder ./models if nothing is set
```

**Sharing Mongoose Instance (IMPORTANT):**

To ensure models are properly shared between your application and this package, you must configure the mongoose instance:

```js
const mongoose = require("mongoose");
const { setMongoose } = require("@salespark/mongo-repo-utils");

// Share your mongoose instance with the package
setMongoose(mongoose);
```

**Why is this necessary?**

- When installed as a package, this library might use a different mongoose instance
- Models registered in one instance won't be available in another
- By sharing the instance, all models are registered in the same place

**Loading all models at startup:**

To ensure all models are registered before any populate operations, you can load them all at once:

```js
const { loadModels } = require("@salespark/mongo-repo-utils");

// Call this at application startup
const result = loadModels();
if (result.status) {
  console.log(`Loaded ${result.data.modelsRegistered} models from ${result.data.filesLoaded} files`);
  console.log(`Total models available: ${result.data.totalModels}`);
  console.log(`Files processed: ${result.data.filesProcessed}`);
  console.log(`Newly registered models: ${result.data.registeredModels.join(", ")}`);
  console.log(`All available models: ${result.data.allModels.join(", ")}`);
} else {
  console.error("Failed to load models:", result.data);
}
```

The `loadModels()` function:

- Scans **recursively** all `.js`, `.cjs`, and `.mjs` files in your models directory and subdirectories
- Supports organized folder structures (e.g., `models/auth/session.js`, `models/products/category.js`)
- Requires each file to register models with Mongoose
- Continues loading other files even if individual files fail
- Returns detailed statistics about the loading process including:
  - `loadedFiles`: Array of relative file paths that were successfully loaded
  - `registeredModels`: Array of model names that were newly registered
  - `allModels`: Array of all available model names in mongoose.models
- **Recommended**: Call this during application startup to ensure all models are available for populate operations

**Supported folder structure:**

The `loadModels()` function supports organized model directories with subdirectories:

```
models/
├── user.js                 # Basic user model
├── auth/                   # Authentication related models
│   ├── session.js
│   └── token.js
├── products/               # Product management models
│   ├── product.js
│   ├── category.js
│   └── inventory.js
└── orders/                 # Order processing models
    ├── order.js
    └── payment.js
```

All files will be discovered and loaded automatically, regardless of their depth in the directory structure.

**Resolution rules:**

- You can pass a Mongoose Model instance directly _or_ a string name.
- When a string name is used, the module will:
  1. Try `mongoose.models[name]`
  2. If not found, load ALL model files **recursively** from `<MODELS_DIR>` directory (supports `.js`, `.cjs`, `.mjs`)
  3. Check `mongoose.models[name]` after each file is loaded
- A simple pluralization is applied if `name` does not end with `s` (e.g. `"user"` → `"users"`).
- **Note**: Model names don't need to match filenames - the system will find models regardless of the file they're defined in.

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

- `getOne(modelOrObj, filter?, select?, sort?, populate?, cacheOpts?)`
- `getMany(modelOrObj, filter?, select?, sort?, populate?, cacheOpts?)`
- `getManyWithLimit(modelOrObj, filter?, select?, sort?, limit?, populate?, cacheOpts?)` — Get documents with a maximum limit (simple limiting without pagination metadata)
- `aggregate(modelOrObj, pipeline?, cacheOpts?)` — Executes a MongoDB aggregation pipeline.
- `getManyWithPagination(modelOrObj, filter?, select?, sort?, page?, limit?, populate?, cacheOpts?)`
- `countDocuments(modelOrObj, filter?, cacheOpts?)`

> **Note:** `getManyWithLimit` vs `getManyWithPagination`: Use `getManyWithLimit` when you need simple result limiting without pagination metadata. Use `getManyWithPagination` when you need full pagination with page info, total counts, and navigation metadata.

---

**Examples**

```js
// getOne with populate (parameters)
await db.getOne(
  "orders", // collection
  { _id: "123" }, // filter
  null, // projection
  null, // sort
  { path: "customer", select: "name email" }, // populate
  { enabled: true, ttl: "1h" } // cache
);

// getOne with sort (parameters) - get most recent order
await db.getOne(
  "orders", // collection
  { status: "pending" }, // filter
  null, // projection
  { createdAt: -1 }, // sort (most recent first)
  null, // populate
  { enabled: true, ttl: "5m" } // cache
);

// getOne with populate (object)
await db.getOne({ model: "orders", filter: { _id: "123" }, populate: { path: "customer", select: "name email" }, cacheOpts: { enabled: true, ttl: "1h" } });

// getOne with sort (object) - get highest scoring user
await db.getOne({
  model: "users",
  filter: { active: true },
  sort: { score: -1 },
  cacheOpts: { enabled: true, ttl: "10m" },
});

// getMany with single populate (parameters)
await db.getMany(
  "orders", // collection
  { status: "paid" }, // filter
  ["_id", "total"], // projection
  { createdAt: -1 }, // sort
  { path: "customer", select: "name email" }, // populate
  { enabled: true, key: "orders:paid:list:v1", ttl: 30_000 } // cache
);

// getMany with single populate (object)
await db.getMany({
  model: "orders",
  filter: { status: "paid" },
  select: ["_id", "total"],
  sort: { createdAt: -1 },
  populate: { path: "customer", select: "name email" },
  cacheOpts: { enabled: true, key: "orders:paid:list:v1", ttl: 30_000 },
});

// getMany with multiple populates (parameters)
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

// getMany with multiple populates (object)
await db.getMany({
  model: "orders",
  filter: { status: "paid" },
  select: ["_id", "total"],
  sort: { createdAt: -1 },
  populate: [
    { path: "products", select: ["field1", "field2"] },
    { path: "customer", select: "name email" },
  ],
  cacheOpts: { enabled: true },
});

// getManyWithLimit with single populate (parameters)
await db.getManyWithLimit(
  "products", // collection
  { active: true }, // filter
  ["_id", "title", "price"], // projection
  { createdAt: -1 }, // sort
  50, // limit
  { path: "category", select: "name" }, // populate
  { enabled: true, ttl: "10m" } // cache
);

// getManyWithLimit with single populate (object)
await db.getManyWithLimit({
  model: "products",
  filter: { active: true },
  select: ["_id", "title", "price"],
  sort: { createdAt: -1 },
  limit: 50,
  populate: { path: "category", select: "name" },
  cacheOpts: { enabled: true, ttl: "10m" },
});

// getManyWithLimit with multiple populates (parameters)
await db.getManyWithLimit(
  "orders", // collection
  { status: "pending" }, // filter
  ["_id", "total", "date"], // projection
  { createdAt: -1 }, // sort
  25, // limit
  // populate (multiple)
  [
    { path: "products", select: ["name", "price"] },
    { path: "customer", select: "name email" },
  ],
  { enabled: true } // cache
);

// getManyWithLimit with multiple populates (object)
await db.getManyWithLimit({
  model: "orders",
  filter: { status: "pending" },
  select: ["_id", "total", "date"],
  sort: { createdAt: -1 },
  limit: 25,
  populate: [
    { path: "products", select: ["name", "price"] },
    { path: "customer", select: "name email" },
  ],
  cacheOpts: { enabled: true },
});

// aggregate (parameters)
await db.aggregate("orders", [{ $match: { status: "paid" } }, { $group: { _id: "$userId", total: { $sum: "$amount" } } }], { enabled: true, ttl: "5m" });

// aggregate (object)
await db.aggregate({
  model: "orders",
  pipeline: [{ $match: { status: "paid" } }, { $group: { _id: "$userId", total: { $sum: "$amount" } } }],
  cacheOpts: { enabled: true, ttl: "5m" },
});

// getManyWithPagination with populate (parameters)
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

// getManyWithPagination with populate (object)
const paged = await db.getManyWithPagination({
  model: "products",
  filter: { active: true },
  select: ["_id", "title"],
  sort: { createdAt: -1 },
  page: 2,
  limit: 20,
  populate: { path: "category", select: "name" },
  cacheOpts: { enabled: true, key: "products:active:p2:l20" },
});

// getManyWithPagination with multiple populates (parameters)
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

// getManyWithPagination with multiple populates (object)
const pagedMulti = await db.getManyWithPagination({
  model: "orders",
  filter: { status: "active" },
  select: ["_id", "total"],
  sort: { createdAt: -1 },
  page: 1,
  limit: 10,
  populate: [
    { path: "products", select: ["field1", "field2"] },
    { path: "customer", select: "name email" },
  ],
  cacheOpts: { enabled: true },
});

// countDocuments (parameters)
await db.countDocuments("orders", { status: "processing" }, { enabled: true, ttl: "5m" });

// countDocuments (object)
await db.countDocuments({ model: "orders", filter: { status: "processing" }, cacheOpts: { enabled: true, ttl: "5m" } });
```

### Write

- `createOne(modelOrObj, payload?, writeArg?)`
- `createMany(modelOrObj, docs?, writeArg?)`
- `updateOne(modelOrObj, filter?, data?, writeArg?)`
- `updateMany(modelOrObj, filter?, data?, writeArg?)`
- `deleteOne(modelOrObj, filter?, writeArg?)`
- `deleteMany(modelOrObj, filter?, writeArg?)`
- `upsertOne(modelOrObj, filter?, data?, writeArg?)` (sempre aplica `{ upsert: true }`)

**Upserted document return:**
If you want upsertOne to return the updated/inserted document, include one of these options in `writeArg`:

- `{ options: { new: true }}` (preferred)
- `{ options: { returnDocument: "after" }}`
- `{ options: { returnDocument: true }}`
  The method will use `findOneAndUpdate` and return the document as a plain object.
  Otherwise, it returns the default result from `updateOne` (count).

**Examples**

```js
// createOne (parameters)
await db.createOne("logs", { type: "signup", user: userId });

// createOne (object)
await db.createOne({ model: "logs", payload: { type: "signup", user: userId } });

// createMany (parameters)
await db.createMany("products", [{ sku: "X" }, { sku: "Y" }], { options: { ordered: false, runValidators: true } });

// createMany (object)
await db.createMany({ model: "products", docs: [{ sku: "X" }, { sku: "Y" }], writeArg: { options: { ordered: false, runValidators: true } } });

// upsertOne (parameters)
await db.upsertOne("inventory", { sku: "ABC-001" }, { $inc: { stock: 10 } }, { invalidatePrefixes: ["inventory:"] });

// upsertOne (object)
await db.upsertOne("inventory", { sku: "ABC-001" }, { $inc: { stock: 10 } }, { options: { new: true, setDefaultsOnInsert: true } });

// upsertOne (object, retorna apenas contagem)
await db.upsertOne({ model: "inventory", filter: { sku: "ABC-001" }, data: { $inc: { stock: 10 } }, writeArg: { invalidatePrefixes: ["inventory:"] } });

// upsertOne (object, with returnDocument)
await db.upsertOne({
  model: "inventory",
  filter: { sku: "ABC-001" },
  data: { $inc: { stock: 10 } },
  writeArg: { options: { new: true, setDefaultsOnInsert: true } },
});
```

### Transactions

- `withTransaction(workFn, txOptions?)`

```js
// withTransaction (parameters)
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

// withTransaction (object)
await db.withTransaction(
  async (session) => {
    const a = await db.updateOne({ model: "wallets", filter: { _id: fromId }, data: { $inc: { balance: -100 } }, writeArg: { session } });
    if (!a.status) throw a.data;

    const b = await db.updateOne({ model: "wallets", filter: { _id: toId }, data: { $inc: { balance: +100 } }, writeArg: { session } });
    if (!b.status) throw b.data;

    await db.createOne({ model: "transfers", payload: { fromId, toId, amount: 100 }, writeArg: { session } });
  },
  { readConcern: "snapshot", writeConcern: { w: "majority" }, maxCommitRetries: 2 }
);
```

### Utilities

- `safeQuery(fnOrExportedName, ...args)` — runs and always returns `{ status, data }`
- `getMetrics()` — snapshot of DB/cache timings per operation
- `resetMetrics()` — clears metrics
- `resolveModel(modelOrName)` — resolves a model instance or loads all model files to find the requested model
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

## 🛠️ Support

Got stuck? Don’t panic — we’ve got you covered.

### 🤖 AI Assistant

We built a custom **AI Assistant** trained _only_ on `@salespark/mongo-repo-utils`.  
It answers implementation and troubleshooting questions in real time:

👉 Ask the Mongo Repo Utils GPT:  
https://chatgpt.com/g/g-68a8d1ef5b60819198a18587a80f99be-salespark-mongo-repository-utilities-v1

_(Free to use with a ChatGPT account)_

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

_Document version: 12_  
_Last update: 16-10-2025_
