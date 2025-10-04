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

  // Model resolution function
  export function resolveModel(modelName: string): any;

  // Configuration functions
  export function setModelsDir(dir: string): ApiResponse<{ message: string }>;
  export function setLogger(logger: ((err: any, ctx: string) => void) | any): ApiResponse<{ message: string }>;
  export function setCache(cache: CacheInterface): ApiResponse<{ message: string }>;

  // CRUD Operations

  // Create operations
  export function createOne(model: string, payload: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function createOne(options: { model: string; payload: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  export function createMany(model: string, docs: object | object[], writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function createMany(options: { model: string; docs: object | object[]; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  // Read operations
  export function getOne(model: string, filter: object, select?: string[] | string, populate?: any, cacheOpts?: CacheOptions): Promise<ApiResponse>;
  export function getOne(options: {
    model: string;
    filter: object;
    select?: string[] | string;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  export function getMany(
    model: string,
    filter?: object,
    select?: string[] | string,
    sort?: object,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;
  export function getMany(options: {
    model: string;
    filter?: object;
    select?: string[] | string;
    sort?: object;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

  export function getManyWithLimit(
    model: string,
    filter?: object,
    select?: string[] | string,
    sort?: object,
    limit?: number,
    populate?: any,
    cacheOpts?: CacheOptions
  ): Promise<ApiResponse>;
  export function getManyWithLimit(options: {
    model: string;
    filter?: object;
    select?: string[] | string;
    sort?: object;
    limit?: number;
    populate?: any;
    cacheOpts?: CacheOptions;
  }): Promise<ApiResponse>;

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

  export function aggregate(model: string, pipeline: object[], cacheOpts?: CacheOptions): Promise<ApiResponse>;
  export function aggregate(options: { model: string; pipeline: object[]; cacheOpts?: CacheOptions }): Promise<ApiResponse>;

  export function countDocuments(model: string, filter?: object, cacheOpts?: CacheOptions): Promise<ApiResponse>;
  export function countDocuments(options: { model: string; filter?: object; cacheOpts?: CacheOptions }): Promise<ApiResponse>;

  // Update operations
  export function updateOne(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function updateOne(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  export function updateMany(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function updateMany(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  export function upsertOne(model: string, filter: object, data: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function upsertOne(options: { model: string; filter: object; data: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  // Delete operations
  export function deleteOne(model: string, filter: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function deleteOne(options: { model: string; filter: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  export function deleteMany(model: string, filter: object, writeArg?: string | string[] | WriteArg): Promise<ApiResponse>;
  export function deleteMany(options: { model: string; filter: object; writeArg?: string | string[] | WriteArg }): Promise<ApiResponse>;

  // Transaction support
  export function withTransaction(work: (session: any) => Promise<any>, txOptions?: TransactionOptions): Promise<ApiResponse>;
  export function withTransaction(options: { work: (session: any) => Promise<any>; txOptions?: TransactionOptions }): Promise<ApiResponse>;

  // Utility functions
  export function safeQuery(fn: Function, ...args: any[]): Promise<ApiResponse>;
  export function getMetrics(): ApiResponse<Metrics>;
  export function resetMetrics(): ApiResponse<{ message: string }>;
  export function invalidateCache(input: string | string[] | { keys?: string | string[]; prefixes?: string | string[] }): ApiResponse<{ invalidated: number }>;
}
