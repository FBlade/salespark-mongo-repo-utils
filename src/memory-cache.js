"use strict";
class MemoryCache {
  constructor(maxEntries = 5000, defaultTTL = 60_000) {
    this.cache = new Map(); // Key: string, Value: { value, expiresAt, timeout }
    this.maxEntries = maxEntries;
    this.defaultTTL = defaultTTL; // in ms
    this._hitCount = 0;
    this._missCount = 0;
    this._debug = false;

    function humanFileSize(bytes, si = false, dp = 1) {
      const thresh = si ? 1000 : 1024;

      if (Math.abs(bytes) < thresh) {
        return bytes + " B";
      }

      const units = si ? ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"] : ["kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"]; //["KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
      let u = -1;
      const r = 10 ** dp;

      do {
        bytes /= thresh;
        ++u;
      } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

      return bytes.toFixed(dp) + " " + units[u];
    }

    /******************************************************************
     * ##: Debug Memory Usage (TEMP)
     * Imprime periodicamente o tamanho dos arrays globais
     * History:
     * 06-06-2025: Created
     ******************************************************************/
    const debugMemoryUsage = () => {
      setInterval(() => {
        // Print cache size and size in bytes
        console.log(`🔴🔴🔴 [MemoryCacheV2 Mongo-Repo-Utils] : ${this.cache.size}, (${humanFileSize(this.sizebytes())})`);
      }, 15000); //  every 15 seconds
    };

    debugMemoryUsage();
  }

  _log(...args) {
    if (this._debug) console.log("[MemoryCache]", ...args);
  }

  _delete(key) {
    const record = this.cache.get(key);
    if (record && record.timeout) clearTimeout(record.timeout);
    this.cache.delete(key);
  }

  putResolver(key, value, ttl, timeoutCallback) {
    return new Promise((resolve) => {
      if (timeoutCallback && typeof timeoutCallback !== "function") {
        //throw new Error("MemoryCache timeout callback must be a function");
        resolve({ status: false, data: "Timeout callback must be a function" });
        return;
      }

      // Clear existing timeout if key exists
      if (this.cache.has(key)) {
        clearTimeout(this.cache.get(key).timeout);
        this.cache.delete(key);
      }

      // Remove oldest if limit is reached
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        this._delete(oldestKey);
      }

      // Implemented no TTL (Infinity) for no expiration
      if (ttl === -1) {
        this.cache.set(key, { value, expiresAt: Infinity, timeout: null });
      } else {
        const expiresAt = Date.now() + ttl;
        const timeout = setTimeout(() => {
          this._delete(key);
          if (timeoutCallback) timeoutCallback(key, value);
        }, ttl);
        this.cache.set(key, { value, expiresAt, timeout });
      }

      resolve({ status: true, data: value });
      //return value;
    });
  }

  put(key, value, ttl = this.defaultTTL, timeoutCallback) {
    // if (typeof ttl !== "number" || isNaN(ttl) || ttl <= 0) {
    //   throw new Error("MemoryCache TTL must be a positive number");
    // }

    if (timeoutCallback && typeof timeoutCallback !== "function") {
      throw new Error("MemoryCache timeout callback must be a function");
    }

    // Clear existing timeout if key exists
    if (this.cache.has(key)) {
      clearTimeout(this.cache.get(key).timeout);
      this.cache.delete(key);
    }

    // Remove oldest if limit is reached
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      this._delete(oldestKey);
    }

    // Implemented no TTL (Infinity) for no expiration
    if (ttl === -1) {
      this.cache.set(key, { value, expiresAt: Infinity, timeout: null });
    } else {
      const expiresAt = Date.now() + ttl;
      const timeout = setTimeout(() => {
        this._delete(key);
        if (timeoutCallback) timeoutCallback(key, value);
      }, ttl);
      this.cache.set(key, { value, expiresAt, timeout });
    }

    return value;
  }

  get(key, defaultValue = null) {
    const record = this.cache.get(key);
    if (!record) {
      this._missCount++;
      return defaultValue;
    }

    if (record.expiresAt !== Infinity) {
      if (Date.now() > record.expiresAt) {
        this._missCount++;
        this._delete(key);
        return defaultValue;
      }
    }

    this._hitCount++;

    // Refresh position in Map (LRU)
    this.cache.delete(key);
    this.cache.set(key, record);

    return record.value;
  }

  getResolver = (key, defaultValue = null) => {
    return new Promise((resolve) => {
      const record = this.cache.get(key);
      if (!record) {
        this._missCount++;
        resolve({ status: true, data: defaultValue });
        return;
      }

      if (record.expiresAt !== Infinity) {
        if (Date.now() > record.expiresAt) {
          this._missCount++;
          this._delete(key);
          resolve({ status: true, data: defaultValue });
          return;
        }
      }

      this._hitCount++;

      // Refresh position in Map (LRU)
      this.cache.delete(key);
      this.cache.set(key, record);

      resolve({ status: true, data: record.value });
    });
  };

  /******************************************************************
   * ##: Delete a record from cache
   * Deletes the record if not expired or if force is true
   *
   * @param {string} key - The key to delete
   * @param {boolean} force - If true, delete even if expired
   * @returns {boolean} - True if deleted, false otherwise
   *
   * History:
   * 02-01-2026: Added force parameter
   ******************************************************************/
  del(key, force = false) {
    const record = this.cache.get(key);
    if (!record) {
      return false;
    }

    let canDelete = true;
    if (!force) {
      if (record.expiresAt !== Infinity && Date.now() > record.expiresAt) {
        canDelete = false;
      }
    }

    if (canDelete) {
      clearTimeout(record.timeout);
      return this.cache.delete(key);
    }

    return false;
  }

  delByPatternResolver(pattern) {
    return new Promise((resolve) => {
      try {
        const regex = new RegExp(pattern);
        for (const key of this.cache.keys()) {
          if (regex.test(key)) {
            this._delete(key);
          }
        }
        resolve({ status: true });

        // Error handling
      } catch (error) {
        resolve({ status: false, data: error.message });
      }
    });
  }

  delResolver(key) {
    return new Promise((resolve) => {
      try {
        const response = this.cache.delete(key);

        if (response) {
          resolve({ status: true, data: `Key "${key}" deleted successfully.` });
        } else {
          resolve({ status: true, data: `Key "${key}" not found.` });
        }

        // Error handling
      } catch (error) {
        resolve({ status: false, data: error.message });
      }
    });
  }

  clear() {
    for (const [, record] of this.cache) {
      clearTimeout(record.timeout);
    }
    this.cache.clear();
    this._hitCount = 0;
    this._missCount = 0;
  }

  size() {
    return this.cache.size;
  }

  hits() {
    return this._hitCount;
  }

  misses() {
    return this._missCount;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  sizebytes() {
    try {
      let total = 0;
      for (const [key, record] of this.cache) {
        total += Buffer.byteLength(key);
        total += Buffer.byteLength(JSON.stringify(record.value));
      }
      return total;

      // Error handling
    } catch (error) {
      return 0;
    }
  }

  debug(bool) {
    this._debug = !!bool;
  }
}

module.exports = new MemoryCache();
module.exports.MemoryCache = MemoryCache;
