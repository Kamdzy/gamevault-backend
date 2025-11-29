import { Module, Global } from '@nestjs/common';
import { MemoryMonitorService } from './memory-monitor.service';

@Global()
@Module({
  providers: [MemoryMonitorService],
  exports: [MemoryMonitorService],
})
export class MemoryMonitorModule {}