/**
 * ToolFeedbackCollector 工具反馈收集器单元测试
 *
 * Requirements: 2.1, 2.3
 */

import fs from 'fs/promises';
import path from 'path';
import { ToolFeedbackCollector, ToolMetric, setMetricsDirForTesting } from './toolFeedbackCollector';

const TEST_METRICS_DIR = path.join(process.cwd(), 'data', 'ai-ops', 'test-tool-metrics');
setMetricsDirForTesting(TEST_METRICS_DIR);

describe('ToolFeedbackCollector', () => {
  let collector: ToolFeedbackCollector;

  beforeEach(async () => {
    collector = new ToolFeedbackCollector();
    // Clean up test data directory
    try {
      const files = await fs.readdir(TEST_METRICS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(TEST_METRICS_DIR, file));
        }
      }
    } catch {
      // Directory may not exist yet
    }
  });

  afterEach(() => {
    collector.shutdown();
  });

  describe('recordMetric', () => {
    it('should record a successful metric to a date-sharded file', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({
        toolName: 'ping',
        timestamp,
        duration: 150,
        success: true,
      });

      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const filePath = path.join(TEST_METRICS_DIR, `${dateStr}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      const metrics: ToolMetric[] = JSON.parse(data);

      expect(metrics).toHaveLength(1);
      expect(metrics[0].toolName).toBe('ping');
      expect(metrics[0].duration).toBe(150);
      expect(metrics[0].success).toBe(true);
      expect(metrics[0].id).toBeDefined();
    });

    it('should record a failed metric with error message', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({
        toolName: 'ssh_exec',
        timestamp,
        duration: 5000,
        success: false,
        errorMessage: 'Connection timeout',
      });

      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const filePath = path.join(TEST_METRICS_DIR, `${dateStr}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      const metrics: ToolMetric[] = JSON.parse(data);

      expect(metrics).toHaveLength(1);
      expect(metrics[0].success).toBe(false);
      expect(metrics[0].errorMessage).toBe('Connection timeout');
    });

    it('should append metrics to existing file for the same day', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({
        toolName: 'ping',
        timestamp,
        duration: 100,
        success: true,
      });

      await collector.recordMetric({
        toolName: 'traceroute',
        timestamp,
        duration: 200,
        success: true,
      });

      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const filePath = path.join(TEST_METRICS_DIR, `${dateStr}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      const metrics: ToolMetric[] = JSON.parse(data);

      expect(metrics).toHaveLength(2);
      expect(metrics[0].toolName).toBe('ping');
      expect(metrics[1].toolName).toBe('traceroute');
    });

    it('should include requestId when provided', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({
        toolName: 'ping',
        timestamp,
        duration: 100,
        success: true,
        requestId: 'req-123',
      });

      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      const filePath = path.join(TEST_METRICS_DIR, `${dateStr}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      const metrics: ToolMetric[] = JSON.parse(data);

      expect(metrics[0].requestId).toBe('req-123');
    });
  });

  describe('getToolStats', () => {
    it('should return empty array when no metrics exist', async () => {
      const stats = await collector.getToolStats();
      expect(stats).toEqual([]);
    });

    it('should aggregate stats for all tools', async () => {
      const timestamp = Date.now();

      await collector.recordMetric({ toolName: 'ping', timestamp, duration: 100, success: true });
      await collector.recordMetric({ toolName: 'ping', timestamp, duration: 200, success: true });
      await collector.recordMetric({ toolName: 'ping', timestamp, duration: 300, success: false, errorMessage: 'timeout' });
      await collector.recordMetric({ toolName: 'ssh_exec', timestamp, duration: 500, success: true });

      const stats = await collector.getToolStats();

      expect(stats).toHaveLength(2);

      const pingStat = stats.find((s) => s.toolName === 'ping');
      expect(pingStat).toBeDefined();
      expect(pingStat!.totalCalls).toBe(3);
      expect(pingStat!.successCount).toBe(2);
      expect(pingStat!.successRate).toBeCloseTo(2 / 3);
      expect(pingStat!.avgDuration).toBeCloseTo(200);

      const sshStat = stats.find((s) => s.toolName === 'ssh_exec');
      expect(sshStat).toBeDefined();
      expect(sshStat!.totalCalls).toBe(1);
      expect(sshStat!.successCount).toBe(1);
      expect(sshStat!.successRate).toBe(1);
      expect(sshStat!.avgDuration).toBe(500);
    });

    it('should filter stats by tool name', async () => {
      const timestamp = Date.now();

      await collector.recordMetric({ toolName: 'ping', timestamp, duration: 100, success: true });
      await collector.recordMetric({ toolName: 'ssh_exec', timestamp, duration: 500, success: true });

      const stats = await collector.getToolStats('ping');

      expect(stats).toHaveLength(1);
      expect(stats[0].toolName).toBe('ping');
    });

    it('should return empty array when filtering for non-existent tool', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({ toolName: 'ping', timestamp, duration: 100, success: true });

      const stats = await collector.getToolStats('non_existent');
      expect(stats).toEqual([]);
    });
  });

  describe('cleanupExpiredMetrics', () => {
    it('should delete files older than retention days', async () => {
      // Create a file for today
      const today = new Date();
      await collector.recordMetric({
        toolName: 'ping',
        timestamp: today.getTime(),
        duration: 100,
        success: true,
      });

      // Create a file for 10 days ago
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);
      const oldDateStr = oldDate.toISOString().split('T')[0];
      const oldFilePath = path.join(TEST_METRICS_DIR, `${oldDateStr}.json`);
      await fs.writeFile(oldFilePath, JSON.stringify([{
        id: 'old-metric',
        toolName: 'ping',
        timestamp: oldDate.getTime(),
        duration: 100,
        success: true,
      }]), 'utf-8');

      const deletedCount = await collector.cleanupExpiredMetrics(5);

      expect(deletedCount).toBe(1);

      // Verify old file is deleted
      try {
        await fs.access(oldFilePath);
        fail('Old file should have been deleted');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
      }

      // Verify today's file still exists
      const todayStr = today.toISOString().split('T')[0];
      const todayFilePath = path.join(TEST_METRICS_DIR, `${todayStr}.json`);
      const todayData = await fs.readFile(todayFilePath, 'utf-8');
      expect(JSON.parse(todayData)).toHaveLength(1);
    });

    it('should return 0 when no files are expired', async () => {
      const timestamp = Date.now();
      await collector.recordMetric({
        toolName: 'ping',
        timestamp,
        duration: 100,
        success: true,
      });

      const deletedCount = await collector.cleanupExpiredMetrics(30);
      expect(deletedCount).toBe(0);
    });

    it('should return 0 when no metrics directory exists', async () => {
      // Remove the directory if it exists
      try {
        const files = await fs.readdir(TEST_METRICS_DIR);
        for (const file of files) {
          await fs.unlink(path.join(TEST_METRICS_DIR, file));
        }
        await fs.rmdir(TEST_METRICS_DIR);
      } catch {
        // Ignore
      }

      const deletedCount = await collector.cleanupExpiredMetrics(7);
      expect(deletedCount).toBe(0);
    });
  });

  describe('startCleanupTimer / stopCleanupTimer', () => {
    it('should start and stop cleanup timer without errors', () => {
      expect(() => collector.startCleanupTimer(7)).not.toThrow();
      expect(() => collector.stopCleanupTimer()).not.toThrow();
    });

    it('should stop existing timer when starting a new one', () => {
      collector.startCleanupTimer(7);
      expect(() => collector.startCleanupTimer(14)).not.toThrow();
      collector.stopCleanupTimer();
    });

    it('should handle stopping when no timer is running', () => {
      expect(() => collector.stopCleanupTimer()).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should stop cleanup timer on shutdown', () => {
      collector.startCleanupTimer(7);
      expect(() => collector.shutdown()).not.toThrow();
    });

    it('should handle shutdown when no timer is running', () => {
      expect(() => collector.shutdown()).not.toThrow();
    });
  });
});
