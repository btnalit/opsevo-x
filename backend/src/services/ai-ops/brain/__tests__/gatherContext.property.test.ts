/**
 * gatherContext 并行采集属性测试
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
 */

import * as fc from 'fast-check';

// ====================================================================
// 内联实现 withTimeout + 并行采集逻辑（与 autonomousBrainService.ts 保持一致）
// ====================================================================

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    promise.finally(() => clearTimeout(timeoutHandle)),
    new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () =>
        reject(new Error(`${label} 超时 (${ms}ms)`))
      )
    ),
  ]);
}

interface PerceptionHealthEntry {
  source: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  degraded?: boolean;
}

/**
 * 模拟 gatherContext 的并行采集逻辑
 * 接受一组感知源（每个源是一个 Promise 工厂），并行采集，记录健康状态
 */
async function parallelGatherSources<T>(
  sources: Array<{
    name: string;
    collect: () => Promise<T>;
    defaultValue: T;
    timeoutMs?: number;
  }>
): Promise<{ results: T[]; perceptionHealth: PerceptionHealthEntry[] }> {
  const results: T[] = [];
  const perceptionHealth: PerceptionHealthEntry[] = [];

  const settled = await Promise.allSettled(
    sources.map(async (src) => {
      const start = Date.now();
      try {
        const value = await withTimeout(
          src.collect(),
          src.timeoutMs ?? 5000,
          src.name
        );
        const durationMs = Date.now() - start;
        perceptionHealth.push({ source: src.name, ok: true, durationMs });
        return value;
      } catch (err) {
        const durationMs = Date.now() - start;
        const errMsg = err instanceof Error ? err.message : String(err);
        const degraded = errMsg.includes('超时');
        perceptionHealth.push({
          source: src.name,
          ok: false,
          error: errMsg,
          durationMs,
          degraded,
        });
        return src.defaultValue;
      }
    })
  );

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    }
  }

  return { results, perceptionHealth };
}

// ====================================================================
// Property 5: 感知源故障降级不影响其他源
// Feature: brain-ooda-enhancements, Property 5: 感知源故障降级不影响其他源
// ====================================================================

describe('Property 5: 感知源故障降级不影响其他源', () => {
  /**
   * 当某些感知源失败时，其他感知源的结果应正常返回，
   * 失败源使用默认值填充，perceptionHealth 中记录失败状态
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  it('部分感知源失败时，其他源的结果正常返回', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成 2-7 个感知源，每个源随机决定是否失败
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 20 }),
            shouldFail: fc.boolean(),
            value: fc.integer({ min: 0, max: 1000 }),
          }),
          { minLength: 2, maxLength: 7 }
        ),
        async (sourceDefs) => {
          const sources = sourceDefs.map((def) => ({
            name: def.name,
            collect: def.shouldFail
              ? () => Promise.reject(new Error(`${def.name} 采集失败`))
              : () => Promise.resolve(def.value),
            defaultValue: -1,
          }));

          const { results, perceptionHealth } = await parallelGatherSources(sources);

          // 结果数量应等于源数量（失败源使用默认值）
          expect(results).toHaveLength(sourceDefs.length);

          // 每个源都应有健康记录
          expect(perceptionHealth).toHaveLength(sourceDefs.length);

          // 验证失败源使用了默认值，成功源返回了正确值
          for (let i = 0; i < sourceDefs.length; i++) {
            const def = sourceDefs[i];
            const health = perceptionHealth.find(h => h.source === def.name);
            expect(health).toBeDefined();

            if (def.shouldFail) {
              expect(health!.ok).toBe(false);
              expect(health!.error).toBeDefined();
              expect(results[i]).toBe(-1); // 默认值
            } else {
              expect(health!.ok).toBe(true);
              expect(results[i]).toBe(def.value);
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('所有感知源失败时，返回全部默认值且 perceptionHealth 全部标记失败', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: 20 }),
          { minLength: 1, maxLength: 5 }
        ),
        async (sourceNames) => {
          const sources = sourceNames.map((name) => ({
            name,
            collect: () => Promise.reject(new Error(`${name} 失败`)),
            defaultValue: 'default',
          }));

          const { results, perceptionHealth } = await parallelGatherSources(sources);

          expect(results).toHaveLength(sourceNames.length);
          expect(results.every(r => r === 'default')).toBe(true);
          expect(perceptionHealth.every(h => !h.ok)).toBe(true);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ====================================================================
// Property 6: 并行采集总耗时上界
// Feature: brain-ooda-enhancements, Property 6: 并行采集总耗时上界
// ====================================================================

describe('Property 6: 并行采集总耗时上界', () => {
  /**
   * 并行采集 N 个源时，总耗时应接近最慢源的耗时（而非所有源耗时之和）
   * 具体：总耗时 < max(各源耗时) * 1.5 + 50ms 缓冲
   *
   * **Validates: Requirements 2.3, 2.4**
   */
  it('并行采集总耗时不超过最慢源耗时的 1.5 倍 + 50ms', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成 2-5 个源，每个源有 10-100ms 的延迟
        fc.array(
          fc.integer({ min: 10, max: 100 }),
          { minLength: 2, maxLength: 5 }
        ),
        async (delays) => {
          const sources = delays.map((delay, i) => ({
            name: `source-${i}`,
            collect: () => new Promise<number>(resolve => setTimeout(() => resolve(delay), delay)),
            defaultValue: 0,
          }));

          const start = Date.now();
          await parallelGatherSources(sources);
          const totalMs = Date.now() - start;

          const maxDelay = Math.max(...delays);
          const upperBound = maxDelay * 1.5 + 50;

          expect(totalMs).toBeLessThan(upperBound);

          return true;
        }
      ),
      { numRuns: 20 } // 减少运行次数，因为涉及真实延迟
    );
  });

  it('超时源被正确标记为 degraded', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成 1-3 个超时源（延迟超过 timeoutMs）
        fc.array(
          fc.integer({ min: 1, max: 3 }),
          { minLength: 1, maxLength: 3 }
        ),
        async (timeoutSources) => {
          const sources = timeoutSources.map((_, i) => ({
            name: `timeout-source-${i}`,
            // 延迟 200ms，但超时设为 50ms
            collect: () => new Promise<string>(resolve => setTimeout(() => resolve('ok'), 200)),
            defaultValue: 'timeout-default',
            timeoutMs: 50,
          }));

          const { perceptionHealth } = await parallelGatherSources(sources);

          for (const health of perceptionHealth) {
            expect(health.ok).toBe(false);
            expect(health.degraded).toBe(true);
            expect(health.error).toContain('超时');
          }

          return true;
        }
      ),
      { numRuns: 10 }
    );
  });
});
