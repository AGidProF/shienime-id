const express = require("express");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();
const PORT = process.env.PORT || 3000;

// Simple p-limit alternative
function createLimit(concurrency) {
  let running = 0;
  const queue = [];
  
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      tryNext();
    });
  };
  
  function tryNext() {
    if (running >= concurrency || queue.length === 0) return;
    
    running++;
    const { fn, resolve, reject } = queue.shift();
    
    Promise.resolve(fn())
      .then(resolve, reject)
      .finally(() => {
        running--;
        tryNext();
      });
  }
}

const proxySources = [
  "https://api.proxyscrape.com/v4/free-proxy-list/get?request=get_proxies&protocol=http&proxy_format=ipport&format=text&timeout=20000",
  "https://proxylist.geonode.com/api/proxy-list?protocols=http%2Chttps&limit=500&page=1&sort_by=lastChecked&sort_type=desc",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/ebrasha/abdal-proxy-hub/refs/heads/main/http-proxy-list-by-EbraSha.txt",
  "https://raw.githubusercontent.com/dpangestuw/Free-Proxy/refs/heads/main/http_proxies.txt",
  "https://raw.githubusercontent.com/elliottophellia/proxylist/refs/heads/master/results/mix_checked.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt",
  "https://raw.githubusercontent.com/databay-labs/free-proxy-list/refs/heads/master/http.txt",
  "https://raw.githubusercontent.com/MrMarble/proxy-list/refs/heads/main/all.txt",
  "https://raw.githubusercontent.com/saisuiu/Lionkings-Http-Proxys-Proxies/refs/heads/main/free.txt",
  "https://raw.githubusercontent.com/vmheaven/VMHeaven-Free-Proxy-Updated/refs/heads/main/http.txt",
  "https://raw.githubusercontent.com/vmheaven/VMHeaven-Free-Proxy-Updated/refs/heads/main/https.txt",
  "https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/http.txt"
];

// ===============================
// SMART CACHE SYSTEM WITH VIDEO SUPPORT
// ===============================
class SmartCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 1024; // Reduced cache size
    this.ttl = 60 * 60 * 1000; // 60 minutes TTL
    this.maxFileSize = 50 * 1024 * 1024; // 50MB max file size for caching
    this.hitCount = 0;
    this.missCount = 0;
    this.evictedCount = 0;
    this.skipCount = 0; // Track skipped large files
    
    // Video/streaming file extensions that shouldn't be fully cached
    this.streamingExtensions = new Set([
      '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v',
      '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
      '.zip', '.rar', '.7z', '.tar', '.gz',
      '.iso', '.bin', '.dmg'
    ]);
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  generateKey(url) {
    return `url:${url}`;
  }

  shouldCache(url, contentType, contentLength, headers) {
    // Don't cache if content is too large
    if (contentLength && contentLength > this.maxFileSize) {
      return false;
    }

    // Don't cache video/audio streams
    if (contentType) {
      const type = contentType.toLowerCase();
      if (type.includes('video/') || 
          type.includes('audio/') || 
          type.includes('application/octet-stream') ||
          type.includes('application/zip') ||
          type.includes('application/x-rar')) {
        return false;
      }
    }

    // Check file extension in URL
    const urlPath = new URL(url).pathname.toLowerCase();
    for (const ext of this.streamingExtensions) {
      if (urlPath.includes(ext)) {
        return false;
      }
    }

    // Don't cache if response has Accept-Ranges header (indicates streaming support)
    if (headers && headers['accept-ranges']) {
      return false;
    }

    return true;
  }

  set(url, data, headers, contentType) {
    const contentLength = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString());
    
    if (!this.shouldCache(url, contentType, contentLength, headers)) {
      this.skipCount++;
      console.log(`🚫 Skipping cache for streaming/large content: ${url} (${Math.round(contentLength/1024)}KB)`);
      return false;
    }

    const key = this.generateKey(url);
    
    // Remove oldest entries if cache is full
    if (this.cache.size >= this.maxSize) {
      const oldestKeys = Array.from(this.cache.keys()).slice(0, Math.floor(this.maxSize * 0.1));
      oldestKeys.forEach(k => {
        this.cache.delete(k);
        this.evictedCount++;
      });
    }

    this.cache.set(key, {
      data,
      headers,
      contentType,
      timestamp: Date.now(),
      hits: 0,
      size: contentLength
    });
    
    console.log(`💾 Cache stored: ${url} (${Math.round(contentLength/1024)}KB, ${this.cache.size}/${this.maxSize})`);
    return true;
  }

  get(url) {
    const key = this.generateKey(url);
    const item = this.cache.get(key);
    
    if (!item) {
      this.missCount++;
      return null;
    }
    
    // Check if expired
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      this.missCount++;
      return null;
    }
    
    // Update hit count and move to end (LRU)
    item.hits++;
    this.cache.delete(key);
    this.cache.set(key, item);
    this.hitCount++;
    
    return item;
  }

  invalidate(url) {
    const key = this.generateKey(url);
    const deleted = this.cache.delete(key);
    if (deleted) {
      console.log(`🗑️ Cache invalidated: ${url}`);
    }
    return deleted;
  }

  clear() {
    const size = this.cache.size;
    this.cache.clear();
    console.log(`🗑️ Cache cleared: ${size} entries removed`);
  }

  cleanup() {
    const before = this.cache.size;
    const now = Date.now();
    
    for (const [key, item] of this.cache.entries()) {
      if (now - item.timestamp > this.ttl) {
        this.cache.delete(key);
      }
    }
    
    const after = this.cache.size;
    if (before > after) {
      console.log(`🧹 Cache cleanup: ${before - after} expired entries removed`);
    }
  }

  getStats() {
    const totalRequests = this.hitCount + this.missCount + this.skipCount;
    const totalSize = Array.from(this.cache.values()).reduce((sum, item) => sum + (item.size || 0), 0);
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      skipCount: this.skipCount,
      hitRate: totalRequests > 0 ? (this.hitCount / totalRequests * 100).toFixed(2) + '%' : '0%',
      skipRate: totalRequests > 0 ? (this.skipCount / totalRequests * 100).toFixed(2) + '%' : '0%',
      evictedCount: this.evictedCount,
      ttl: this.ttl,
      totalSize: totalSize,
      maxFileSize: this.maxFileSize,
      avgFileSize: this.cache.size > 0 ? Math.round(totalSize / this.cache.size) : 0
    };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// ===============================
// COMPREHENSIVE PROXY MANAGER (unchanged)
// ===============================
class ProxyManager {
  constructor() {
    this.workingProxies = new Map();
    this.allProxies = new Set();
    this.deadProxies = new Map();
    this.testingQueue = new Set();
    this.fastProxies = new Set();
    
    this.isFetching = false;
    this.isTesting = false;
    this.testingProgress = { current: 0, total: 0, batch: 0 };
    
    this.stats = {
      totalFetched: 0,
      totalTested: 0,
      totalWorking: 0,
      totalDead: 0,
      testingSessions: 0,
      lastUpdate: null,
      lastFullScan: null,
      avgTestTime: 0,
      totalTestTime: 0,
      racingWins: 0,
      instantSwitches: 0
    };
    
    this.intervals = {};
  }

  async fetchProxies() {
    if (this.isFetching) {
      console.log("⏳ Fetch already in progress, skipping...");
      return this.allProxies;
    }

    this.isFetching = true;
    console.log("🔄 Fetching proxies from all sources...");
    let newProxies = [];
    
    const fetchPromises = proxySources.map(async (url, index) => {
      try {
        console.log(`📡 [${index + 1}/${proxySources.length}] Fetching from: ${url.split('/')[2]}`);
        const res = await axios.get(url, { 
          timeout: 20000,
          maxRedirects: 3
        });
        
        let proxies = [];
        if (url.includes("geonode")) {
          if (res.data && res.data.data) {
            proxies = res.data.data.map(p => `${p.ip}:${p.port}`);
          }
        } else {
          proxies = res.data
            .split("\n")
            .map(l => l.trim().replace(/^http(s)?:\/\//, ""))
            .filter(l => l && l.includes(':') && l.split(':').length === 2)
            .filter(l => {
              const [ip, port] = l.split(':');
              return ip.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/) && 
                     port.match(/^\d+$/) && 
                     parseInt(port) > 0 && 
                     parseInt(port) < 65536;
            });
        }
        
        newProxies.push(...proxies);
        console.log(`✅ [${index + 1}/${proxySources.length}] Got ${proxies.length} proxies from: ${url.split('/')[2]}`);
        return proxies.length;
      } catch (err) {
        console.log(`❌ [${index + 1}/${proxySources.length}] Failed: ${url.split('/')[2]} - ${err.message}`);
        return 0;
      }
    });
    
    const results = await Promise.allSettled(fetchPromises);
    const totalFetched = results.reduce((sum, result) => {
      return sum + (result.status === 'fulfilled' ? result.value : 0);
    }, 0);
    
    const uniqueProxies = [...new Set(newProxies)];
    const beforeSize = this.allProxies.size;
    uniqueProxies.forEach(p => this.allProxies.add(p));
    const newCount = this.allProxies.size - beforeSize;
    
    this.stats.totalFetched = this.allProxies.size;
    this.stats.lastUpdate = new Date();
    
    console.log(`📊 Fetch complete: ${uniqueProxies.length} total, ${newCount} new, ${this.allProxies.size} unique proxies`);
    
    this.isFetching = false;
    return this.allProxies;
  }

  async testProxy(proxy, testUrls = ["https://otakudesu.best/anime/watanare-sub-indo", "https://v1.samehadaku.how"]) {
    const startTime = Date.now();
    
    for (const testUrl of testUrls) {
      try {
        const agent = new HttpsProxyAgent(`http://${proxy}`);
        const res = await axios.get(testUrl, {
          httpAgent: agent,
          httpsAgent: agent,
          timeout: 10000,
          maxRedirects: 3,
          validateStatus: () => true
        });
        
        const responseTime = Date.now() - startTime;
        
        if (res.status === 200 && res.data) {
          return { 
            proxy, 
            responseTime, 
            success: true, 
            testUrl,
            dataSize: Buffer.isBuffer(res.data) ? res.data.length : res.data.toString().length
          };
        }
      } catch (err) {
        continue;
      }
    }
    
    return { 
      proxy, 
      responseTime: Date.now() - startTime, 
      success: false 
    };
  }

  getBestWorkingProxy() {
    if (this.workingProxies.size === 0) return null;
    
    const sortedProxies = Array.from(this.workingProxies.entries())
      .map(([proxy, metadata]) => ({
        proxy,
        metadata,
        score: this.calculateProxyScore(metadata)
      }))
      .sort((a, b) => b.score - a.score);
    
    const topCount = Math.max(1, Math.ceil(sortedProxies.length * 0.1));
    const randomIndex = Math.floor(Math.random() * topCount);
    return sortedProxies[randomIndex].proxy;
  }

  calculateProxyScore(metadata) {
    const successRate = metadata.successCount / (metadata.successCount + metadata.failCount);
    const responseScore = 1000 / (metadata.avgResponseTime + 100);
    const ageBonus = Math.min(1, (Date.now() - metadata.addedAt.getTime()) / (24 * 60 * 60 * 1000));
    
    return successRate * responseScore * (1 + ageBonus);
  }

  removeFailedProxy(proxy) {
    if (this.workingProxies.has(proxy)) {
      const metadata = this.workingProxies.get(proxy);
      this.workingProxies.delete(proxy);
      this.fastProxies.delete(proxy);
      this.deadProxies.set(proxy, {
        lastTested: new Date(),
        failCount: metadata.failCount + 1,
        lastError: 'Request failed'
      });
      this.stats.totalWorking = this.workingProxies.size;
      this.stats.totalDead = this.deadProxies.size;
      console.log(`🗑️ Removed failed proxy: ${proxy}`);
    }
  }

  startBackgroundTasks() {
    console.log("🚀 Starting comprehensive proxy manager...");
    
    this.fetchProxies().then(() => {
      setTimeout(() => this.testAllProxies(), 5000);
    });

    this.intervals.fetch = setInterval(async () => {
      await this.fetchProxies();
      if (!this.isTesting) {
        setTimeout(() => this.testAllProxies(), 10000);
      }
    }, 30 * 60 * 1000);
  }

  async testAllProxies() {
    if (this.isTesting) return;
    this.isTesting = true;
    
    const untestedProxies = Array.from(this.allProxies).filter(proxy => 
      !this.workingProxies.has(proxy) && 
      !this.deadProxies.has(proxy) &&
      !this.testingQueue.has(proxy)
    );
    
    if (untestedProxies.length === 0) {
      this.isTesting = false;
      return;
    }

    console.log(`🚀 Testing ${untestedProxies.length} proxies...`);
    
    const batchSize = 100;
    const concurrency = 25;
    const limit = createLimit(concurrency);
    
    for (let i = 0; i < untestedProxies.length; i += batchSize) {
      const batch = untestedProxies.slice(i, i + batchSize);
      
      batch.forEach(proxy => this.testingQueue.add(proxy));
      
      const tasks = batch.map(proxy =>
        limit(async () => {
          const result = await this.testProxy(proxy);
          this.testingQueue.delete(proxy);
          
          const now = new Date();
          
          if (result.success) {
            this.workingProxies.set(proxy, {
              successCount: 1,
              failCount: 0,
              totalResponseTime: result.responseTime,
              avgResponseTime: result.responseTime,
              lastTested: now,
              addedAt: now,
              successRate: 1.0
            });
          } else {
            this.deadProxies.set(proxy, {
              lastTested: now,
              failCount: 1,
              lastError: 'Connection failed'
            });
          }
          
          return result;
        })
      );

      await Promise.allSettled(tasks);
    }

    this.stats.totalWorking = this.workingProxies.size;
    this.stats.totalDead = this.deadProxies.size;
    
    console.log(`✅ Testing complete: ${this.workingProxies.size} working, ${this.deadProxies.size} dead`);
    this.isTesting = false;
  }

  getStats() {
    return {
      ...this.stats,
      workingProxiesCount: this.workingProxies.size,
      deadProxiesCount: this.deadProxies.size,
      totalProxiesCount: this.allProxies.size,
      isTesting: this.isTesting,
      isFetching: this.isFetching
    };
  }
}

// ===============================
// ENHANCED FETCH WITH VIDEO STREAMING SUPPORT
// ===============================
async function fetchWithProxy(url, req, maxRetries = 8, useCache = true, cache) {
  // Check if this is a range request (video streaming)
  const isRangeRequest = req.headers.range;
  
  // For range requests, don't use cache
  if (isRangeRequest) {
    console.log(`📹 Range request detected for: ${url} (${req.headers.range})`);
    useCache = false;
  }

  // Check cache first (only for non-range requests)
  if (useCache) {
    const cached = cache.get(url);
    if (cached) {
      console.log(`⚡ Cache hit: ${url}`);
      return {
        data: cached.data,
        headers: cached.headers,
        contentType: cached.contentType,
        fromCache: true,
        cacheHits: cached.hits
      };
    }
  }

  if (proxyManager.workingProxies.size === 0) {
    throw new Error(`No working proxies available`);
  }

  const startTime = Date.now();
  let usedProxies = new Set();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const proxy = proxyManager.getBestWorkingProxy();
    
    if (!proxy || usedProxies.has(proxy)) {
      if (usedProxies.size >= proxyManager.workingProxies.size) {
        usedProxies.clear();
      }
      if (!proxy) {
        throw new Error("No working proxies available");
      }
    }

    usedProxies.add(proxy);
    
    try {
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      
      // Prepare headers for proxy request
      const proxyHeaders = {};
      
      // Forward important headers for video streaming
      if (req.headers.range) {
        proxyHeaders.Range = req.headers.range;
      }
      if (req.headers['user-agent']) {
        proxyHeaders['User-Agent'] = req.headers['user-agent'];
      }
      if (req.headers.referer) {
        proxyHeaders.Referer = req.headers.referer;
      }
      
      const response = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: isRangeRequest ? 15000 : 8000, // Longer timeout for video
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: 'arraybuffer',
        headers: proxyHeaders
      });
      
      const duration = Date.now() - startTime;
      
      // Accept both 200 (full content) and 206 (partial content for range requests)
      if (response.status === 200 || response.status === 206) {
        const contentType = response.headers['content-type'];
        const contentLength = response.headers['content-length'];
        
        console.log(`✅ Success with proxy: ${proxy} (${duration}ms, ${response.status}, ${Math.round(response.data.length/1024)}KB)`);
        
        // Only cache if it's cacheable content
        let cached = false;
        if (useCache && response.status === 200) { // Don't cache partial content
          cached = cache.set(url, response.data, response.headers, contentType);
        }
        
        return {
          data: response.data,
          headers: response.headers,
          contentType: contentType,
          proxy: proxy,
          duration: duration,
          attempts: attempt,
          fromCache: false,
          status: response.status,
          cached: cached
        };
      } else {
        console.log(`⚠️ Non-success response from ${proxy}: ${response.status}`);
        continue;
      }
      
    } catch (err) {
      console.log(`❌ Failed with proxy: ${proxy} (attempt ${attempt}/${maxRetries}) - ${err.message}`);
      proxyManager.removeFailedProxy(proxy);
      
      if (attempt === maxRetries) {
        const duration = Date.now() - startTime;
        throw new Error(`All ${maxRetries} attempts failed after ${duration}ms`);
      }
    }
  }
}

// Initialize managers
const proxyManager = new ProxyManager();
const cache = new SmartCache(); // Use new SmartCache

// ===============================
// EXPRESS ROUTES WITH VIDEO STREAMING SUPPORT
// ===============================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  next();
});

// Enhanced main proxy endpoint with video streaming support
app.get('/proxies', async (req, res) => {
  const { url, nocache } = req.query;
  
  if (!url) {
    return res.status(400).json({ 
      error: 'URL parameter is required',
      example: '/proxies?url=https://example.com',
      videoStreaming: 'Automatically supports video streaming with range requests'
    });
  }

  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const startTime = Date.now();
  const useCache = nocache !== '1' && nocache !== 'true';
  const isRangeRequest = !!req.headers.range;

  try {
    console.log(`🌐 Fetching: ${url} ${isRangeRequest ? '(RANGE REQUEST)' : ''} ${!useCache ? '(NO-CACHE)' : ''}`);
    
    const result = await fetchWithProxy(url, req, 8, useCache, cache);
    
    // Set appropriate headers for response
    if (result.contentType) {
      res.set('Content-Type', result.contentType);
    }
    
    // Handle video streaming headers
    if (result.status === 206) {
      res.status(206);
      if (result.headers['content-range']) {
        res.set('Content-Range', result.headers['content-range']);
      }
      if (result.headers['accept-ranges']) {
        res.set('Accept-Ranges', result.headers['accept-ranges']);
      }
    }
    
    // Set content length
    if (result.headers['content-length']) {
      res.set('Content-Length', result.headers['content-length']);
    }
    
    // Enable range requests for video content
    if (result.contentType && (result.contentType.includes('video/') || result.contentType.includes('audio/'))) {
      res.set('Accept-Ranges', 'bytes');
    }
    
    // Performance headers
    res.set('X-Proxy-Used', result.proxy || 'cache');
    res.set('X-Response-Time', `${result.duration || Date.now() - startTime}ms`);
    res.set('X-Attempts', result.attempts || 0);
    res.set('X-Cache-Status', result.fromCache ? 'HIT' : (result.cached ? 'STORED' : 'SKIP'));
    res.set('X-Available-Proxies', proxyManager.workingProxies.size);
    res.set('X-Content-Size', Math.round(result.data.length / 1024) + 'KB');
    res.set('X-Range-Request', isRangeRequest ? 'YES' : 'NO');
    
    res.send(result.data);
    
  } catch (err) {
    cache.invalidate(url);
    
    const duration = Date.now() - startTime;
    console.error(`❌ Error after ${duration}ms:`, err.message);
    
    res.status(500).json({ 
      error: 'Failed to fetch URL through proxy',
      details: err.message,
      duration: `${duration}ms`,
      availableProxies: proxyManager.workingProxies.size,
      isRangeRequest: isRangeRequest,
      suggestion: 'For video streaming, ensure your player supports range requests properly'
    });
  }
});

// Get proxy statistics with cache info
app.get('/proxies/stats', (req, res) => {
  res.json({
    stats: proxyManager.getStats(),
    cache: cache.getStats()
  });
});

// Cache management
app.get('/proxies/cache', (req, res) => {
  const showEntries = req.query.entries === '1';
  
  const response = {
    stats: cache.getStats(),
    streamingSupport: {
      maxFileSize: Math.round(cache.maxFileSize / 1024 / 1024) + 'MB',
      skipExtensions: Array.from(cache.streamingExtensions),
      videoHandling: 'Videos bypass cache and support range requests'
    }
  };
  
  if (showEntries) {
    response.entries = Array.from(cache.cache.entries()).map(([key, value]) => ({
      url: key.replace('url:', ''),
      contentType: value.contentType || 'unknown',
      size: Math.round(value.size / 1024) + 'KB',
      hits: value.hits,
      age: Math.round((Date.now() - value.timestamp) / 1000) + 's'
    })).sort((a, b) => b.hits - a.hits);
  }
  
  res.json(response);
});

app.delete('/proxies/cache', (req, res) => {
  const { url } = req.query;
  
  if (url) {
    const deleted = cache.invalidate(url);
    res.json({ 
      message: deleted ? `Cache deleted for: ${url}` : `Cache entry not found: ${url}`,
      deleted
    });
  } else {
    cache.clear();
    res.json({ message: 'All cache cleared' });
  }
});

// Health check
app.get('/health', (req, res) => {
  const stats = proxyManager.getStats();
  const cacheStats = cache.getStats();
  
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    },
    proxies: {
      total: stats.totalProxiesCount,
      working: stats.workingProxiesCount,
      dead: stats.deadProxiesCount
    },
    cache: {
      size: cacheStats.size,
      hitRate: cacheStats.hitRate,
      skipRate: cacheStats.skipRate,
      totalSize: Math.round(cacheStats.totalSize / 1024) + 'KB'
    },
    videoStreaming: {
      rangeRequestSupport: 'enabled',
      cacheBypass: 'automatic for videos',
      maxCacheFileSize: Math.round(cache.maxFileSize / 1024 / 1024) + 'MB'
    }
  });
});

// API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Enhanced Proxy Bridge API with Video Streaming Support',
    version: '4.1.0',
    description: 'High-performance proxy bridge with smart caching and full video streaming support',
    
    endpoints: {
      'Main Proxy': {
        'GET /proxies?url=<URL>': 'Proxy any URL with automatic video streaming support',
        'GET /proxies?url=<URL>&nocache=1': 'Bypass cache (automatically done for videos)'
      },
      'Statistics': {
        'GET /proxies/stats': 'Get proxy and cache statistics',
        'GET /health': 'System health check'
      },
      'Cache Management': {
        'GET /proxies/cache': 'View cache statistics and streaming info',
        'GET /proxies/cache?entries=1': 'View cached entries',
        'DELETE /proxies/cache': 'Clear all cache',
        'DELETE /proxies/cache?url=<URL>': 'Delete specific cache entry'
      },
      'Documentation': {
        'GET /': 'This documentation'
      }
    },

    videoStreamingFeatures: [
      '🎬 Automatic range request support for video streaming',
      '📱 Mobile-friendly video playback',
      '⚡ Smart cache bypass for large files and videos',
      '🎯 Proper HTTP 206 Partial Content responses',
      '📺 Support for all video formats (MP4, WebM, MKV, etc.)',
      '🔄 Seamless seeking and buffering',
      '💾 Intelligent caching for small files only',
      '🚫 Automatic detection of streaming content'
    ],

    examples: {
      webpage: '/proxies?url=https://example.com',
      video: '/proxies?url=https://example.com/video.mp4',
      image: '/proxies?url=https://example.com/image.jpg',
      api: '/proxies?url=https://api.example.com/data.json'
    },

    cacheIntelligence: {
      smartDetection: 'Automatically detects video/audio/large files',
      bypassCriteria: [
        'Content-Type contains video/ or audio/',
        'File extension matches streaming formats',
        'File size exceeds ' + Math.round(cache.maxFileSize / 1024 / 1024) + 'MB',
        'Response has Accept-Ranges header',
        'Range requests (HTTP 206 responses)'
      ],
      cachedContent: 'HTML, CSS, JS, small images, JSON, XML',
      streamingFormats: Array.from(cache.streamingExtensions)
    },

    performanceOptimizations: [
      'Range request forwarding for video streaming',
      'Proper HTTP status code handling (200/206)',
      'Content-Length and Content-Range header preservation',
      'Accept-Ranges header for video content',
      'Memory-efficient large file handling',
      'Smart cache size management',
      'Automatic cleanup of expired cache entries'
    ],

    troubleshooting: {
      videoLag: 'Videos now properly support range requests - no more lag!',
      largeFiles: 'Files over ' + Math.round(cache.maxFileSize / 1024 / 1024) + 'MB automatically bypass cache',
      mobilePlayers: 'Full support for mobile video players and seeking',
      streamingServices: 'Compatible with video streaming platforms'
    },

    currentStats: {
      proxies: proxyManager.getStats(),
      cache: cache.getStats(),
      uptime: Math.round(process.uptime()) + 's'
    }
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`🛑 ${signal} received, shutting down gracefully...`);
  
  proxyManager.intervals = {};
  cache.destroy();
  
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced Proxy Bridge API with Video Streaming running on port ${PORT}`);
  console.log(`📖 Documentation: http://localhost:${PORT}/`);
  console.log(`🌐 Standard: http://localhost:${PORT}/proxies?url=https://httpbin.org/ip`);
  console.log(`🎬 Video: http://localhost:${PORT}/proxies?url=https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4`);
  console.log(`📊 Stats: http://localhost:${PORT}/proxies/stats`);
  console.log(`💾 Cache: http://localhost:${PORT}/proxies/cache?entries=1`);
  console.log(`❤️ Health: http://localhost:${PORT}/health`);
  
  // Start background tasks
  proxyManager.startBackgroundTasks();
});

module.exports = { app, proxyManager, cache };
