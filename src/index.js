const path = require("path");
const mongoose = require("mongoose");
const fs = require("fs"); //required for fs.promises

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
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const setModelsDir = (dir) => {
  if (typeof dir !== "string") return fail(new Error("Directory must be a string"), "setModelsDir");
  MODELS_DIR = dir;
  return ok({ message: "Models directory set" });
};

/*******************************************************
 * ##: Get Models Directory
 * Get the current models directory
 * History:
 * 16-08-2025: Created
 * 20-08-2025: Updated (Add fallback to default models directory)
 *******************************************************/
const getModelsDir = () => {
  if (MODELS_DIR) return MODELS_DIR;
  if (process.env.SP_MONGO_REPO_MODELS_DIR) return process.env.SP_MONGO_REPO_MODELS_DIR;
  return "./models"; // Default models directory
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
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const setLogger = (_logger) => {
  logger = typeof _logger === "function" ? _logger : noopLogger;
  return ok({ message: "Logger set" });
};
/*******************************************************
 * ##: Cache injection
 * Default: disabled. Users can inject any cache interface
 * with { get(key), put(key, val, ttlMs), del(key), keys() }.
 * e.g., setCache(memCacheInstance)
 * History:
 * 16-08-2025: Created
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const noopCache = {
  get: () => undefined,
  put: () => false, // Return false to indicate no-op (no caching occurred)
  del: () => false, // Return false to indicate no deletion occurred
  keys: () => [],
};
let cache = noopCache;

/*******************************************************
 * ##: Set Cache
 * Set the cache interface
 * @param {Object} _cache - The cache interface
 * History:
 * 16-08-2025: Created
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const setCache = (_cache) => {
  // Check all required methods (get, put, del, keys)
  if (_cache && typeof _cache.get === "function" && typeof _cache.put === "function" && typeof _cache.del === "function" && typeof _cache.keys === "function") {
    cache = _cache;
    return ok({ message: "Cache interface set successfully" }); // Follow contract with success return
  } else {
    cache = noopCache;
    return fail(new Error("Invalid cache interface: must have get, put, del, and keys methods"), "setCache");
  }
};

// Define constants for metrics
const METRICS = {
  cache: { hits: 0, misses: 0, puts: 0, invalidations: 0 },
  db: { perOp: {} }, // { "getOne:users": { count, totalMs, minMs, maxMs } }
};

// Helper function to get current time in milliseconds (fallback for older Node.js)
const _nowMs = () => Date.now(); // Simple fallback using Date.now() for ms precision

// Helper function to get high-resolution time (bigint if available, else fallback to ms)
const _nowNs = () => {
  if (typeof process?.hrtime?.bigint === "function") {
    return process.hrtime.bigint(); // High precision (ns)
  }
  return BigInt(_nowMs() * 1e6); // Fallback to ms converted to ns (approximate)
};

// Helper function to record database operation metrics
const _recordDb = (opName, startNs) => {
  try {
    if (!startNs) return; // Early exit if no start time

    const endNs = _nowNs(); // Get end time consistently
    let durMs = Number((endNs - startNs) / 1_000_000n); // Convert BigInt ns to ms

    // Safeguard against NaN (e.g., from fallback mismatches)
    if (Number.isNaN(durMs)) {
      durMs = 0; // Set to 0 instead of NaN to keep metrics clean
    }

    const b = (METRICS.db.perOp[opName] ||= { count: 0, totalMs: 0, minMs: Infinity, maxMs: 0 });
    b.count += 1;
    b.totalMs += durMs;
    if (durMs < b.minMs) b.minMs = durMs;
    if (durMs > b.maxMs) b.maxMs = durMs;
  } catch (_) {
    // Ignore errors silently
  }
};

/*******************************************************
 * ##: Get Metrics
 * Helper function to get current metrics
 * History:
 * 16-08-2025: Created
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const getMetrics = () => ok(JSON.parse(JSON.stringify(METRICS)));

/*******************************************************
 * ##: Reset Metrics
 * Helper function to reset metrics
 * History:
 * 16-08-2025: Created
 * 22-08-2025: Updated (Add validation)
 *******************************************************/
const resetMetrics = () => {
  METRICS.cache = { hits: 0, misses: 0, puts: 0, invalidations: 0 };
  METRICS.db = { perOp: {} };
  return ok({ message: "Metrics reset" });
};

// Helper functions for response handling
const ok = (data) => ({ status: true, data });
const fail = (err, ctx) => (logger(err, ctx), { status: false, data: err });

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
  if (!arg) {
    return { options: undefined, invalidateKeys: undefined, invalidatePrefixes: undefined };
  }

  // Case 1: argument is a string or an array → treat it as invalidateKeys
  if (typeof arg === "string" || Array.isArray(arg)) {
    return { options: undefined, invalidateKeys: arg, invalidatePrefixes: undefined };
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
 * ##: Get the application root directory
 * @returns {String} - The absolute path to the application root
 * History:
 * 24-08-2025: Created
 ****************************************************/
function getAppRoot() {
  try {
    // Prefer current working directory
    let _root = process.cwd();

    // If cwd is the disk root, fallback to main module directory (if available)
    if (path.parse(_root).root === _root && require.main) {
      return path.dirname(require.main.filename);
    }

    // Normal case: return cwd
    return _root;

    // Error handling
  } catch (error) {
    // Fallback: return two levels above this file (common for node_modules usage)
    return path.resolve(__dirname, "../..");
  }
}

/****************************************************
 * ##: Pluralize a model name
 * Simple pluralization by appending "s" if not already ending with "s"
 * Only appends "s" if the last character is a letter (a-zA-Z).
 * @param {String} model - Model name (string)
 * @returns {String} - Pluralized model name
 * History:
 * 06-09-2025: Created
 ****************************************************/
function pluralizeName(model) {
  try {
    if (model.endsWith("s") || !/[a-zA-Z]$/.test(model)) {
      return model;
    }
    return `${model}s`;

    // Error handling
  } catch (err) {
    // Fallback: return the original model name
    return model;
  }
}

/****************************************************
 * ##: Resolve a Mongoose Model
 * Resolve a Mongoose Model from an exact model name (string).
 *
 * Assumptions:
 * - The provided name matches exactly the registered model name in mongoose.models
 *   OR matches exactly the filename under ../models/<name> that registers/exports the model.
 * - No heuristics beyond optional pluralization. No fuzzy matching, no case conversion.
 *
 * Resolution logic:
 * 1. Accepts only a string as model name. Throws if not string.
 * 2. Pluralizes the name if needed (appends "s").
 * 3. Checks mongoose.models registry for the model.
 * 4. Requires the corresponding file under MODELS_DIR if not found.
 *    Expectation: this file either registers the Model into mongoose.models
 *    OR directly exports the Model.
 * 5. Re-checks mongoose.models registry. If found, returns it.
 * 6. If not found but the module export is itself a Model, returns it.
 * 7. Otherwise, throws descriptive error.
 * @param {String} model - Model name (string)
 * History:
 * 14-08-2025: Created
 * 19-08-2025: Fix model resolution logic and removed modelCache
 * 20-08-2025: Fix model directory resolution (from env variable)
 * 22-08-2025: Accept only string as model name
 * 06-09-2025: Improve pluralization logic (only if last char is a letter)
 ****************************************************/
const resolveModel = (model) => {
  // Only accept string for model name
  if (typeof model !== "string") {
    throw new Error("resolveModel: model must be a string");
  }

  // Provided as string → normalize to plural form (only if last char is a letter)
  const name = pluralizeName(model);

  // Try mongoose registry
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }

  // Check if Model dir exists
  if (!MODELS_DIR) {
    setModelsDir(getModelsDir());
  }

  // Build candidate path
  const candidatePath = path.join(getAppRoot(), MODELS_DIR, name);
  const exported = require(candidatePath);

  // Check registry again (never trust direct import return)
  if (mongoose.models[name]) {
    return mongoose.models[name];
  }

  // Fallback: if export itself is a Model
  if (exported?.modelName) {
    return exported;
  }

  // If still not resolved → throw
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
/*******************************************************
 * ##: Stable stringify with error handling
 * Creates deterministic JSON for cache keys
 * - Orders object keys alphabetically
 * - Handles Date, Set, Map, Buffer, TypedArrays, BigInt, RegExp, Error, Function, Symbol
 * - Detects cycles
 * - Improved: Handles custom class instances by including class name and all own properties
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

        // Improved handling for custom class instances: include class name and all own properties
        if (val.constructor && val.constructor.name !== "Object") {
          const sorted = { __type: val.constructor.name }; // Marker for class type
          // Get all own properties (including non-enumerable)
          for (const k of Object.getOwnPropertyNames(val).sort()) {
            sorted[k] = val[k];
          }
          return sorted;
        }

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
    if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
      return { status: false, data: new Error("Invalid args: first argument must be a model name (string)") };
    }

    const [model, ...rest] = args;
    const modelKey = model;

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
 * @param {Function|Object} workOrObj - Work function (async callback) or object with { work, txOptions }
 * @param {Object} [txOptions={}] - Transaction options { readConcern, writeConcern, readPreference, maxCommitRetries } (if workOrObj is function or missing in object)
 * History:
 * 15-08-2025: Created
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 *******************************************************/
const withTransaction = async (workOrObj, txOptions = {}) => {
  let work, resolvedTxOptions;

  if (typeof workOrObj === "object" && workOrObj !== null) {
    // If first arg is an object, extract properties with fallback to extra args
    work = workOrObj.work;
    resolvedTxOptions = workOrObj.txOptions ?? txOptions;
  } else {
    // If first arg is function (work), use provided txOptions
    work = workOrObj;
    resolvedTxOptions = txOptions;
  }

  // Ensure work is a function
  if (typeof work !== "function") {
    throw new Error("withTransaction: work must be a function");
  }

  // Apply default for txOptions if undefined
  resolvedTxOptions = resolvedTxOptions ?? {};

  const session = await mongoose.startSession();

  // Destructure options
  const { readConcern, writeConcern, readPreference, maxCommitRetries = 0 } = resolvedTxOptions;

  // Build transaction options
  const txnOptions = {};
  if (readConcern) txnOptions.readConcern = { level: readConcern };
  if (writeConcern) txnOptions.writeConcern = writeConcern;
  if (readPreference) txnOptions.readPreference = readPreference;

  // Initialize attempt counter and timeout safeguards
  let attempt = 0;
  const maxAttempts = 10; // Hard cap to prevent infinite loops (implement as variable in later versions)
  const startTime = Date.now();
  const maxDurationMs = 30000; // Max 30 seconds for retries (implement as variable in later versions)

  // Define operation name
  const opName = "withTransaction";

  try {
    // Define result variable
    let result;

    // Record start time
    const start = _nowNs();

    while (true) {
      // Safeguard: Prevent infinite loops
      if (attempt >= maxAttempts || Date.now() - startTime > maxDurationMs) {
        throw new Error(`Transaction retry limit exceeded: max attempts (${maxAttempts}) or duration (${maxDurationMs}ms) reached`);
      }

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
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, payload, writeArg }
 * @param {Object} [payload] - Payload object (if modelOrObj is string)
 * @param {Object} [writeArg] - Write options (e.g., session) (if modelOrObj is string)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object
 * 23-08-2025: Ensured created document is returned as plain object
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const createOne = async (modelOrObj, payload, writeArg) => {
  try {
    let model, resolvedPayload, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedPayload = modelOrObj.payload ?? payload;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided payload and writeArg
      model = modelOrObj;
      resolvedPayload = payload;
      resolvedWriteArg = writeArg;
    }

    // Early validation for edge cases (return fail with custom message)
    if (modelOrObj === null || modelOrObj === undefined) {
      return fail(new Error("First argument must be a model name (string) or options object"), "createOne/validation");
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "createOne/validation");
    }
    if (!resolvedPayload || typeof resolvedPayload !== "object") {
      return fail(new Error("Payload is required and must be an object"), "createOne/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `createOne:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Create the document
    const doc = await Model.create(resolvedPayload, options);

    // Optional cache invalidation (by key and/or prefix)
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the created document
    return ok(doc.toObject());

    // Error handling
  } catch (err) {
    return fail(err, "createOne");
  }
};

/*******************************************************
 * ##: Create many documents (bulk insert)
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, docs, writeArg }
 * @param {Array<Object>|Object} [docs] - Array of documents to insert (or single object, coerced to array; if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props; added explicit coercion of single doc to array
 * 23-08-2025: Ensured created documents are returned as plain array of objects
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const createMany = async (modelOrObj, docs, writeArg) => {
  try {
    let model, resolvedDocs, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedDocs = modelOrObj.docs ?? docs;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided docs and writeArg
      model = modelOrObj;
      resolvedDocs = docs;
      resolvedWriteArg = writeArg;
    }

    // Early validation for edge cases (return fail with custom message)
    if (modelOrObj === null || modelOrObj === undefined) {
      return fail(new Error("First argument must be a model name (string) or options object"), "createMany/validation");
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "createMany/validation");
    }
    if (!resolvedDocs) {
      return fail(new Error("Docs are required (array or single object)"), "createMany/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `createMany:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Coerce single document to array if necessary (as per function doc)
    const docsToInsert = Array.isArray(resolvedDocs) ? resolvedDocs : [resolvedDocs];

    // Insert the documents
    const { ordered = true, ...rest } = options || {};
    const res = await Model.insertMany(docsToInsert, { ordered, ...rest });

    // Optional cache invalidation (by key and/or prefix)
    if (invalidateKeys || invalidatePrefixes) {
      invalidateCache({ keys: invalidateKeys, prefixes: invalidatePrefixes });
    }

    // Record database operation metrics
    _recordDb(opName, start);

    // Return array of plain objects
    return ok(res.map((doc) => doc.toObject()));

    // Error handling
  } catch (err) {
    return fail(err, "createMany");
  }
};
/*******************************************************
 * ##: Get a single document from a model (with populate - optional)
 * Resolve a model and retrieve a single document, with optional
 * field selection, population of references, and caching.
 *
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, select, populate, cacheOpts }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Array|String} [select] - Fields to select (if modelOrObj is string or missing in object)
 * @param {Array|Object|String} [populate] - Populate definition(s) (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 *
 * History:
 * 14-08-2025: Created
 * 21-08-2025: Added populate support
 * 22-08-2025: Change parameter order
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const getOne = async (modelOrObj, filter, select, populate, cacheOpts) => {
  try {
    let model, resolvedFilter, resolvedSelect, resolvedPopulate, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedSelect = modelOrObj.select ?? select;
      resolvedPopulate = modelOrObj.populate ?? populate;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedSelect = select;
      resolvedPopulate = populate;
      resolvedCacheOpts = cacheOpts;
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "getOne/validation");
    }
    if (!resolvedFilter || typeof resolvedFilter !== "object") {
      return fail(new Error("Filter is required and must be an object"), "getOne/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and record start time
    const opName = `getOne:${model}`;
    const start = _nowNs();

    // Query executor (with populate support)
    const runQuery = async () => {
      let query = Model.findOne(resolvedFilter, resolvedSelect);
      if (resolvedPopulate) query = query.populate(resolvedPopulate);
      const doc = await query.lean();

      // Record database operation metrics
      _recordDb(opName, start);

      // Return the found document
      return ok(doc);
    };

    // If caching is enabled, wrap query with cache logic
    if (resolvedCacheOpts?.enabled) {
      return await withCache("getOne", [model, resolvedFilter, resolvedSelect, resolvedPopulate], resolvedCacheOpts, runQuery);
    }

    // Execute query without cache
    return await runQuery();

    // Error handling
  } catch (err) {
    return fail(err, "getOne");
  }
};

/*******************************************************
 * ##: Get many documents from a model
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, select, sort, populate, cacheOpts }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Array} [select=[]] - Fields to select (if modelOrObj is string or missing in object)
 * @param {Object} [sort={}] - Sort object (if modelOrObj is string or missing in object)
 * @param {Array|Object|String} [populate] - Populate definition(s) (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 20-08-2025: Updated (remove default sort)
 * 22-08-2025: Added populate support
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const getMany = async (modelOrObj, filter, select = [], sort = {}, populate, cacheOpts) => {
  try {
    let model, resolvedFilter, resolvedSelect, resolvedSort, resolvedPopulate, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedSelect = modelOrObj.select ?? select;
      resolvedSort = modelOrObj.sort ?? sort;
      resolvedPopulate = modelOrObj.populate ?? populate;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedSelect = select;
      resolvedSort = sort;
      resolvedPopulate = populate;
      resolvedCacheOpts = cacheOpts;
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "getMany/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `getMany:${model}`;
    const start = _nowNs();

    // Query executor (with populate support)
    const runQuery = async () => {
      let query = Model.find(resolvedFilter, resolvedSelect).sort(resolvedSort);
      if (resolvedPopulate) query = query.populate(resolvedPopulate);
      const docs = await query.lean();

      // Record database operation metrics
      _recordDb(opName, start);

      // Return the found documents
      return ok(docs);
    };

    // Use cache only if cacheOpts is defined/active
    if (resolvedCacheOpts?.enabled) {
      return await withCache("getMany", [model, resolvedFilter, resolvedSelect, resolvedSort, resolvedPopulate], resolvedCacheOpts, runQuery);
    }

    // Find the documents without cache
    return await runQuery();

    // Error handling
  } catch (err) {
    return fail(err, "getMany");
  }
};

/*******************************************************
 * ##: Get many documents from a model
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, select, sort, populate, cacheOpts }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Array} [select=[]] - Fields to select (if modelOrObj is string or missing in object)
 * @param {Object} [sort={}] - Sort object (if modelOrObj is string or missing in object)
 * @param {Number} limit - Maximum number of documents to return
 * @param {Array|Object|String} [populate] - Populate definition(s) (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 * History:
 * 04-10-2025: Created (copy of getMany)
 *******************************************************/
const getManyWithLimit = async (modelOrObj, filter, select = [], sort = {}, limit, populate, cacheOpts) => {
  try {
    let model, resolvedFilter, resolvedSelect, resolvedSort, resolvedLimit, resolvedPopulate, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedSelect = modelOrObj.select ?? select;
      resolvedSort = modelOrObj.sort ?? sort;
      resolvedLimit = modelOrObj.limit ?? limit;
      resolvedPopulate = modelOrObj.populate ?? populate;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedSelect = select;
      resolvedSort = sort;
      resolvedLimit = limit;
      resolvedPopulate = populate;
      resolvedCacheOpts = cacheOpts;
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "getMany/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `getManyWithLimit:${model}`;
    const start = _nowNs();

    // Query executor (with populate support)
    const runQuery = async () => {
      let query = Model.find(resolvedFilter, resolvedSelect).sort(resolvedSort);
      if (resolvedLimit && typeof resolvedLimit === "number" && resolvedLimit > 0) {
        query = query.limit(resolvedLimit);
      }
      if (resolvedPopulate) query = query.populate(resolvedPopulate);
      const docs = await query.lean();

      // Record database operation metrics
      _recordDb(opName, start);

      // Return the found documents
      return ok(docs);
    };

    // Use cache only if cacheOpts is defined/active
    if (resolvedCacheOpts?.enabled) {
      return await withCache(
        "getManyWithLimit",
        [model, resolvedFilter, resolvedSelect, resolvedSort, resolvedLimit, resolvedPopulate],
        resolvedCacheOpts,
        runQuery
      );
    }

    // Find the documents without cache
    return await runQuery();

    // Error handling
  } catch (err) {
    return fail(err, "getManyWithLimit");
  }
};

/*******************************************************
 * ##: Aggregate documents in a model
 * Executes a MongoDB aggregation pipeline.
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, pipeline, cacheOpts }
 * @param {Array<Object>} [pipeline] - Aggregation pipeline stages (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 * History:
 * 21-08-2025: Created
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const aggregate = async (modelOrObj, pipeline, cacheOpts) => {
  try {
    let model, resolvedPipeline, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedPipeline = modelOrObj.pipeline ?? pipeline;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedPipeline = pipeline;
      resolvedCacheOpts = cacheOpts;
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "aggregate/validation");
    }
    if (!resolvedPipeline || !Array.isArray(resolvedPipeline)) {
      return fail(new Error("Pipeline is required and must be an array of stages"), "aggregate/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `aggregate:${model}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (resolvedCacheOpts?.enabled) {
      return await withCache("aggregate", [model, resolvedPipeline], resolvedCacheOpts, async () => {
        // Execute the aggregation
        const result = await Model.aggregate(resolvedPipeline).exec();

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the result
        return ok(result);
      });
    }

    // Execute the aggregation without cache
    const result = await Model.aggregate(resolvedPipeline).exec();

    // Record database operation metrics
    _recordDb(opName, start);

    // Return the result
    return ok(result);

    // Error handling
  } catch (err) {
    return fail(err, "aggregate");
  }
};

/*******************************************************
 * ##: Update a single document in a model
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, data, writeArg }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Object} [data] - Update data (if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const updateOne = async (modelOrObj, filter, data, writeArg) => {
  try {
    let model, resolvedFilter, resolvedData, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedData = modelOrObj.data ?? data;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedData = data;
      resolvedWriteArg = writeArg;
    }

    // Validate required parameters (return fail on invalid input to follow contract)
    if (!model || typeof model !== "string") {
      return fail(new Error("Model name is required and must be a string"), "updateOne/validation");
    }
    if (!resolvedFilter || typeof resolvedFilter !== "object") {
      return fail(new Error("Filter is required and must be an object"), "updateOne/validation");
    }
    if (!resolvedData || typeof resolvedData !== "object") {
      return fail(new Error("Data is required and must be an object"), "updateOne/validation");
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `updateOne:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Execute update with optional Mongoose options (e.g., session, runValidators)
    const res = await Model.updateOne(resolvedFilter, resolvedData, options);

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
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, data, writeArg }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Object} [data] - Update data (if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const updateMany = async (modelOrObj, filter, data, writeArg) => {
  try {
    let model, resolvedFilter, resolvedData, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedData = modelOrObj.data ?? data;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedData = data;
      resolvedWriteArg = writeArg;
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `updateMany:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Update the documents
    const res = await Model.updateMany(resolvedFilter, resolvedData, options);

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
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, writeArg }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const deleteOne = async (modelOrObj, filter, writeArg) => {
  try {
    let model, resolvedFilter, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedWriteArg = writeArg;
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `deleteOne:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Delete the document
    const res = await Model.deleteOne(resolvedFilter, options);

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
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, writeArg }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const deleteMany = async (modelOrObj, filter, writeArg) => {
  try {
    let model, resolvedFilter, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedWriteArg = writeArg;
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `deleteMany:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Delete the documents
    const res = await Model.deleteMany(resolvedFilter, options);

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

/****************************************************
 * ##: Check if a document should be returned
 * @param {object} opts - Options object
 * History:
 * 28-08-2025: Created
 ****************************************************/
function wantsDoc(opts) {
  return opts?.new === true || opts?.returnDocument === "after" || opts?.returnDocument === true;
}

/*******************************************************
 * ##: Upsert a single document in a model
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, data, writeArg }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Object} [data] - Upsert data (if modelOrObj is string or missing in object)
 * @param {String|String[]|Object} [writeArg] - Flexible extra arg (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 15-08-2025: Added write options
 * 19-08-2025: Removed fallback from options
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases) and implement option for returning the upserted document or counts
 *******************************************************/
const upsertOne = async (modelOrObj, filter, data, writeArg) => {
  try {
    let model, resolvedFilter, resolvedData, resolvedWriteArg;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedData = modelOrObj.data ?? data;
      resolvedWriteArg = modelOrObj.writeArg ?? writeArg;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedData = data;
      resolvedWriteArg = writeArg;
    }

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `upsertOne:${model}`;
    const start = _nowNs();

    // Parse flexible writeArg into { options, invalidateKeys, invalidatePrefixes }
    const { options, invalidateKeys, invalidatePrefixes } = _parseWriteArg(resolvedWriteArg);

    // Merge user-provided options with upsert:true (user options cannot disable upsert)
    const opts = { upsert: true, ...options };
    let res;

    // Upsert the document
    if (wantsDoc(opts) && typeof Model.findOneAndUpdate === "function") {
      // Upsert and return the document
      res = await Model.findOneAndUpdate(resolvedFilter, resolvedData, opts);
    } else {
      // Upsert without returning the document
      res = await Model.updateOne(resolvedFilter, resolvedData, opts);
    }

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
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, select, sort, page, limit, populate, cacheOpts }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Array} [select=[]] - Fields to select (if modelOrObj is string or missing in object)
 * @param {Object} [sort={}] - Sort object (if modelOrObj is string or missing in object)
 * @param {Number} [page=1] - Page number (if modelOrObj is string or missing in object)
 * @param {Number} [limit=100] - Number of documents per page (if modelOrObj is string or missing in object)
 * @param {Array|Object|String} [populate] - Populate definition(s) (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 20-08-2025: Updated (remove default sort)
 * 22-08-2025: Added support for populate
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props and defaults
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const getManyWithPagination = async (modelOrObj, filter, select = [], sort = {}, page = 1, limit = 100, populate, cacheOpts) => {
  try {
    let model, resolvedFilter, resolvedSelect, resolvedSort, resolvedPage, resolvedLimit, resolvedPopulate, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedSelect = modelOrObj.select ?? select;
      resolvedSort = modelOrObj.sort ?? sort;
      resolvedPage = modelOrObj.page ?? page;
      resolvedLimit = modelOrObj.limit ?? limit;
      resolvedPopulate = modelOrObj.populate ?? populate;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedSelect = select;
      resolvedSort = sort;
      resolvedPage = page;
      resolvedLimit = limit;
      resolvedPopulate = populate;
      resolvedCacheOpts = cacheOpts;
    }

    // Apply defaults for optional parameters (in case they are undefined)
    resolvedSelect = resolvedSelect ?? [];
    resolvedSort = resolvedSort ?? {};
    resolvedPage = resolvedPage ?? 1;
    resolvedLimit = resolvedLimit ?? 100;

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `getManyWithPagination:${model}`;
    const start = _nowNs();

    // Query executor (with populate support)
    const runQuery = async () => {
      const total = await Model.countDocuments(resolvedFilter);
      let query = Model.find(resolvedFilter, resolvedSelect)
        .sort(resolvedSort)
        .skip((resolvedPage - 1) * resolvedLimit)
        .limit(resolvedLimit);
      if (resolvedPopulate) query = query.populate(resolvedPopulate);
      const docs = await query.lean();

      // Record database operation metrics
      _recordDb(opName, start);

      // Return the found documents
      return ok({ data: docs, total, page: resolvedPage, limit: resolvedLimit });
    };

    // Use cache only if cacheOpts is defined/active
    if (resolvedCacheOpts?.enabled) {
      return await withCache(
        "getManyWithPagination",
        [model, resolvedFilter, resolvedSelect, resolvedSort, resolvedPage, resolvedLimit, resolvedPopulate],
        resolvedCacheOpts,
        runQuery
      );
    }

    // Execute without cache
    return await runQuery();

    // Error handling
  } catch (err) {
    return fail(err, "getManyWithPagination");
  }
};

/*******************************************************
 * ##: Count documents in a model
 * @param {String|Object} modelOrObj - Model name (string) or object with { model, filter, cacheOpts }
 * @param {Object} [filter] - Filter object (if modelOrObj is string or missing in object)
 * @param {Object} [cacheOpts] - Cache options (if modelOrObj is string or missing in object)
 * History:
 * 14-08-2025: Created
 * 22-08-2025: Updated to flexibly accept either separate params or single object, with fallback for missing props
 * 28-08-2025: remove _checkConnection (edge cases)
 *******************************************************/
const countDocuments = async (modelOrObj, filter, cacheOpts) => {
  try {
    let model, resolvedFilter, resolvedCacheOpts;

    if (typeof modelOrObj === "object" && modelOrObj !== null) {
      // If first arg is an object, extract properties with fallback to extra args
      model = modelOrObj.model;
      resolvedFilter = modelOrObj.filter ?? filter;
      resolvedCacheOpts = modelOrObj.cacheOpts ?? cacheOpts;
    } else {
      // If first arg is string (model name), use provided subsequent args
      model = modelOrObj;
      resolvedFilter = filter;
      resolvedCacheOpts = cacheOpts;
    }

    // Apply default for filter if undefined (empty filter counts all documents)
    resolvedFilter = resolvedFilter ?? {};

    // Resolve the model (cached)
    const Model = await resolveModel(model);

    // Build operation name and start time
    const opName = `countDocuments:${model}`;
    const start = _nowNs();

    // Use cache only if cacheOpts is defined/active
    if (resolvedCacheOpts?.enabled) {
      return await withCache("countDocuments", [model, resolvedFilter], resolvedCacheOpts, async () => {
        // Find the documents (count)
        const count = await Model.countDocuments(resolvedFilter);

        // Record database operation metrics
        _recordDb(opName, start);

        // Return the result
        return ok(count);
      });
    }

    // Find the documents (count) without cache
    const count = await Model.countDocuments(resolvedFilter);

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
  getManyWithLimit,
  getManyWithPagination,
  aggregate,
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
