const path = require("path");
const mongoose = require("mongoose");

// Define default time-to-live for cache in milliseconds
const DEFAULT_TTL = 60_000;

// ======================================================
// ##: MODELS_DIR configuration
// Priority:
// 1. Value set by setModelsDir()
// 2. Environment variable SP_MONGO_REPO_MODELS_DIR
// 3. Throw error if none defined
// ======================================================
let MODELS_DIR = null;

/*******************************************************
 * ##: Set Models Directory
 * Set the models directory
 * @param {String} dir - The models directory
 * History:
 * 16-08-2025: Created
 *******************************************************/
const setModelsDir = (dir) => {
  MODELS_DIR = dir;
};

/*******************************************************
 * ##: Get Models Directory
 * Get the current models directory
 * History:
 * 16-08-2025: Created
 *******************************************************/
const getModelsDir = () => {
  if (MODELS_DIR) return MODELS_DIR;
  if (process.env.SP_MONGO_REPO_MODELS_DIR) return process.env.SP_MONGO_REPO_MODELS_DIR;
  throw new Error("MODELS_DIR not set. Use setModelsDir('/path/to/models') or define env SP_MONGO_REPO_MODELS_DIR");
};

// Define noop logger
const noopLogger = () => {};
let logger = noopLogger;

/*******************************************************
 * ##: Logger injection
 * Set the logger function.
 * Accepts any function. If not a function, falls back to noop.
 * History:
 * 16-08-2025: Created
 * 20-08-2025: Updated
 *******************************************************/
const setLogger = (_logger) => {
  logger = typeof _logger === "function" ? _logger : noopLogger;
};
/*******************************************************
 * ##: Cache injection
 * Default: disabled. Users can inject any cache interface
 * with { get(key), put(key, val, ttlMs), del(key), keys() }.
 * e.g., setCache(memCacheInstance)
 * History:
 * 16-08-2025: Created
 *******************************************************/
const noopCache = {
  get: () => undefined,
  put: () => {},
  del: () => {},
  keys: () => [],
};
let cache = noopCache;

/*******************************************************
 * ##: Set Cache
 * Set the cache interface
 * @param {Object} _cache - The cache interface
 * History:
 * 16-08-2025: Created
 *******************************************************/
const setCache = (_cache) => {
  // must have at least get/put/del/keys functions
  if (_cache && typeof _cache.get === "function") {
    cache = _cache;
  } else {
    cache = noopCache;
  }
};

// Define constants for metrics
const METRICS = {
  cache: { hits: 0, misses: 0, puts: 0, invalidations: 0 },
  db: { perOp: {} }, // { "getOne:users": { count, totalMs, minMs, maxMs } }
};

// Helper function to get current time in nanoseconds
const _nowNs = () => (typeof process?.hrtime?.bigint === "function" ? process.hrtime.bigint() : null);

// Helper function to record database operation metrics
const _recordDb = (opName, startNs) => {
  try {
    if (!startNs) return;
    const durMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    const b = (METRICS.db.perOp[opName] ||= { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 });
    b.count += 1;
    b.totalMs += durMs;
    if (durMs < b.minMs) b.minMs = durMs;
    if (durMs > b.maxMs) b.maxMs = durMs;
  } catch (_) {}
};

// Helper function to get current metrics
const getMetrics = () => JSON.parse(JSON.stringify(METRICS));

// Helper function to reset metrics
const resetMetrics = () => {
  METRICS.cache = { hits: 0, misses: 0, puts: 0, invalidations: 0 };
  METRICS.db = { perOp: {} };
};

// Helper functions for response handling
const ok = (data) => ({ status: true, data });
const fail = (err, ctx) => (logger(err, ctx), { status: false, data: err });

/*******************************************************
 * ##: Normalize Model or Name
 * Normalize a Mongoose model or its name
 * @param {Any} modelOrName - Model or name
 * History:
 * 14-08-2025: Created
 *******************************************************/
const normalizeModelName = (modelOrName) => {
  return typeof modelOrName === "string" ? modelOrName : modelOrName?.modelName || "Model";
};

/*******************************************************
 * ##: Hash a string
 * A simple and fast hash function (djb2 xor)
 * @param {String} str - The string to hash
 * History:
 * 14-08-2025: Created
 *******************************************************/
const hash = (str) => {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
};

// Accept: string | string[] | { options?:{}, invalidateKeys?:string|string[], invalidatePrefixes?:string|string[] }

/****************************************************
 * ##: Support for options.session in write operations (back-compatible)
 * All write operations (createOne, createMany, updateOne, updateMany, upsertOne, deleteOne, deleteMany)
 * now accept an additional argument that can be either:
 * a cache invalidation key (string) or list of keys (string[]) — legacy style, still supported;
 * an options object (e.g. { session, runValidators, writeConcern }) to control Mongoose behavior;
 * @param {Any} arg - The write argument
 * History:
 * 15-08-2025: Created
 *******************************************************/
const _parseWriteArg = (arg) => {
  // Initialize local variables for possible outputs
  let options, invalidateKeys, invalidatePrefixes;

  // If no argument is provided, return an object with all undefined
  if (!arg) return { options, invalidateKeys, invalidatePrefixes };

  // Case 1: argument is a string or an array → treat it as invalidateKeys
  if (typeof arg === "string" || Array.isArray(arg)) {
    invalidateKeys = arg;
    return { options, invalidateKeys, invalidatePrefixes };
  }

  // Case 2: argument is an object
  if (typeof arg === "object") {
    // Extract invalidateKeys if present
    if ("invalidateKeys" in arg) invalidateKeys = arg.invalidateKeys;
    // Extract invalidatePrefixes if present
    if ("invalidatePrefixes" in arg) invalidatePrefixes = arg.invalidatePrefixes;

    // Allow passing a full nested object: { options: { session, runValidators, ... } }
    if ("options" in arg && typeof arg.options === "object") options = arg.options;
    // Or allow passing the options object directly (without nesting under "options")
    else if ("session" in arg || "upsert" in arg || "writeConcern" in arg || "runValidators" in arg) options = arg;
  }

  // Return the parsed structure { options, invalidateKeys, invalidatePrefixes }
  return { options, invalidateKeys, invalidatePrefixes };
};

/****************************************************
 * ##: Resolve a Mongoose Model
 * Resolve a Mongoose Model from:
 *   - A Model instance, or
 *   - An exact model name (string).
 *
 * Assumptions:
 * - The provided name matches exactly the registered model name in mongoose.models
 *   OR matches exactly the filename under ../models/<name> that registers/exports the model.
 * - No heuristics beyond optional pluralization. No fuzzy matching, no case conversion.
 *
 * Resolution logic:
 * 1. If a Model (function with .modelName) is provided directly, return it.
 * 2. If a document/instance is provided, return its constructor (the actual Model).
 * 3. Otherwise, coerce to string and pluralize if needed (append "s").
 * 4. Check if the Model is already in mongoose.models registry → return it.
 * 5. Require the corresponding file under MODELS_DIR.
 *    Expectation: this file either registers the Model into mongoose.models
 *    OR directly exports the Model.
 * 6. Re-check mongoose.models registry. If found, return it.
 * 7. If not found but the module export is itself a Model, return it.
 * 8. Otherwise, throw descriptive error.
 * @param {Any} modelOrName - Model instance or name
 * History:
 * 14-08-2025: Created
 * 19-08-2025: Fix model resolution logic and removed modelCache
 * 20-08-2025: Fix model directory resolution (from env variable)
 ****************************************************/
const resolveModel = (modelOrName) => {
  // Case 1: Provided directly as a Model constructor
  if (typeof modelOrName === "function" && modelOrName.modelName) {
    return modelOrName;
  }

  // Case 2: Provided as a document/instance → return its constructor
  if (typeof modelOrName === "object" && modelOrName?.constructor?.modelName) {
    return modelOrName.constructor;
  }

  // Case 3: Provided as string → normalize to plural form
  let name = String(modelOrName);
  name = name.endsWith("s") ? name : `${name}s`;

  // Step 4: Try mongoose registry
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }

  // Check if Model dir exists
  if (!MODELS_DIR) {
    setModelsDir(getModelsDir());
  }

  // Step 5: Require model file
  const candidatePath = path.join(MODELS_DIR, name);
  const exported = require(candidatePath);

  // Step 6: Check registry again (never trust direct require return)
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }

  // Step 7: Fallback: if export itself is a Model
  if (exported?.modelName) {
    return exported;
  }

  // Step 8: If still not resolved → throw
  throw new Error(`Mongoose model "${name}" not found (expected registered as mongoose.models["${name}"] or exported by ${candidatePath})`);
};

/*******************************************************
 * ##: Stable stringify with error handling
 * Creates deterministic JSON for cache keys
 * - Orders object keys alphabetically
 * - Handles Date, Set, Map, Buffer, TypedArrays, BigInt, RegExp, Error, Function, Symbol
 * - Detects cycles
 * Always returns { status, data }:
 *   - { status: true, data: <string> }
 *   - { status: false, data: <Error> }
 * @param {Any} value - The value to stringify
 * History:
 * 14-08-2025: Created
 *******************************************************/
const stableStringify = (value) => {
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(value, function replacer(key, val) {
      if (val && typeof val === "object") {
        if (seen.has(val)) return "__cycle__"; // Handle cycles
        seen.add(val);

        if (val instanceof Date) return val.toISOString();
        if (val instanceof Set) return Array.from(val).sort();
        if (val instanceof Map) {
          return Array.from(val.entries()).sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0));
        }
        if (Array.isArray(val)) return val;

        // Plain object with sorted keys
        const sorted = {};
        for (const k of Object.keys(val).sort()) sorted[k] = val[k];
        return sorted;
      }

      // Special cases / fallbacks
      if (typeof val === "bigint") return val.toString() + "n";
      if (typeof val === "symbol") return val.toString();
      if (typeof val === "function") return `[Function:${val.name || "anonymous"}]`;
      if (val instanceof RegExp) return val.toString();
      if (val instanceof Error) return `${val.name}:${val.message}`;
      if (Buffer.isBuffer(val)) return val.toString("base64");
      if (ArrayBuffer.isView(val)) return Buffer.from(val.buffer).toString("base64");

      return val;
    });

    return { status: true, data: str };

    // Error handling
  } catch (err) {
    return { status: false, data: err };
  }
};

/*******************************************************
 * ##: Build a safe cache key
 * Builds a cache key from function name and arguments
 * @param {String} fnName - Function name
 * @param {Array} args - Function arguments
 * History:
 * 14-08-2025: Created
 *******************************************************/
const buildCacheKey = (fnName, args) => {
  try {
    const [modelOrName, ...rest] = args || [];
    const modelKey = normalizeModelName(modelOrName);

    const strRes = stableStringify(rest ?? []);
    if (!strRes.status) {
      // Failed stringify → return error string as key, but don't cache
      return { status: false, data: strRes.data };
    }

    const argsKey = hash(strRes.data);
    return { status: true, data: `${fnName}:${modelKey}:${argsKey}` };

    // Error handling
  } catch (err) {
    return { status: false, data: err };
  }
};

/*******************************************************
 * ##: Normalize TTL
 * Normalizes TTL values to milliseconds.
 * Accepts:
 *  - number: treated as milliseconds (0 disables caching for most stores)
 *  - string: "<int>[ms|s|m|h|d]" (case-insensitive). Examples: "500ms", "30s", "5m", "4h", "2d", "60000"
 * Fallbacks:
 *  - null/undefined/invalid -> DEFAULT_TTL
 *  - negative numbers -> 0
 * History:
 * 18-08-2025: Created
 *******************************************************/
const normalizeTTL = (ttl) => {
  try {
    // Number input → treat as milliseconds
    if (typeof ttl === "number" && Number.isFinite(ttl)) {
      return ttl < 0 ? 0 : ttl; // negative -> 0 (effectively no-cache for most stores)
    }

    // String input → parse "<int>[unit]"
    if (typeof ttl === "string") {
      const s = ttl.trim().toLowerCase();
      const m = s.match(/^(\d+)(ms|s|m|h|d)?$/);
      if (m) {
        const value = parseInt(m[1], 10);
        const unit = m[2] || "ms"; // default to milliseconds when unit is omitted
        switch (unit) {
          case "ms":
            return value;
          case "s":
            return value * 1_000;
          case "m":
            return value * 60_000;
          case "h":
            return value * 3_600_000;
          case "d":
            return value * 86_400_000;
          default:
            // Shouldn't reach here due to regex, but keep safe:
            return DEFAULT_TTL;
        }
      }
      // Unparseable string -> default
      return DEFAULT_TTL;
    }

    // Fallback for other types/null/undefined
    return DEFAULT_TTL;
  } catch (_) {
    return DEFAULT_TTL;
  }
};

/*******************************************************
 * ##: Cache Wrapper
 * Wraps a function with caching logic and handle responses
 * @param {String} fnName - Function name
 * @param {Array} args - Function arguments
 * @param {Object} cacheOpts - Cache options
 * @param {Function} runFn - Function to run
 * History:
 * 14-08-2025: Created
 * 18-08-2025: Added support for cache TTL normalization
 *******************************************************/
const withCache = async (fnName, args, cacheOpts, runFn) => {
  const { enabled = true, key, ttl = DEFAULT_TTL, cacheIf = (r) => r?.status === true } = cacheOpts || {};

  const normalizedTTL = normalizeTTL(ttl);

  if (!enabled) {
    const res = await runFn();
    return res && typeof res.status === "boolean" ? res : ok(res);
  }

  const k = key ?? buildCacheKey(fnName, args);
  if (k.status === false) {
    // If failed to build cache key, run the function without caching
    const res = await runFn();
    return res && typeof res.status === "boolean" ? res : ok(res);
  }
  const cacheKey = k.data;

  const hit = cache.get(cacheKey);
  if (hit !== undefined && hit !== null) return hit; // Is already {status,data}

  const res = await runFn();
  const normalized = res && typeof res.status === "boolean" ? res : ok(res);
  if (cacheIf(normalized)) cache.put(cacheKey, normalized, normalizedTTL);
  return normalized;
};

/*******************************************************
 * ##: Run a unit of work inside a MongoDB transaction
 * @param {(session: ClientSession) => Promise<any>} work
 * @param {Object} [txOptions] - { readConcern, writeConcern, readPreference, maxCommitRetries }
 * History:
 * 15-08-2025: Created
 *******************************************************/
const withTransaction = async (work, txOptions = {}) => {
  const session = await mongoose.startSession();

  // Destructure options
  const { readConcern, writeConcern, readPreference, maxCommitRetries = 0 } = txOptions || {};

  // Build transaction options
  const txnOptions = {};

  // Set transaction options
  if (readConcern) txnOptions.readConcern = { level: readConcern };
  if (writeConcern) txnOptions.writeConcern = writeConcern;
  if (readPreference) txnOptions.readPreference = readPreference;

  // Initialize attempt counter
  let attempt = 0;

  // Define operation name
  const opName = "withTransaction";

  try {
    // Define result variable
    let result;

    // Record start time
    const start = _nowNs();

    while (true) {
      try {
        // Start the transaction
        await session.withTransaction(async () => {
          // Execute the work function
          result = await work(session);
        }, txnOptions);

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the result
        return ok(result);

        // Error handling
      } catch (err) {
        if (attempt < maxCommitRetries) {
          attempt += 1;
          continue; // retry whole transaction
        }
        throw err;
      }
    }

    // Error handling and finally block
  } catch (err) {
    return fail(err, "withTransaction");
  } finally {
    await session.endSession();
  }
};

/*******************************************************
 * ##: Invalidate Cache
 * Invalidate cache by key(s) and/or prefixes
 * @param {string|string[]|{keys?:string|string[], prefixes?:string|string[]}} input - Cache keys and/or prefixes to invalidate
 * History:
 * 14-08-2025: Created
 *******************************************************/
const invalidateCache = (input) => {
  try {
    // Initialize arrays to hold keys and prefixes that should be invalidated
    let keys = [],
      prefixes = [];

    // If nothing was passed, exit early with ok()
    if (!input) return ok({ invalidated: 0 });

    // Case 1: input is a single string or an array → treat it as keys
    if (typeof input === "string" || Array.isArray(input)) {
      keys = Array.isArray(input) ? input : [input];
    }
    // Case 2: input is an object with { keys, prefixes }
    else if (typeof input === "object") {
      if (input.keys) keys = Array.isArray(input.keys) ? input.keys : [input.keys];
      if (input.prefixes) prefixes = Array.isArray(input.prefixes) ? input.prefixes : [input.prefixes];
    }

    // 1) Invalidate exact keys
    let count = 0;
    for (const k of new Set(keys.filter(Boolean))) {
      // use Set to avoid duplicates
      try {
        cache.del(k); // delete each key from the cache
        count++;
      } catch (_) {}
    }

    // 2) Invalidate keys by prefix (only if supported)
    if (prefixes.length) {
      // Get all keys currently in cache
      const all = cache.keys() || [];
      // For each prefix, remove all keys starting with it
      for (const p of prefixes.filter(Boolean)) {
        for (const key of all)
          if (String(key).startsWith(p)) {
            try {
              cache.del(key);
              count++;
            } catch (_) {}
          }
      }
    }

    // Update metrics: track how many keys were invalidated
    METRICS.cache.invalidations += count;

    // Return success with number of invalidated entries
    return ok({ invalidated: count });

    // Error handling
  } catch (err) {
    return fail(err, "invalidateCache");
  }
};

/* =========================================== CRUD methods =========================================== */
/* =========================================== CRUD methods =========================================== */
/* =========================================== CRUD methods =========================================== */

/*******************************************************
 * ##: Create a new document in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} payload - payload Object
 * @param {Object} writeArg - Write options (e.g., session)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const createOne = async (modelOrName, payload, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `createOne:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Create the document
    const doc = await Model.create(payload, options);

    // Optional cache invalidation (by key and/or prefix)
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the created document
    return ok(doc);

    // Error handling
  } catch (err) {
    return fail(err, "createOne");
  }
};

/*******************************************************
 * ##: Create many documents (bulk insert)
 * @param {Object|String} modelOrName - Model instance or exact model name
 * @param {Array<Object>|Object} docs - Array of documents to insert (accepts a single object and coerces to array)
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Remove fallback from options
 *******************************************************/
const createMany = async (modelOrName, docs, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `createMany:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Insert the documents
    const { ordered = true, ...rest } = options;
    const res = await Model.insertMany(docs, { ordered, ...rest });

    // Optional cache invalidation (by key and/or prefix)
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "createMany");
  }
};

/*******************************************************
 * ##: Get a single document from a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Array} select - Fields to select
 * @param {Object} cacheOpts - Cache options
 * History:
 * 14-08-2025: Created
 *******************************************************/
const getOne = async (modelOrName, filter, select, cacheOpts) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `getOne:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (cacheOpts?.enabled) {
      return await withCache("getOne", [modelOrName, filter, select], cacheOpts, async () => {
        // Find the document
        const doc = await Model.findOne(filter, select).lean();

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the found document
        return ok(doc);
      });
    }

    // Find the document without cache
    const doc = await Model.findOne(filter, select).lean();

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the found document
    return ok(doc);

    // Error handling
  } catch (err) {
    return fail(err, "getOne");
  }
};

/*******************************************************
 * ##: Get many documents from a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Array} select - Fields to select
 * @param {Object} sort - Sort Object
 * @param {Object} cacheOpts - Cache options
 * History:
 * 14-08-2025: Created
 *******************************************************/
const getMany = async (modelOrName, filter, select = [], sort = { createdAt: -1 }, cacheOpts) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `getMany:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (cacheOpts?.enabled) {
      return await withCache("getMany", [modelOrName, filter, select, sort], cacheOpts, async () => {
        // Find the documents
        const docs = await Model.find(filter, select).sort(sort).lean();

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the found documents
        return ok(docs);
      });
    }

    // Find the documents without cache
    const docs = await Model.find(filter, select).sort(sort).lean();

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the found documents
    return ok(docs);

    // Error handling
  } catch (err) {
    return fail(err, "getMany");
  }
};

/*******************************************************
 * ##: Update a single document in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Object} data - Update data
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const updateOne = async (modelOrName, filter, data, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `updateOne:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Execute update with optional Mongoose options (e.g., session, runValidators)
    const res = await Model.updateOne(filter, data, options);

    // Invalidate cache by exact keys and/or prefixes (if provided)
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "updateOne");
  }
};

/*******************************************************
 * ##: Update many documents in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Object} data - Update data
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const updateMany = async (modelOrName, filter, data, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `updateMany:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Update the documents
    const res = await Model.updateMany(filter, data, options);

    // Invalidate cache by key/keys if provided
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the updated documents
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "updateMany");
  }
};

/*******************************************************
 * ##: Delete a single document in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const deleteOne = async (modelOrName, filter, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `deleteOne:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Delete the document
    const res = await Model.deleteOne(filter, options);

    // Invalidate cache by key/keys if provided
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "deleteOne");
  }
};

/*******************************************************
 * ##: Delete many documents in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const deleteMany = async (modelOrName, filter, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `deleteMany:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Delete the documents
    const res = await Model.deleteMany(filter, options);

    // Invalidate cache by key/keys if provided
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "deleteMany");
  }
};

/*******************************************************
 * ##: Upsert a single document in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Object} data - Upsert data
 * @param {String|String[]|Object} writeArg - Flexible extra arg:
 *    - string | string[]                      -> invalidateKeys (legacy)
 *    - { session, runValidators, ... }        -> options (direct)
 *    - { options:{...}, invalidateKeys, invalidatePrefixes } -> combined
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 *******************************************************/
const upsertOne = async (modelOrName, filter, data, writeArg) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `upsertOne:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(writeArg);

    // Merge user-provided options with upsert:true (user options cannot disable upsert)
    const opts = { upsert: true, ...options };

    // Upsert the document
    const res = await Model.updateOne(filter, data, opts);

    // Invalidate cache by key/keys if provided
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(res);

    // Error handling
  } catch (err) {
    return fail(err, "upsertOne");
  }
};

/*******************************************************
 * ##: Get many documents in a model with pagination
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Array} select - Fields to select
 * @param {Object} sort - Sort Object
 * @param {Number} page - Page number
 * @param {Number} limit - Number of documents per page
 * @param {Object} cacheOpts - Cache options
 * History:
 * 14-08-2025: Created
 *******************************************************/
const getManyWithPagination = async (modelOrName, filter, select = [], sort = { createdAt: -1 }, page = 1, limit = 100, cacheOpts) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `getManyWithPagination:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (cacheOpts?.enabled) {
      return await withCache("getManyWithPagination", [modelOrName, filter, select, sort, page, limit], cacheOpts, async () => {
        // Find the documents (count)
        const total = await Model.countDocuments(filter);

        // Find the documents
        const docs = await Model.find(filter, select)
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean();

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the found documents
        return ok({ data: docs, total, page, limit });
      });
    }

    // Count and Find the documents without cache
    // Find the documents (count)
    const total = await Model.countDocuments(filter);

    // Find the documents
    const docs = await Model.find(filter, select)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the found documents
    return ok({ data: docs, total, page, limit });

    // Error handling
  } catch (err) {
    return fail(err, "getManyWithPagination");
  }
};

/*******************************************************
 * ##: Count documents in a model
 * @param {Object|String} modelOrName - Model instance or name
 * @param {Object} filter - Filter Object
 * @param {Object} cacheOpts - Cache options
 * History:
 * 14-08-2025: Created
 *******************************************************/
const countDocuments = async (modelOrName, filter, cacheOpts) => {
  try {
    // Resolve the model (cached)
    const Model = resolveModel(modelOrName);

    // Build operation name and start time
    const opName = `countDocuments:${normalizeModelName(Model)}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (cacheOpts?.enabled) {
      return await withCache("countDocuments", [modelOrName, filter], cacheOpts, async () => {
        // Find the documents (count)
        const count = await Model.countDocuments(filter);

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the result
        return ok(count);
      });
    }

    // Find the documents (count) without cache
    const count = await Model.countDocuments(filter);

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(count);

    // Error handling
  } catch (err) {
    return fail(err, "countDocuments");
  }
};

/****************************************************
 * ##: Safe Query Execution
 * Keeps your return contract: always { status, data }.
 * You can call with a function reference or the exported name in this module.
 * @param {Function} func - Function to execute
 * @param {...any} args - Arguments to pass to the function
 * History:
 * 14-08-2025: Created
 ****************************************************/
const safeQuery = async (fn, ...args) => {
  try {
    const f = typeof fn === "function" ? fn : module.exports?.[fn];
    if (typeof f !== "function") {
      return fail(new Error(`Function "${fn}" not found`), `/mongo/repo/index.js/safeQuery/${fn}`);
    }
    const res = await f(...args);
    return res && typeof res.status === "boolean" && "data" in res ? res : ok(res);
  } catch (err) {
    return fail(err, "/mongo/repo/index.js/safeQuery/catch");
  }
};

module.exports = {
  // model resolver
  resolveModel,
  // ops
  createOne,
  createMany,
  getOne,
  getMany,
  getManyWithPagination,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
  upsertOne,
  countDocuments,
  // utils
  safeQuery,
  withTransaction,

  // metrics
  getMetrics,
  resetMetrics,
  // others
  setLogger,
  setModelsDir,
  setCache,
};
