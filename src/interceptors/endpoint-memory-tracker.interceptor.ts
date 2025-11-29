import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, finalize } from 'rxjs/operators';

interface EndpointStats {
  activeRequests: number;
  totalRequests: number;
  totalMemoryDelta: number; // Total memory change across all requests
  averageMemoryDelta: number; // Average per request
  maxMemoryDelta: number; // Highest single request
  totalDuration: number;
  averageDuration: number;
  lastAccessed: Date;
}

interface RequestTracking {
  startMemory: NodeJS.MemoryUsage;
  startTime: number;
  endpoint: string;
  method: string;
}

@Injectable()
export class EndpointMemoryTrackerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(EndpointMemoryTrackerInterceptor.name);
  private readonly stats = new Map<string, EndpointStats>();
  private readonly activeRequests = new Map<string, RequestTracking>();
  private readonly MB = 1024 * 1024;
  
  // Configuration
  private readonly LOG_INTERVAL_MS = 5000; // Log stats every 5 seconds
  private readonly HIGH_MEMORY_THRESHOLD_MB = 50; // Alert if single request uses >50MB
  private readonly HIGH_CONCURRENT_THRESHOLD = 10; // Alert if >10 concurrent requests
  
  private logTimer: NodeJS.Timeout | null = null;
  
  constructor() {
    this.startPeriodicLogging();
  }
  
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const requestId = this.generateRequestId();
    
    // Create endpoint identifier (method + path)
    const endpoint = this.getEndpointKey(request);
    
    // Track request start
    const tracking: RequestTracking = {
      startMemory: process.memoryUsage(),
      startTime: Date.now(),
      endpoint,
      method: request.method,
    };
    
    this.activeRequests.set(requestId, tracking);
    
    // Initialize stats for this endpoint if needed
    if (!this.stats.has(endpoint)) {
      this.stats.set(endpoint, {
        activeRequests: 0,
        totalRequests: 0,
        totalMemoryDelta: 0,
        averageMemoryDelta: 0,
        maxMemoryDelta: 0,
        totalDuration: 0,
        averageDuration: 0,
        lastAccessed: new Date(),
      });
    }
    
    const stats = this.stats.get(endpoint)!;
    stats.activeRequests++;
    stats.totalRequests++;
    stats.lastAccessed = new Date();
    
    return next.handle().pipe(
      finalize(() => {
        this.finalizeRequest(requestId, tracking);
      })
    );
  }
  
  private finalizeRequest(requestId: string, tracking: RequestTracking): void {
    const endMemory = process.memoryUsage();
    const endTime = Date.now();
    
    // Calculate deltas
    const memoryDelta = endMemory.heapUsed - tracking.startMemory.heapUsed;
    const duration = endTime - tracking.startTime;
    
    // Update stats
    const stats = this.stats.get(tracking.endpoint);
    if (stats) {
      stats.activeRequests--;
      stats.totalMemoryDelta += memoryDelta;
      stats.averageMemoryDelta = stats.totalMemoryDelta / stats.totalRequests;
      stats.maxMemoryDelta = Math.max(stats.maxMemoryDelta, memoryDelta);
      stats.totalDuration += duration;
      stats.averageDuration = stats.totalDuration / stats.totalRequests;
      
      // Log if this single request used a lot of memory
      const memoryDeltaMB = memoryDelta / this.MB;
      if (Math.abs(memoryDeltaMB) > this.HIGH_MEMORY_THRESHOLD_MB) {
        this.logger.warn({
          message: '🚨 High Memory Request Detected',
          endpoint: tracking.endpoint,
          method: tracking.method,
          memoryDelta: this.formatBytes(memoryDelta),
          duration: `${duration}ms`,
          currentActive: stats.activeRequests,
        });
      }
    }
    
    // Clean up
    this.activeRequests.delete(requestId);
  }
  
  private startPeriodicLogging(): void {
    this.logTimer = setInterval(() => {
      this.logEndpointStats();
    }, this.LOG_INTERVAL_MS);
  }
  
  private logEndpointStats(): void {
    if (this.stats.size === 0) {
      return; // No requests yet
    }
    
    // Get current overall memory
    const currentMemory = process.memoryUsage();
    
    // Sort endpoints by active requests (highest first)
    const sortedEndpoints = Array.from(this.stats.entries())
      .sort((a, b) => b[1].activeRequests - a[1].activeRequests)
      .filter(([_, stats]) => stats.activeRequests > 0 || stats.totalRequests > 0);
    
    // Find problematic endpoints
    const hotEndpoints = sortedEndpoints.filter(
      ([_, stats]) => stats.activeRequests >= this.HIGH_CONCURRENT_THRESHOLD
    );
    
    const isAlerting = hotEndpoints.length > 0;
    const emoji = isAlerting ? '🔥' : '📊';
    
    // Main stats log
    this.logger[isAlerting ? 'warn' : 'log']({
      message: `${emoji} Endpoint Memory Stats ${isAlerting ? '(HIGH ACTIVITY!)' : ''}`,
      total_active_requests: Array.from(this.stats.values()).reduce(
        (sum, s) => sum + s.activeRequests,
        0
      ),
      current_memory: {
        heapUsed: this.formatBytes(currentMemory.heapUsed),
        heapTotal: this.formatBytes(currentMemory.heapTotal),
        external: this.formatBytes(currentMemory.external),
        rss: this.formatBytes(currentMemory.rss),
      },
      top_endpoints: sortedEndpoints.slice(0, 10).map(([endpoint, stats]) => ({
        endpoint,
        active_requests: stats.activeRequests,
        total_requests: stats.totalRequests,
        avg_memory_per_request: this.formatBytes(stats.averageMemoryDelta),
        max_memory_per_request: this.formatBytes(stats.maxMemoryDelta),
        avg_duration: `${Math.round(stats.averageDuration)}ms`,
        total_memory_impact: this.formatBytes(stats.totalMemoryDelta),
        last_accessed: stats.lastAccessed.toISOString(),
      })),
    });
    
    // Detailed alert for hot endpoints
    if (isAlerting) {
      this.logger.warn({
        message: '🚨 High Concurrency Endpoints',
        endpoints: hotEndpoints.map(([endpoint, stats]) => ({
          endpoint,
          active_requests: stats.activeRequests,
          estimated_memory_usage: this.formatBytes(
            stats.activeRequests * stats.averageMemoryDelta
          ),
          avg_memory_per_request: this.formatBytes(stats.averageMemoryDelta),
          recommendation: this.getRecommendation(endpoint, stats),
        })),
      });
    }
  }
  
  private getRecommendation(endpoint: string, stats: EndpointStats): string {
    if (endpoint.includes('/auth/refresh')) {
      return 'Auth refresh storm detected - check client retry logic and token expiration';
    }
    if (endpoint.includes('/metadata')) {
      return 'Metadata processing spike - check for concurrent updates or large image processing';
    }
    if (stats.averageMemoryDelta > 20 * this.MB) {
      return 'High memory per request - check for large response bodies or memory leaks';
    }
    if (stats.averageDuration > 5000) {
      return 'Slow endpoint - consider adding caching or optimizing queries';
    }
    return 'Monitor for patterns - may be normal traffic spike';
  }
  
  private getEndpointKey(request: any): string {
    // Create a clean endpoint identifier
    // Remove IDs and other variables from path
    let path = request.route?.path || request.url || 'unknown';
    
    // Replace path parameters with placeholders
    path = path.replace(/\/\d+/g, '/:id');
    path = path.replace(/\/[a-f0-9-]{36}/g, '/:uuid');
    path = path.replace(/\/[a-f0-9]{24}/g, '/:objectid');
    
    return `${request.method} ${path}`;
  }
  
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private formatBytes(bytes: number): string {
    const mb = bytes / this.MB;
    const sign = bytes >= 0 ? '+' : '';
    return `${sign}${mb.toFixed(2)} MB`;
  }
  
  // Public method to get current stats
  public getCurrentStats(): Map<string, EndpointStats> {
    return new Map(this.stats);
  }
  
  // Public method to reset stats
  public resetStats(): void {
    this.stats.clear();
    this.logger.log('Endpoint stats reset');
  }
  
  // Cleanup on destroy
  public destroy(): void {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }
}