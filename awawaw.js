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
// PERSISTENT CACHE SYSTEM
// ===============================
class PersistentCache {
  constructor() {
    this.cache = new Map();
    this.maxSize = 2048; // Increased cache size
    this.ttl = 15 * 60 * 1000; // 15 minutes TTL
    this.hitCount = 0;
    this.missCount = 0;
    this.evictedCount = 0;
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000); // Every 5 minutes
  }

  generateKey(url) {
    return `url:${url}`;
  }

  set(url, data, headers) {
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
      timestamp: Date.now(),
      hits: 0,
      size: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data.toString())
    });
    
    console.log(`💾 Cache stored: ${url} (${this.cache.size}/${this.maxSize})`);
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
    const totalRequests = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate: totalRequests > 0 ? (this.hitCount / totalRequests * 100).toFixed(2) + '%' : '0%',
      evictedCount: this.evictedCount,
      ttl: this.ttl,
      totalSize: Array.from(this.cache.values()).reduce((sum, item) => sum + (item.size || 0), 0)
    };
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// ===============================
// COMPREHENSIVE PROXY MANAGER
// ===============================
class ProxyManager {
  constructor() {
    this.workingProxies = new Map(); // Map with metadata
    this.allProxies = new Set();
    this.deadProxies = new Map(); // Track dead proxies with timestamps
    this.testingQueue = new Set(); // Proxies currently being tested
    this.fastProxies = new Set(); // Top performers for instant switching
    
    // Testing state
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
    
    // Background intervals
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
    
    // Remove duplicates and add new ones
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
    
    // Try multiple test URLs for better reliability
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
        // Try next URL
        continue;
      }
    }
    
    return { 
      proxy, 
      responseTime: Date.now() - startTime, 
      success: false 
    };
  }

  // NEW: Race multiple proxies for the fastest response
  async raceProxies(url, raceCount = 5, maxRetries = 3) {
    if (this.workingProxies.size < raceCount) {
      throw new Error(`Not enough proxies to race (need ${raceCount}, have ${this.workingProxies.size})`);
    }

    const topProxies = this.getFastestProxies(raceCount * 2); // Get more for retry options
    const racePromises = [];
    let usedProxies = new Set();

    console.log(`🏎️ Racing ${Math.min(raceCount, topProxies.length)} proxies for: ${url}`);

    for (let i = 0; i < Math.min(raceCount, topProxies.length); i++) {
      const proxy = topProxies[i];
      usedProxies.add(proxy);
      
      racePromises.push(
        this.fetchWithSingleProxy(url, proxy)
          .then(result => ({ ...result, proxy, racePosition: i + 1 }))
          .catch(err => ({ proxy, error: err.message, racePosition: i + 1 }))
      );
    }

    try {
      // Use Promise.any to get the first successful result
      const winner = await Promise.any(racePromises);
      
      if (winner.error) {
        throw new Error(`All race proxies failed. Last error: ${winner.error}`);
      }

      this.stats.racingWins++;
      console.log(`🏆 Proxy race winner: ${winner.proxy} (position ${winner.racePosition}, ${winner.duration}ms)`);
      
      // Update proxy performance metadata
      const proxyMeta = this.workingProxies.get(winner.proxy);
      if (proxyMeta) {
        proxyMeta.raceWins = (proxyMeta.raceWins || 0) + 1;
        proxyMeta.lastWin = new Date();
      }

      return winner;
    } catch (aggregateError) {
      // If all proxies in race failed, try fallback with non-raced proxies
      console.log(`🔄 Proxy race failed, trying fallback proxies...`);
      
      const fallbackProxies = Array.from(this.workingProxies.keys())
        .filter(p => !usedProxies.has(p))
        .slice(0, maxRetries);

      for (const proxy of fallbackProxies) {
        try {
          const result = await this.fetchWithSingleProxy(url, proxy);
          console.log(`🎯 Fallback proxy success: ${proxy} (${result.duration}ms)`);
          return { ...result, proxy, fallback: true };
        } catch (err) {
          this.removeFailedProxy(proxy);
          continue;
        }
      }

      throw new Error(`Proxy racing and fallback failed. Tried ${raceCount + fallbackProxies.length} proxies.`);
    }
  }

  // NEW: Single proxy fetch for racing
  async fetchWithSingleProxy(url, proxy, timeout = 8000) {
    const startTime = Date.now();
    
    try {
      const agent = new HttpsProxyAgent(`http://${proxy}`);
      const response = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: timeout,
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: 'arraybuffer'
      });
      
      const duration = Date.now() - startTime;
      
      if (response.status === 200) {
        return {
          data: response.data,
          headers: response.headers,
          duration: duration,
          fromRace: true
        };
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
      
    } catch (err) {
      const duration = Date.now() - startTime;
      throw new Error(`Proxy ${proxy} failed in ${duration}ms: ${err.message}`);
    }
  }

  // NEW: Get fastest proxies for racing and instant switching
  getFastestProxies(count = 10) {
    return Array.from(this.workingProxies.entries())
      .filter(([proxy, metadata]) => {
        // Only include proxies with good recent performance
        const timeSinceLastTest = Date.now() - metadata.lastTested.getTime();
        return timeSinceLastTest < 30 * 60 * 1000 && // Tested within 30 minutes
               metadata.avgResponseTime < 3000 && // Under 3 second avg
               metadata.successRate > 0.8; // 80%+ success rate
      })
      .map(([proxy, metadata]) => ({
        proxy,
        score: this.calculateRaceScore(metadata)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => item.proxy);
  }

  // NEW: Calculate race-specific scoring
  calculateRaceScore(metadata) {
    const successRate = metadata.successCount / (metadata.successCount + metadata.failCount);
    const speedScore = 5000 / (metadata.avgResponseTime + 200); // Higher score for faster proxies
    const recentBonus = Math.max(0, 1 - ((Date.now() - metadata.lastTested.getTime()) / (10 * 60 * 1000))); // Bonus for recently tested
    const raceBonus = (metadata.raceWins || 0) * 0.1; // Bonus for race wins
    
    return (successRate * 100) + speedScore + (recentBonus * 20) + raceBonus;
  }

  // NEW: Update fast proxy pool
  updateFastProxyPool() {
    const fastProxies = this.getFastestProxies(20);
    this.fastProxies.clear();
    fastProxies.forEach(proxy => this.fastProxies.add(proxy));
    
    console.log(`⚡ Updated fast proxy pool: ${this.fastProxies.size} proxies ready for instant switching`);
  }

  async testAllProxies() {
    if (this.isTesting) {
      console.log("⏳ Full test already in progress...");
      return;
    }

    this.isTesting = true;
    this.stats.testingSessions++;
    
    // Get all untested proxies
    const untestedProxies = Array.from(this.allProxies).filter(proxy => 
      !this.workingProxies.has(proxy) && 
      !this.deadProxies.has(proxy) &&
      !this.testingQueue.has(proxy)
    );
    
    console.log(`🚀 Starting FULL proxy test: ${untestedProxies.length} proxies to test`);
    console.log(`📈 Current stats: ${this.workingProxies.size} working, ${this.deadProxies.size} dead`);
    
    if (untestedProxies.length === 0) {
      console.log("✅ All proxies already tested!");
      this.isTesting = false;
      return;
    }

    this.testingProgress = {
      current: 0,
      total: untestedProxies.length,
      batch: 0,
      startTime: Date.now()
    };

    const batchSize = 100; // Process in batches
    const concurrency = 25; // Higher concurrency for faster testing
    const limit = createLimit(concurrency);
    
    for (let i = 0; i < untestedProxies.length; i += batchSize) {
      const batch = untestedProxies.slice(i, i + batchSize);
      this.testingProgress.batch++;
      
      console.log(`🧪 Testing batch ${this.testingProgress.batch}/${Math.ceil(untestedProxies.length / batchSize)}: ${batch.length} proxies`);
      
      // Mark as testing
      batch.forEach(proxy => this.testingQueue.add(proxy));
      
      const tasks = batch.map(proxy =>
        limit(async () => {
          const result = await this.testProxy(proxy);
          this.testingProgress.current++;
          
          // Remove from testing queue
          this.testingQueue.delete(proxy);
          
          const now = new Date();
          
          if (result.success) {
            // Add to working proxies
            this.workingProxies.set(proxy, {
              successCount: 1,
              failCount: 0,
              totalResponseTime: result.responseTime,
              avgResponseTime: result.responseTime,
              lastTested: now,
              lastResponseTime: result.responseTime,
              testUrl: result.testUrl,
              addedAt: now,
              successRate: 1.0,
              raceWins: 0
            });
            
            console.log(`✅ [${this.testingProgress.current}/${this.testingProgress.total}] Working: ${proxy} (${result.responseTime}ms)`);
          } else {
            // Add to dead proxies
            this.deadProxies.set(proxy, {
              lastTested: now,
              failCount: 1,
              lastError: 'Connection failed'
            });
            
            // Log every 50th dead proxy to reduce noise
            if (this.testingProgress.current % 50 === 0) {
              console.log(`❌ [${this.testingProgress.current}/${this.testingProgress.total}] Dead: ${proxy} (batch progress)`);
            }
          }
          
          return result;
        })
      );

      // Process batch
      await Promise.allSettled(tasks);
      
      // Update stats
      this.stats.totalTested = this.testingProgress.current;
      this.stats.totalWorking = this.workingProxies.size;
      this.stats.totalDead = this.deadProxies.size;
      
      const elapsed = Date.now() - this.testingProgress.startTime;
      const rate = this.testingProgress.current / (elapsed / 1000);
      const remaining = (this.testingProgress.total - this.testingProgress.current) / rate;
      
      console.log(`📊 Batch ${this.testingProgress.batch} complete: ${this.workingProxies.size} working, ${this.deadProxies.size} dead`);
      console.log(`⏱️ Progress: ${this.testingProgress.current}/${this.testingProgress.total} (${rate.toFixed(1)}/sec, ~${Math.round(remaining)}s remaining)`);
      
      // Small delay between batches to prevent overwhelming
      if (i + batchSize < untestedProxies.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    this.stats.lastFullScan = new Date();
    this.stats.totalTestTime += Date.now() - this.testingProgress.startTime;
    this.stats.avgTestTime = this.stats.totalTestTime / this.stats.testingSessions;
    
    // Update fast proxy pool after testing
    this.updateFastProxyPool();
    
    console.log(`🎉 FULL TEST COMPLETE!`);
    console.log(`📊 Final results: ${this.workingProxies.size} working, ${this.deadProxies.size} dead out of ${this.allProxies.size} total`);
    console.log(`⏱️ Test duration: ${((Date.now() - this.testingProgress.startTime) / 1000 / 60).toFixed(1)} minutes`);
    
    this.isTesting = false;
  }

  async retestWorkingProxies() {
    if (this.workingProxies.size === 0 || this.isTesting) return;
    
    console.log(`🔍 Re-testing ${this.workingProxies.size} working proxies...`);
    
    const limit = createLimit(15);
    const proxiesToTest = Array.from(this.workingProxies.keys());
    const tasks = proxiesToTest.map(proxy => 
      limit(async () => {
        const result = await this.testProxy(proxy);
        const existing = this.workingProxies.get(proxy);
        const now = new Date();
        
        if (result.success) {
          // Update metadata
          const newSuccessCount = existing.successCount + 1;
          const newTotalTime = existing.totalResponseTime + result.responseTime;
          
          this.workingProxies.set(proxy, {
            ...existing,
            successCount: newSuccessCount,
            totalResponseTime: newTotalTime,
            avgResponseTime: newTotalTime / newSuccessCount,
            lastTested: now,
            lastResponseTime: result.responseTime,
            successRate: newSuccessCount / (newSuccessCount + existing.failCount)
          });
          return { proxy, status: 'working' };
        } else {
          // Increment fail count
          const newFailCount = existing.failCount + 1;
          
          if (newFailCount >= 2) { // Remove after 2 consecutive failures
            this.workingProxies.delete(proxy);
            this.deadProxies.set(proxy, {
              lastTested: now,
              failCount: newFailCount,
              lastError: 'Failed retest'
            });
            return { proxy, status: 'removed' };
          } else {
            // Keep but increment fail count
            this.workingProxies.set(proxy, {
              ...existing,
              failCount: newFailCount,
              lastTested: now,
              successRate: existing.successCount / (existing.successCount + newFailCount)
            });
            return { proxy, status: 'warning' };
          }
        }
      })
    );
    
    const results = await Promise.allSettled(tasks);
    const summary = { working: 0, removed: 0, warning: 0 };
    
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        summary[result.value.status]++;
      }
    });

    this.stats.totalWorking = this.workingProxies.size;
    this.stats.totalDead = this.deadProxies.size;
    
    // Update fast proxy pool after retesting
    this.updateFastProxyPool();
    
    console.log(`🔍 Retest complete: ${summary.working} still working, ${summary.removed} removed, ${summary.warning} with warnings`);
  }

  startBackgroundTasks() {
    console.log("🚀 Starting comprehensive proxy manager...");
    
    // Initial setup
    this.fetchProxies().then(() => {
      // Start full testing immediately
      setTimeout(() => this.testAllProxies(), 5000);
    });

    // Fetch new proxies every 30 minutes
    this.intervals.fetch = setInterval(async () => {
      await this.fetchProxies();
      // Test new proxies if not already testing
      if (!this.isTesting) {
        setTimeout(() => this.testAllProxies(), 10000);
      }
    }, 30 * 60 * 1000);

    // Full scan every 2 hours
    this.intervals.fullScan = setInterval(async () => {
      if (!this.isTesting) {
        await this.testAllProxies();
      }
    }, 2 * 60 * 60 * 1000);

    // Retest working proxies every 1 hour
    this.intervals.retest = setInterval(async () => {
      if (!this.isTesting) {
        await this.retestWorkingProxies();
      }
    }, 60 * 60 * 1000);

    // Update fast proxy pool every 10 minutes
    this.intervals.fastUpdate = setInterval(() => {
      this.updateFastProxyPool();
    }, 10 * 60 * 1000);

    // Cleanup old dead proxies every 4 hours
    this.intervals.cleanup = setInterval(async () => {
      const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
      let cleanedCount = 0;
      
      for (const [proxy, metadata] of this.deadProxies.entries()) {
        if (metadata.lastTested.getTime() < fourHoursAgo) {
          this.deadProxies.delete(proxy);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} old dead proxies`);
        this.stats.totalDead = this.deadProxies.size;
      }
    }, 4 * 60 * 60 * 1000);
  }

  stopBackgroundTasks() {
    console.log("🛑 Stopping background proxy manager...");
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });
  }

  getBestWorkingProxy() {
    if (this.workingProxies.size === 0) return null;
    
    // Sort by performance score
    const sortedProxies = Array.from(this.workingProxies.entries())
      .map(([proxy, metadata]) => ({
        proxy,
        metadata,
        score: this.calculateProxyScore(metadata)
      }))
      .sort((a, b) => b.score - a.score);
    
    // Return best proxy with some randomness (top 10%)
    const topCount = Math.max(1, Math.ceil(sortedProxies.length * 0.1));
    const randomIndex = Math.floor(Math.random() * topCount);
    return sortedProxies[randomIndex].proxy;
  }

  // NEW: Get instant switch proxy (from fast pool)
  getInstantSwitchProxy() {
    if (this.fastProxies.size === 0) {
      return this.getBestWorkingProxy();
    }
    
    const fastArray = Array.from(this.fastProxies);
    const randomIndex = Math.floor(Math.random() * fastArray.length);
    this.stats.instantSwitches++;
    
    console.log(`⚡ Instant switch to fast proxy: ${fastArray[randomIndex]}`);
    return fastArray[randomIndex];
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
      this.fastProxies.delete(proxy); // Also remove from fast pool
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

  getStats() {
    return {
      ...this.stats,
      isFetching: this.isFetching,
      isTesting: this.isTesting,
      testingProgress: this.testingProgress,
      queueSize: this.testingQueue.size,
      uptime: process.uptime(),
      workingProxiesCount: this.workingProxies.size,
      deadProxiesCount: this.deadProxies.size,
      totalProxiesCount: this.allProxies.size,
      fastProxiesCount: this.fastProxies.size,
      testingRate: this.stats.totalTested > 0 ? (this.stats.totalTested / (this.stats.totalTestTime / 1000)).toFixed(2) : 0
    };
  }

  getDetailedStats() {
    const workingList = Array.from(this.workingProxies.entries()).map(([proxy, metadata]) => ({
      proxy,
      ...metadata,
      score: this.calculateProxyScore(metadata),
      inFastPool: this.fastProxies.has(proxy)
    })).sort((a, b) => b.score - a.score);

    return {
      stats: this.getStats(),
      workingProxies: workingList.slice(0, 50), // Top 50
      fastProxies: Array.from(this.fastProxies).map(proxy => {
        const metadata = this.workingProxies.get(proxy);
        return {
          proxy,
          avgResponseTime: metadata?.avgResponseTime || 0,
          successRate: metadata?.successRate || 0,
          raceScore: metadata ? this.calculateRaceScore(metadata) : 0
        };
      }).sort((a, b) => b.raceScore - a.raceScore),
      recentlyDead: Array.from(this.deadProxies.entries())
        .sort(([,a], [,b]) => b.lastTested.getTime() - a.lastTested.getTime())
        .slice(0, 20)
        .map(([proxy, metadata]) => ({ proxy, ...metadata }))
    };
  }
}

// ===============================
// HELPER FUNCTIONS
// ===============================
async function fetchWithProxy(url, maxRetries = 8, useCache = true, cache, useRacing = false) {
  // Check cache first
  if (useCache) {
    const cached = cache.get(url);
    if (cached) {
      console.log(`⚡ Cache hit: ${url}`);
      return {
        data: cached.data,
        headers: cached.headers,
        fromCache: true,
        cacheHits: cached.hits
      };
    }
  }

  if (proxyManager.workingProxies.size === 0) {
    throw new Error(`No working proxies available (${proxyManager.allProxies.size} total, ${proxyManager.deadProxies.size} dead, testing: ${proxyManager.isTesting})`);
  }

  const startTime = Date.now();

  // NEW: Try proxy racing first if enabled and we have enough fast proxies
  if (useRacing && proxyManager.fastProxies.size >= 3) {
    try {
      console.log(`🏎️ Attempting proxy racing for: ${url}`);
      const raceResult = await proxyManager.raceProxies(url, Math.min(5, proxyManager.fastProxies.size));
      
      // Cache successful race result
      if (useCache) {
        cache.set(url, raceResult.data, raceResult.headers);
      }
      
      return {
        data: raceResult.data,
        headers: raceResult.headers,
        proxy: raceResult.proxy,
        duration: raceResult.duration,
        attempts: 1,
        fromCache: false,
        method: raceResult.fallback ? 'race-fallback' : 'race-winner',
        racePosition: raceResult.racePosition || null
      };
    } catch (raceError) {
      console.log(`🏎️ Proxy racing failed: ${raceError.message}`);
      // Fall through to traditional method
    }
  }

  // Traditional proxy switching with instant switch capability
  let usedProxies = new Set();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let proxy;
    
    // NEW: Use instant switch for first few attempts if fast proxies available
    if (attempt <= 3 && proxyManager.fastProxies.size > 0) {
      proxy = proxyManager.getInstantSwitchProxy();
    } else {
      proxy = proxyManager.getBestWorkingProxy();
    }
    
    if (!proxy || usedProxies.has(proxy)) {
      // Reset used proxies if we've tried all available
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
      const response = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: attempt <= 3 ? 3500 : 8000, // Faster timeout for instant switch attempts
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: 'arraybuffer'
      });
      
      const duration = Date.now() - startTime;
      
      if (response.status === 200) {
        const method = attempt <= 3 && proxyManager.fastProxies.has(proxy) ? 'instant-switch' : 'traditional';
        console.log(`✅ Success with proxy: ${proxy} (${duration}ms, attempt ${attempt}, method: ${method})`);
        
        // Cache successful response
        if (useCache) {
          cache.set(url, response.data, response.headers);
        }
        
        return {
          data: response.data,
          headers: response.headers,
          proxy: proxy,
          duration: duration,
          attempts: attempt,
          fromCache: false,
          method: method
        };
      } else {
        console.log(`⚠️ Non-200 response from ${proxy}: ${response.status}`);
        // Don't remove proxy for non-200 responses, might be site-specific
        continue;
      }
      
    } catch (err) {
      console.log(`❌ Failed with proxy: ${proxy} (attempt ${attempt}/${maxRetries}) - ${err.message}`);
      proxyManager.removeFailedProxy(proxy);
      
      // Don't cache failures
      if (useCache) {
        cache.invalidate(url);
      }
      
      if (attempt === maxRetries) {
        const duration = Date.now() - startTime;
        throw new Error(`All ${maxRetries} attempts failed after ${duration}ms. Working proxies: ${proxyManager.workingProxies.size}`);
      }
    }
  }
}

// Initialize managers
const proxyManager = new ProxyManager();
const cache = new PersistentCache();

// ===============================
// EXPRESS MIDDLEWARE & ROUTES
// ===============================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Main proxy endpoint with racing and instant switch
app.get('/proxy', async (req, res) => {
  const { url, nocache, race, fastswitch } = req.query;
  
  if (!url) {
    return res.status(400).json({ 
      error: 'URL parameter is required',
      example: '/proxies?url=https://example.com',
      newFeatures: {
        racing: 'Add &race=1 to enable proxy racing for faster responses',
        fastSwitch: 'Add &fastswitch=1 to use instant proxy switching',
        combined: 'Use &race=1&fastswitch=1 for maximum speed'
      }
    });
  }

  try {
    new URL(url);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  const startTime = Date.now();
  const useCache = nocache !== '1' && nocache !== 'true';
  const useRacing = race === '1' || race === 'true';
  const useFastSwitch = fastswitch === '1' || fastswitch === 'true';

  try {
    const features = [];
    if (useRacing) features.push('racing');
    if (useFastSwitch) features.push('fast-switch');
    if (!useCache) features.push('no-cache');
    
    console.log(`🌐 Fetching: ${url} ${features.length ? `(${features.join(', ')})` : '(standard)'}`);
    
    // Use racing if explicitly requested, or fast switch mode
    const shouldRace = useRacing || useFastSwitch;
    const result = await fetchWithProxy(url, 8, useCache, cache, shouldRace);
    
    if (result.headers['content-type']) {
      res.set('Content-Type', result.headers['content-type']);
    }
    
    // Performance headers
    res.set('X-Proxy-Used', result.proxy || 'cache');
    res.set('X-Response-Time', `${result.duration || Date.now() - startTime}ms`);
    res.set('X-Attempts', result.attempts || 0);
    res.set('X-Cache-Status', result.fromCache ? 'HIT' : 'MISS');
    res.set('X-Available-Proxies', proxyManager.workingProxies.size);
    res.set('X-Fast-Proxies', proxyManager.fastProxies.size);
    res.set('X-Cache-Hits', result.cacheHits || 0);
    res.set('X-Method', result.method || 'standard');
    
    if (result.racePosition) {
      res.set('X-Race-Position', result.racePosition);
    }
    
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
      fastProxies: proxyManager.fastProxies.size,
      totalProxies: proxyManager.allProxies.size,
      testingInProgress: proxyManager.isTesting,
      suggestion: proxyManager.workingProxies.size === 0 ? 
        'No working proxies available. Please wait for background proxy testing to complete.' :
        'Try again with racing enabled (?race=1) for potentially faster response.',
      speedTips: {
        racing: 'Use ?race=1 to race multiple proxies simultaneously',
        fastSwitch: 'Use ?fastswitch=1 for instant proxy switching',
        combined: 'Use ?race=1&fastswitch=1 for maximum performance'
      }
    });
  }
});

// Get comprehensive proxy statistics
app.get('/proxies/stats', (req, res) => {
  const detailed = req.query.detailed === '1' || req.query.detailed === 'true';
  
  if (detailed) {
    res.json(proxyManager.getDetailedStats());
  } else {
    res.json({
      stats: proxyManager.getStats(),
      cache: cache.getStats()
    });
  }
});

// NEW: Get fast proxy pool status
app.get('/proxies/fast', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  
  const fastList = Array.from(proxyManager.fastProxies).map(proxy => {
    const metadata = proxyManager.workingProxies.get(proxy);
    return {
      proxy,
      avgResponseTime: Math.round(metadata?.avgResponseTime || 0),
      successRate: ((metadata?.successRate || 0) * 100).toFixed(1) + '%',
      raceWins: metadata?.raceWins || 0,
      raceScore: metadata ? proxyManager.calculateRaceScore(metadata).toFixed(2) : 0,
      lastTested: metadata?.lastTested
    };
  }).sort((a, b) => b.raceScore - a.raceScore).slice(0, limit);

  res.json({
    total: proxyManager.fastProxies.size,
    showing: fastList.length,
    lastUpdated: new Date().toISOString(),
    proxies: fastList,
    performance: {
      racingWins: proxyManager.stats.racingWins,
      instantSwitches: proxyManager.stats.instantSwitches,
      avgPoolSize: proxyManager.fastProxies.size
    }
  });
});

// NEW: Force update fast proxy pool
app.post('/proxies/fast/update', (req, res) => {
  try {
    const beforeSize = proxyManager.fastProxies.size;
    proxyManager.updateFastProxyPool();
    const afterSize = proxyManager.fastProxies.size;
    
    res.json({
      message: 'Fast proxy pool updated',
      before: beforeSize,
      after: afterSize,
      change: afterSize - beforeSize,
      fastProxies: Array.from(proxyManager.fastProxies).slice(0, 10)
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to update fast proxy pool',
      details: err.message
    });
  }
});

// NEW: Race test endpoint
app.post('/proxies/race-test', async (req, res) => {
  const { url, count } = req.body;
  
  if (!url) {
    return res.status(400).json({ 
      error: 'URL is required in request body',
      example: { url: 'https://httpbin.org/ip', count: 5 }
    });
  }

  const raceCount = Math.min(parseInt(count) || 5, 10); // Max 10 for safety

  try {
    console.log(`🏁 Manual race test requested: ${url} with ${raceCount} proxies`);
    const startTime = Date.now();
    
    const result = await proxyManager.raceProxies(url, raceCount);
    const totalDuration = Date.now() - startTime;
    
    res.json({
      success: true,
      winner: {
        proxy: result.proxy,
        responseTime: result.duration,
        racePosition: result.racePosition,
        fallback: result.fallback || false
      },
      raceStats: {
        participantCount: raceCount,
        totalRaceDuration: totalDuration,
        fastProxiesAvailable: proxyManager.fastProxies.size
      },
      dataPreview: {
        size: Buffer.isBuffer(result.data) ? result.data.length : result.data.toString().length,
        type: result.headers['content-type'] || 'unknown'
      }
    });
    
  } catch (err) {
    res.status(500).json({
      error: 'Race test failed',
      details: err.message,
      availableProxies: proxyManager.workingProxies.size,
      fastProxies: proxyManager.fastProxies.size
    });
  }
});

// Get working proxy list with performance metrics (enhanced)
app.get('/proxies/working', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const sortBy = req.query.sort || 'score'; // score, responseTime, successRate, raceScore
  
  const workingList = Array.from(proxyManager.workingProxies.entries())
    .map(([proxy, metadata]) => ({
      proxy,
      avgResponseTime: Math.round(metadata.avgResponseTime),
      successRate: ((metadata.successCount / (metadata.successCount + metadata.failCount)) * 100).toFixed(1) + '%',
      successCount: metadata.successCount,
      failCount: metadata.failCount,
      lastTested: metadata.lastTested,
      score: proxyManager.calculateProxyScore(metadata).toFixed(2),
      raceScore: proxyManager.calculateRaceScore(metadata).toFixed(2),
      raceWins: metadata.raceWins || 0,
      inFastPool: proxyManager.fastProxies.has(proxy)
    }));

  // Sort based on parameter
  if (sortBy === 'responseTime') {
    workingList.sort((a, b) => a.avgResponseTime - b.avgResponseTime);
  } else if (sortBy === 'successRate') {
    workingList.sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate));
  } else if (sortBy === 'raceScore') {
    workingList.sort((a, b) => b.raceScore - a.raceScore);
  } else {
    workingList.sort((a, b) => b.score - a.score);
  }

  res.json({
    total: workingList.length,
    showing: Math.min(limit, workingList.length),
    sortedBy: sortBy,
    fastPoolSize: proxyManager.fastProxies.size,
    proxies: workingList.slice(0, limit)
  });
});

// Get dead proxy list
app.get('/proxies/dead', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  
  const deadList = Array.from(proxyManager.deadProxies.entries())
    .map(([proxy, metadata]) => ({
      proxy,
      lastTested: metadata.lastTested,
      failCount: metadata.failCount,
      lastError: metadata.lastError
    }))
    .sort((a, b) => b.lastTested.getTime() - a.lastTested.getTime())
    .slice(0, limit);

  res.json({
    total: proxyManager.deadProxies.size,
    showing: deadList.length,
    proxies: deadList
  });
});

// Force full proxy test
app.post('/proxies/test-all', async (req, res) => {
  if (proxyManager.isTesting) {
    return res.json({
      message: 'Full proxy testing already in progress',
      progress: proxyManager.testingProgress,
      stats: proxyManager.getStats()
    });
  }

  // Start testing in background
  proxyManager.testAllProxies().catch(err => {
    console.error('Error in full proxy test:', err);
  });

  res.json({
    message: 'Full proxy testing initiated',
    totalProxies: proxyManager.allProxies.size,
    stats: proxyManager.getStats()
  });
});

// Get testing progress
app.get('/proxies/progress', (req, res) => {
  const progress = proxyManager.testingProgress;
  const stats = proxyManager.getStats();
  
  let eta = null;
  if (progress.current > 0 && progress.total > progress.current) {
    const elapsed = Date.now() - (progress.startTime || Date.now());
    const rate = progress.current / (elapsed / 1000);
    eta = Math.round((progress.total - progress.current) / rate);
  }

  res.json({
    isTesting: proxyManager.isTesting,
    isFetching: proxyManager.isFetching,
    progress: {
      ...progress,
      percentage: progress.total > 0 ? ((progress.current / progress.total) * 100).toFixed(1) : 0,
      eta: eta ? `${Math.floor(eta / 60)}m ${eta % 60}s` : null
    },
    stats
  });
});

// Force refresh proxy sources
app.post('/proxies/refresh', async (req, res) => {
  try {
    console.log("🔄 Manual refresh requested");
    await proxyManager.fetchProxies();
    
    res.json({
      message: 'Proxy source refresh completed',
      stats: proxyManager.getStats(),
      willStartTesting: !proxyManager.isTesting
    });
    
    // Start testing new proxies if not already testing
    if (!proxyManager.isTesting) {
      setTimeout(() => {
        proxyManager.testAllProxies().catch(err => {
          console.error('Error in post-refresh testing:', err);
        });
      }, 5000);
    }
  } catch (err) {
    res.status(500).json({ 
      error: 'Failed to refresh proxy sources',
      details: err.message
    });
  }
});

// Cache management endpoints
app.get('/proxies/cache', (req, res) => {
  const showEntries = req.query.entries === '1' || req.query.entries === 'true';
  
  const response = {
    stats: cache.getStats()
  };
  
  if (showEntries) {
    response.entries = Array.from(cache.cache.entries()).map(([key, value]) => ({
      url: key.replace('url:', ''),
      timestamp: new Date(value.timestamp).toISOString(),
      age: Math.round((Date.now() - value.timestamp) / 1000),
      hits: value.hits,
      size: value.size
    })).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
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

// Test specific proxy
app.post('/proxies/test/:proxy', async (req, res) => {
  const proxy = req.params.proxy;
  
  if (!proxy.includes(':')) {
    return res.status(400).json({ error: 'Invalid proxy format. Use IP:PORT' });
  }

  try {
    console.log(`🧪 Testing specific proxy: ${proxy}`);
    const result = await proxyManager.testProxy(proxy);
    
    if (result.success) {
      res.json({
        proxy,
        status: 'working',
        responseTime: result.responseTime,
        testUrl: result.testUrl,
        message: 'Proxy is working',
        qualifiesForFastPool: result.responseTime < 3000
      });
    } else {
      res.json({
        proxy,
        status: 'dead',
        responseTime: result.responseTime,
        message: 'Proxy failed to connect'
      });
    }
  } catch (err) {
    res.status(500).json({
      error: 'Failed to test proxy',
      proxy,
      details: err.message
    });
  }
});

// Health check with comprehensive status
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
      dead: stats.deadProxiesCount,
      fast: stats.fastProxiesCount,
      testing: stats.isTesting,
      fetching: stats.isFetching
    },
    cache: {
      size: cacheStats.size,
      hitRate: cacheStats.hitRate,
      totalSize: Math.round(cacheStats.totalSize / 1024) + 'KB'
    },
    performance: {
      racingWins: stats.racingWins,
      instantSwitches: stats.instantSwitches,
      testingRate: stats.testingRate + '/sec'
    },
    backgroundTasks: {
      active: Object.keys(proxyManager.intervals).length,
      testing: stats.isTesting,
      fetching: stats.isFetching
    }
  });
});

// API documentation
app.get('/', (req, res) => {
  res.json({
    name: 'Advanced Proxy Bridge API with Racing & Instant Switch',
    version: '4.0.0',
    description: 'Ultra high-performance proxy bridge with proxy racing, instant switching, smart caching, and real-time monitoring',
    
    endpoints: {
      'Main Proxy (Enhanced)': {
        'GET /proxies?url=<URL>': 'Standard proxy fetch',
        'GET /proxies?url=<URL>&race=1': 'Enable proxy racing for fastest response',
        'GET /proxies?url=<URL>&fastswitch=1': 'Use instant proxy switching',
        'GET /proxies?url=<URL>&race=1&fastswitch=1': 'Maximum performance mode',
        'GET /proxies?url=<URL>&nocache=1': 'Bypass cache'
      },
      'Proxy Management': {
        'GET /proxies/stats': 'Get basic proxy statistics',
        'GET /proxies/stats?detailed=1': 'Get detailed proxy statistics',
        'GET /proxies/working': 'List working proxies with performance metrics',
        'GET /proxies/working?sort=raceScore': 'Sort by racing performance',
        'GET /proxies/dead': 'List recently dead proxies',
        'POST /proxies/refresh': 'Refresh proxy sources and start testing',
        'POST /proxies/test-all': 'Force full proxy testing',
        'GET /proxies/progress': 'Get testing progress and ETA',
        'POST /proxies/test/:proxy': 'Test specific proxy (IP:PORT format)'
      },
      'Racing & Fast Pool (NEW)': {
        'GET /proxies/fast': 'View fast proxy pool status',
        'POST /proxies/fast/update': 'Force update fast proxy pool',
        'POST /proxies/race-test': 'Manual race test with custom URL'
      },
      'Cache Management': {
        'GET /proxies/cache': 'View cache statistics',
        'GET /proxies/cache?entries=1': 'View cache entries',
        'DELETE /proxies/cache': 'Clear all cache',
        'DELETE /proxies/cache?url=<URL>': 'Delete specific cache entry'
      },
      'System': {
        'GET /health': 'System health and racing performance metrics',
        'GET /': 'This documentation'
      }
    },

    examples: {
      basic: '/proxies?url=https://httpbin.org/ip',
      racing: '/proxies?url=https://httpbin.org/ip&race=1',
      fastSwitch: '/proxies?url=https://httpbin.org/ip&fastswitch=1',
      maxPerformance: '/proxies?url=https://httpbin.org/ip&race=1&fastswitch=1',
      raceTest: 'POST /proxies/race-test {"url":"https://httpbin.org/ip","count":5}',
      fastPool: '/proxies/fast?limit=10'
    },

    newFeatures: [
      '🏎️ Proxy Racing: Simultaneously test multiple proxies and use the fastest response',
      '⚡ Instant Switch: Ultra-fast proxy switching using pre-validated fast proxy pool',
      '🎯 Smart Pool Management: Automatically maintain pool of fastest performing proxies',
      '📊 Enhanced Performance Tracking: Race wins, instant switches, and advanced scoring',
      '🚀 Maximum Speed Mode: Combine racing and instant switching for ultimate performance',
      '🧪 Race Testing: Manual race testing endpoints for performance analysis'
    ],

    features: [
      'Proxy racing with configurable concurrency',
      'Instant proxy switching from fast pool',
      'Advanced performance scoring and pool management',
      'Comprehensive proxy testing (tests ALL proxies continuously)',
      'Smart proxy performance scoring and selection',
      'Advanced persistent caching with hit rate tracking',
      'Real-time testing progress monitoring',
      'Automatic dead proxy cleanup and retry logic',
      'Performance metrics and detailed statistics',
      'Background proxy source refreshing',
      'High-concurrency proxy testing',
      'Intelligent proxy failure handling'
    ],

    performance: {
      'Proxy Racing': {
        concurrency: '5 proxies race simultaneously',
        timeout: '8 seconds per race participant',
        fallback: 'Automatic fallback to non-raced proxies',
        poolSize: proxyManager.fastProxies.size + ' fast proxies ready'
      },
      'Instant Switching': {
        fastPool: proxyManager.fastProxies.size + ' pre-validated fast proxies',
        updateInterval: '10 minutes',
        criteria: '<3s response time, >80% success rate',
        switches: proxyManager.stats.instantSwitches + ' completed'
      },
      'Proxy Testing': {
        concurrency: '25 simultaneous tests',
        batchSize: '100 proxies per batch',
        timeout: '10 seconds per test',
        retryLogic: '2 failures before marking dead'
      },
      'Caching': {
        maxSize: '1000 entries',
        ttl: '15 minutes',
        cleanup: 'Every 5 minutes',
        hitRateTracking: 'Real-time'
      },
      'Request Processing': {
        maxRetries: 8,
        timeout: '8-12 seconds (adaptive)',
        proxySelection: 'Performance-based + racing'
      }
    },

    currentStats: {
      proxies: proxyManager.getStats(),
      cache: cache.getStats(),
      uptime: Math.round(process.uptime()) + 's',
      racingPerformance: {
        wins: proxyManager.stats.racingWins,
        instantSwitches: proxyManager.stats.instantSwitches,
        fastPoolSize: proxyManager.fastProxies.size
      }
    },

    speedOptimizationTips: {
      maxSpeed: 'Use ?race=1&fastswitch=1 for absolute fastest response',
      racing: 'Enable ?race=1 when you need the fastest possible response time',
      fastSwitch: 'Use ?fastswitch=1 for quick responses with pre-validated proxies',
      caching: 'Repeated requests automatically use cache for instant responses',
      monitoring: 'Check /proxies/fast to see current fast proxy pool status'
    }
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`🛑 ${signal} received, shutting down gracefully...`);
  
  // Stop background tasks
  proxyManager.stopBackgroundTasks();
  
  // Clean up cache
  cache.destroy();
  
  // Close server
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Advanced Proxy Bridge API with Racing & Instant Switch running on port ${PORT}`);
  console.log(`📖 Documentation: http://localhost:${PORT}/`);
  console.log(`🔗 Standard: http://localhost:${PORT}/proxies?url=https://httpbin.org/ip`);
  console.log(`🏎️ Racing: http://localhost:${PORT}/proxies?url=https://httpbin.org/ip&race=1`);
  console.log(`⚡ Fast Switch: http://localhost:${PORT}/proxies?url=https://httpbin.org/ip&fastswitch=1`);
  console.log(`🚀 Max Speed: http://localhost:${PORT}/proxies?url=https://httpbin.org/ip&race=1&fastswitch=1`);
  console.log(`📊 Stats: http://localhost:${PORT}/proxies/stats?detailed=1`);
  console.log(`⚡ Fast Pool: http://localhost:${PORT}/proxies/fast`);
  console.log(`⚡ Cache: http://localhost:${PORT}/proxies/cache?entries=1`);
  
  // Start background tasks
  proxyManager.startBackgroundTasks();
});

module.exports = { app, proxyManager, cache };
