import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

interface MemorySnapshot {
  timestamp: Date;
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  arrayBuffers: number;
}

interface MemoryDelta {
  heapUsedDelta: number;
  heapTotalDelta: number;
  externalDelta: number;
  rssDelta: number;
  arrayBuffersDelta: number;
}

@Injectable()
export class MemoryMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryMonitorService.name);
  private monitorInterval: NodeJS.Timeout | null = null;
  private previousSnapshot: MemorySnapshot | null = null;
  private startSnapshot: MemorySnapshot | null = null;
  
  // Configuration
  private readonly MONITOR_INTERVAL_MS = 5000; // 5 seconds
  private readonly MB = 1024 * 1024;
  private readonly ALERT_THRESHOLD_MB = 100; // Alert if memory increases by 100MB in 5 seconds
  
  onModuleInit() {
    this.logger.log('🔍 Memory Monitor Service initialized');
    this.startMonitoring();
  }
  
  onModuleDestroy() {
    this.stopMonitoring();
  }
  
  private startMonitoring(): void {
    // Take initial snapshot
    this.startSnapshot = this.takeSnapshot();
    this.previousSnapshot = this.startSnapshot;
    
    this.logger.log({
      message: '📊 Initial Memory Baseline',
      ...this.formatMemorySnapshot(this.startSnapshot),
    });
    
    // Start monitoring
    this.monitorInterval = setInterval(() => {
      this.checkMemory();
    }, this.MONITOR_INTERVAL_MS);
  }
  
  private stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.logger.log('Memory monitoring stopped');
    }
  }
  
  private takeSnapshot(): MemorySnapshot {
    const memUsage = process.memoryUsage();
    return {
      timestamp: new Date(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
      arrayBuffers: memUsage.arrayBuffers || 0,
    };
  }
  
  private calculateDelta(current: MemorySnapshot, previous: MemorySnapshot): MemoryDelta {
    return {
      heapUsedDelta: current.heapUsed - previous.heapUsed,
      heapTotalDelta: current.heapTotal - previous.heapTotal,
      externalDelta: current.external - previous.external,
      rssDelta: current.rss - previous.rss,
      arrayBuffersDelta: current.arrayBuffers - previous.arrayBuffers,
    };
  }
  
  private checkMemory(): void {
    const currentSnapshot = this.takeSnapshot();
    
    if (!this.previousSnapshot || !this.startSnapshot) {
      this.previousSnapshot = currentSnapshot;
      return;
    }
    
    const delta = this.calculateDelta(currentSnapshot, this.previousSnapshot);
    const totalDelta = this.calculateDelta(currentSnapshot, this.startSnapshot);
    
    // Determine if this is a concerning increase
    const heapIncreasePerSecond = delta.heapUsedDelta / (this.MONITOR_INTERVAL_MS / 1000);
    const isAlerting = Math.abs(delta.heapUsedDelta) > this.ALERT_THRESHOLD_MB * this.MB;
    
    const logLevel = isAlerting ? 'warn' : 'log';
    const emoji = isAlerting ? '🚨' : '📊';
    
    // Log memory status
    this.logger[logLevel]({
      message: `${emoji} Memory Status ${isAlerting ? '(HIGH CHANGE DETECTED!)' : ''}`,
      current: this.formatMemorySnapshot(currentSnapshot),
      delta_last_5s: this.formatDelta(delta),
      delta_since_start: this.formatDelta(totalDelta),
      rate_per_second: {
        heapUsed: this.formatBytes(heapIncreasePerSecond),
        rss: this.formatBytes(delta.rssDelta / (this.MONITOR_INTERVAL_MS / 1000)),
      },
      uptime: this.formatUptime(process.uptime()),
    });
    
    // Additional detailed analysis if memory is growing rapidly
    if (isAlerting) {
      this.logDetailedAnalysis(currentSnapshot, delta);
    }
    
    this.previousSnapshot = currentSnapshot;
  }
  
  private logDetailedAnalysis(snapshot: MemorySnapshot, delta: MemoryDelta): void {
    // Get V8 heap statistics for more details
    const v8 = require('v8');
    const heapStats = v8.getHeapStatistics();
    const heapSpaceStats = v8.getHeapSpaceStatistics();
    
    this.logger.warn({
      message: '🔬 Detailed Memory Analysis',
      v8_heap: {
        total_heap_size: this.formatBytes(heapStats.total_heap_size),
        used_heap_size: this.formatBytes(heapStats.used_heap_size),
        heap_size_limit: this.formatBytes(heapStats.heap_size_limit),
        usage_percent: ((heapStats.used_heap_size / heapStats.heap_size_limit) * 100).toFixed(2) + '%',
        malloced_memory: this.formatBytes(heapStats.malloced_memory),
        does_zap_garbage: heapStats.does_zap_garbage,
      },
      heap_spaces: heapSpaceStats.map((space: any) => ({
        name: space.space_name,
        size: this.formatBytes(space.space_size),
        used: this.formatBytes(space.space_used_size),
        available: this.formatBytes(space.space_available_size),
        physical: this.formatBytes(space.physical_space_size),
      })),
      suspected_cause: this.identifySuspectedCause(delta),
    });
    
    // Force garbage collection if available (only works with --expose-gc flag)
    if (global.gc) {
      this.logger.warn('Running manual garbage collection...');
      global.gc();
      const afterGC = this.takeSnapshot();
      const gcReclaimed = snapshot.heapUsed - afterGC.heapUsed;
      this.logger.warn({
        message: 'Garbage collection completed',
        reclaimed: this.formatBytes(gcReclaimed),
        new_heap_used: this.formatBytes(afterGC.heapUsed),
      });
    }
  }
  
  private identifySuspectedCause(delta: MemoryDelta): string[] {
    const causes: string[] = [];
    
    if (delta.heapUsedDelta > 50 * this.MB) {
      causes.push('Large heap allocation (>50MB) - likely object creation or array growth');
    }
    
    if (delta.externalDelta > 20 * this.MB) {
      causes.push('External memory growth (>20MB) - likely Buffer or TypedArray allocation');
    }
    
    if (delta.arrayBuffersDelta > 10 * this.MB) {
      causes.push('ArrayBuffer growth (>10MB) - check file uploads/downloads or binary data processing');
    }
    
    if (delta.rssDelta > delta.heapUsedDelta * 2) {
      causes.push('RSS growing faster than heap - possible memory fragmentation or native memory leak');
    }
    
    if (causes.length === 0) {
      causes.push('Gradual heap growth - check for event listener leaks, unclosed connections, or growing caches');
    }
    
    return causes;
  }
  
  private formatMemorySnapshot(snapshot: MemorySnapshot): Record<string, string> {
    return {
      heapUsed: this.formatBytes(snapshot.heapUsed),
      heapTotal: this.formatBytes(snapshot.heapTotal),
      external: this.formatBytes(snapshot.external),
      rss: this.formatBytes(snapshot.rss),
      arrayBuffers: this.formatBytes(snapshot.arrayBuffers),
    };
  }
  
  private formatDelta(delta: MemoryDelta): Record<string, string> {
    return {
      heapUsed: this.formatBytesDelta(delta.heapUsedDelta),
      heapTotal: this.formatBytesDelta(delta.heapTotalDelta),
      external: this.formatBytesDelta(delta.externalDelta),
      rss: this.formatBytesDelta(delta.rssDelta),
      arrayBuffers: this.formatBytesDelta(delta.arrayBuffersDelta),
    };
  }
  
  private formatBytes(bytes: number): string {
    const mb = bytes / this.MB;
    return `${mb.toFixed(2)} MB`;
  }
  
  private formatBytesDelta(bytes: number): string {
    const sign = bytes >= 0 ? '+' : '';
    return `${sign}${this.formatBytes(bytes)}`;
  }
  
  private formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
  }
  
  // Public method to manually trigger a memory snapshot
  public logCurrentMemory(): void {
    const current = this.takeSnapshot();
    this.logger.log({
      message: '📊 Manual Memory Snapshot',
      ...this.formatMemorySnapshot(current),
    });
  }
  
  // Public method to get memory statistics
  public getMemoryStats(): {
    current: MemorySnapshot;
    delta: MemoryDelta | null;
    totalDelta: MemoryDelta | null;
  } {
    const current = this.takeSnapshot();
    return {
      current,
      delta: this.previousSnapshot ? this.calculateDelta(current, this.previousSnapshot) : null,
      totalDelta: this.startSnapshot ? this.calculateDelta(current, this.startSnapshot) : null,
    };
  }
}