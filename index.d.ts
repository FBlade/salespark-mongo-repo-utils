declare module "@salespark/mongo-repo-utils" {
  // Base response contract
  interface ApiResponse<T = any> {
    status: boolean;
    data: T;
  }

  // Cache options interface
  interface CacheOptions {
    enabled?: boolean;
    key?: string;
    ttl?: number | string;
    cacheIf?: (res: ApiResponse) => boolean;
  }

  // Write argument interface
  interface WriteOptions {
    session?: any;
    runValidators?: boolean;
    writeConcern?: any;
    ordered?: boolean;
    upsert?: boolean;
    new?: boolean;
    returnDocument?: "before" | "after" | boolean;
    setDefaultsOnInsert?: boolean;
  }

  interface WriteArg {
    options?: WriteOptions;
    invalidateKeys?: string | string[];
    invalidatePrefixes?: string | string[];
  }

  // Transaction options interface
  interface TransactionOptions {
    readConcern?: string;
    writeConcern?: any;
    readPreference?: any;
    maxCommitRetries?: number;
  }

  // Metrics interface
  interface Metrics {
    cache: {
      hits: number;
      misses: number;
      puts: number;
      invalidations: number;
    };
    db: {
      perOp: {
        [operationName: string]: {
          count: number;
          totalMs: number;
          minMs: number;
          maxMs: number;
        };
      };
    };
  }

  // Cache interface
  interface CacheInterface {
    get(key: string): any;
    put(key: string, value: any, ttlMs?: number): boolean;
    del(key: string): boolean;
    keys(): string[];
  }

  /**
   * Resolves a Mongoose model by name from the configured models directory
   * @param modelName - The name of the model to resolve (will be pluralized if needed)
   * @returns The resolved Mongoose model
   */
  export function resolveModel(modelName: string): any;

  /**
   * Sets the directory path where Mongoose models are located
   * @param dir - Absolute path to the models directory
   * @returns Response indicating success or failure
   */
  export function setModelsDir(dir: string): ApiResponse<{ message: string }>;

  /**
   * Configures a logger function for error reporting
   * @param logger - Function to handle errors or logger object (e.g., console)
   * @returns Response indicating success or failure
   */
  export function setLogger(logger: ((err: any, ctx: string) => void) | any): ApiResponse<{ message: string }>;

  /**
   * Configures a cache interface for read operations
   * @param cache - Cache object with get, put, del, and keys methods
   * @returns Response indicating success or failure
   */
  export function setCache(cache: CacheInterface): ApiResponse<{ message: string }>;

  // CRUD Operations

  /**
   * Creates a single document in the specified model
   * @param model - Model name (string)
   * @param payload - Document data to create
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to created document in { status, data } format
   */
  export function createOne(model: string, payload: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Creates a single document using object-style parameters
   * @param options - Object containing model, payload, and writeArg
   * @returns Promise resolving to created document in { status, data } format
   */
  export function createOne(options: { model: string; payload: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Creates multiple documents in the specified model (bulk insert)
   * @param model - Model name (string)
   * @param docs - Array of documents or single document to create
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to array of created documents in { status, data } format
   */
  export function createMany(model: string, docs: object | object[], writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Creates multiple documents using object-style parameters
   * @param options - Object containing model, docs, and writeArg
   * @returns Promise resolving to array of created documents in { status, data } format
   */
  export function createMany(options: { model: string; docs: object | object[]; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Finds a single document matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object
   * @param select - Fields to include/exclude in results
   * @param sort - Sort criteria for ordering results
   * @param populate - Population options for referenced documents
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to found document or null in { status, data } format
   */
  export function getOne(
    model: string,
    filter: object,
    select?: string[] | string,
    sort?: object,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;

  /**
   * Finds a single document using object-style parameters
   * @param options - Object containing all search parameters
   * @returns Promise resolving to found document or null in { status, data } format
   */
  export function getOne(options: {
    model: string;
    filter: object;
    select?: string[] | string;
    sort?: object;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  /**
   * Finds multiple documents matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object (optional, defaults to {})
   * @param select - Fields to include/exclude in results
   * @param sort - Sort order for results
   * @param populate - Population options for referenced documents
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to array of documents in { status, data } format
   */
  export function getMany(
    model: string,
    filter?: object,
    select?: string[] | string,
    sort?: object,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;

  /**
   * Finds multiple documents using object-style parameters
   * @param options - Object containing all search parameters
   * @returns Promise resolving to array of documents in { status, data } format
   */
  export function getMany(options: {
    model: string;
    filter?: object;
    select?: string[] | string;
    sort?: object;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  /**
   * Finds multiple documents with a maximum limit (simple limiting without pagination metadata)
   *
   * Use this function when you need to limit results without full pagination.
   * For pagination with metadata (page info, totals), use getManyWithPagination instead.
   *
   * @param model - Model name (string)
   * @param filter - MongoDB filter object (optional, defaults to {})
   * @param select - Fields to include/exclude in results
   * @param sort - Sort order for results
   * @param limit - Maximum number of documents to return
   * @param populate - Population options for referenced documents
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to limited array of documents in { status, data } format
   *
   * @example
   * ```typescript
   * // Get latest 10 active products
   * await getManyWithLimit("products", { active: true }, ["name", "price"], { createdAt: -1 }, 10);
   * ```
   *
   * @example
   * ```typescript
   * // Using object style with populate
   * await getManyWithLimit({
   *   model: "orders",
   *   filter: { status: "pending" },
   *   limit: 25,
   *   populate: { path: "customer", select: "name email" }
   * });
   * ```
   */
  export function getManyWithLimit(
    model: string,
    filter?: object,
    select?: string[] | string,
    sort?: object,
    limit?: number,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;

  /**
   * Finds multiple documents with limit using object-style parameters
   * @param options - Object containing all search parameters including limit
   * @returns Promise resolving to limited array of documents in { status, data } format
   */
  export function getManyWithLimit(options: {
    model: string;
    filter?: object;
    select?: string[] | string;
    sort?: object;
    limit?: number;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  /**
   * Finds multiple documents with pagination support and metadata
   * @param model - Model name (string)
   * @param filter - MongoDB filter object (optional, defaults to {})
   * @param select - Fields to include/exclude in results
   * @param sort - Sort order for results
   * @param page - Page number (starts from 1)
   * @param limit - Number of documents per page
   * @param populate - Population options for referenced documents
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to paginated results with metadata in { status, data } format
   */
  export function getManyWithPagination(
    model: string,
    filter?: object,
    select?: string[] | string,
    sort?: object,
    page?: number,
    limit?: number,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;

  /**
   * Finds multiple documents with pagination using object-style parameters
   * @param options - Object containing all search and pagination parameters
   * @returns Promise resolving to paginated results with metadata in { status, data } format
   */
  export function getManyWithPagination(options: {
    model: string;
    filter?: object;
    select?: string[] | string;
    sort?: object;
    page?: number;
    limit?: number;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  /**
   * Executes a MongoDB aggregation pipeline
   * @param model - Model name (string)
   * @param pipeline - Array of aggregation pipeline stages
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to aggregation results in { status, data } format
   */
  export function aggregate(model: string, pipeline: object[], cacheOpts?: CacheOptions): Promise<ApiResponse>;

  /**
   * Executes aggregation using object-style parameters
   * @param options - Object containing model, pipeline, and cache options
   * @returns Promise resolving to aggregation results in { status, data } format
   */
  export function aggregate(options: { model: string; pipeline: object[]; cacheOpts?: CacheOptions }): Promise<ApiResponse>;

  /**
   * Counts documents matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object (optional, defaults to {})
   * @param cacheOpts - Cache configuration options
   * @returns Promise resolving to document count in { status, data } format
   */
  export function countDocuments(model: string, filter?: object, cacheOpts?: CacheOptions): Promise<ApiResponse>;

  /**
   * Counts documents using object-style parameters
   * @param options - Object containing model, filter, and cache options
   * @returns Promise resolving to document count in { status, data } format
   */
  export function countDocuments(options: { model: string; filter?: object; cacheOpts?: CacheOptions }): Promise<ApiResponse>;

  /**
   * Updates a single document matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object to find document to update
   * @param data - Update data object
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to update result in { status, data } format
   */
  export function updateOne(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Updates a single document using object-style parameters
   * @param options - Object containing model, filter, data, and writeArg
   * @returns Promise resolving to update result in { status, data } format
   */
  export function updateOne(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Updates multiple documents matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object to find documents to update
   * @param data - Update data object
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to update result in { status, data } format
   */
  export function updateMany(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Updates multiple documents using object-style parameters
   * @param options - Object containing model, filter, data, and writeArg
   * @returns Promise resolving to update result in { status, data } format
   */
  export function updateMany(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Updates or inserts a document (upsert operation)
   * @param model - Model name (string)
   * @param filter - MongoDB filter object to find document
   * @param data - Update/insert data object
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to upsert result in { status, data } format
   */
  export function upsertOne(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Upserts a document using object-style parameters
   * @param options - Object containing model, filter, data, and writeArg
   * @returns Promise resolving to upsert result in { status, data } format
   */
  export function upsertOne(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Deletes a single document matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object to find document to delete
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to delete result in { status, data } format
   */
  export function deleteOne(model: string, filter: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Deletes a single document using object-style parameters
   * @param options - Object containing model, filter, and writeArg
   * @returns Promise resolving to delete result in { status, data } format
   */
  export function deleteOne(options: { model: string; filter: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Deletes multiple documents matching the filter criteria
   * @param model - Model name (string)
   * @param filter - MongoDB filter object to find documents to delete
   * @param writeArg - Optional write options, session, or cache invalidation keys
   * @returns Promise resolving to delete result in { status, data } format
   */
  export function deleteMany(model: string, filter: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;

  /**
   * Deletes multiple documents using object-style parameters
   * @param options - Object containing model, filter, and writeArg
   * @returns Promise resolving to delete result in { status, data } format
   */
  export function deleteMany(options: { model: string; filter: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  /**
   * Executes work within a MongoDB transaction
   * @param work - Async function that receives a session parameter
   * @param txOptions - Transaction options (readConcern, writeConcern, etc.)
   * @returns Promise resolving to transaction result in { status, data } format
   */
  export function withTransaction(work: (session: any) => Promise<any>, txOptions?: TransactionOptions): Promise<ApiResponse>;

  /**
   * Executes transaction using object-style parameters
   * @param options - Object containing work function and transaction options
   * @returns Promise resolving to transaction result in { status, data } format
   */
  export function withTransaction(options: { work: (session: any) => Promise<any>; txOptions?: TransactionOptions }): Promise<ApiResponse>;

  /**
   * Safely executes any function and ensures { status, data } response format
   * @param fn - Function to execute safely
   * @param args - Arguments to pass to the function
   * @returns Promise resolving to function result in { status, data } format
   */
  export function safeQuery(fn: Function, ...args: any[]): Promise<ApiResponse>;

  /**
   * Gets current performance and cache metrics
   * @returns Metrics object containing cache and database operation statistics
   */
  export function getMetrics(): ApiResponse<Metrics>;

  /**
   * Resets all metrics counters to zero
   * @returns Response indicating successful reset
   */
  export function resetMetrics(): ApiResponse<{ message: string }>;

  /**
   * Manually invalidates cache entries by keys and/or prefixes
   * @param input - Cache keys, prefixes, or object with keys/prefixes arrays
   * @returns Response with number of invalidated entries
   */
  export function invalidateCache(input: string | string[] | { keys?: string | string[]; prefixes?: string | string[] }): ApiResponse<{ invalidated: number }>;
}
