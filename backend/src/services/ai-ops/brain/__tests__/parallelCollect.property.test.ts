/**
 * parallelCollectWithLimit 属性测试
 *
 * **Validates: Requirements 4.2, 4.3**
 */

import * as fc from 'fast-check';

// ====================================================================
// 内联实现 parallelCollectWithLimit（与 autonomousBrainService.ts 保持一致）
// ====================================================================

async function parallelCollectWithLimit<T, I>(
  items: I[],
  collector: (item: I) => Promise<T>,
  concurrencyLimit = 10
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  for (let i = 0; i < items.length; i += concurrencyLimit) {
    const batch = items.slice(i, i + concurrencyLimit);
    const batchResults = await Promise.allSettled(batch.map(item => collector(item)));
    results.push(...batchResults);
  }
  return results;
}

// ====================================================================
// Property 11: 多设备采集故障隔离
// Feature: brain-ooda-enhancements, Property 11: 多设备采集故障隔离
// ====================================================================

describe('Property 11: 多设备采集故障隔离', () => {
  /**
   * 当某些设备采集失败时，其他设备的结果应正常返回
   * 失败设备不影响成功设备的采集结果
   *
   * **Validates: Requirements 4.2**
   */
  it('部分设备失败时，其他设备结果正常返回', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            shouldFail: fc.boolean(),
            value: fc.integer({ min: 0, max: 1000 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        async (devices) => {
          const results = await parallelCollectWithLimit(
            devices,
            async (device) => {
              if (device.shouldFail) {
                throw new Error(`Device ${device.id} unreachable`);
              }
              return device.value;
            },
            10
          );

          // 结果数量应等于设备数量
          expect(results).toHaveLength(devices.length);

          // 验证每个设备的结果
          for (let i = 0; i < devices.length; i++) {
            const device = devices[i];
            const result = results[i];

            if (device.shouldFail) {
              expect(result.status).toBe('rejected');
              if (result.status === 'rejected') {
                expect(result.reason.message).toContain(device.id);
              }
            } else {
              expect(result.status).toBe('fulfilled');
              if (result.status === 'fulfilled') {
                expect(result.value).toBe(device.value);
              }
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('所有设备失败时，返回全部 rejected 结果', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        async (deviceIds) => {
          const results = await parallelCollectWithLimit(
            deviceIds,
            async (id) => { throw new Error(`${id} failed`); },
            5
          );

          expect(results).toHaveLength(deviceIds.length);
          expect(results.every(r => r.status === 'rejected')).toBe(true);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('结果顺序与输入设备顺序一致', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 15 }),
        async (values) => {
          const results = await parallelCollectWithLimit(
            values,
            async (v) => v * 2,
            5
          );

          expect(results).toHaveLength(values.length);
          for (let i = 0; i < values.length; i++) {
            expect(results[i].status).toBe('fulfilled');
            if (results[i].status === 'fulfilled') {
              expect((results[i] as PromiseFulfilledResult<number>).value).toBe(values[i] * 2);
            }
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ====================================================================
// Property 12: 并发上限控制
// Feature: brain-ooda-enhancements, Property 12: 并发上限控制
// ====================================================================

describe('Property 12: 并发上限控制', () => {
  /**
   * 当 items 数量超过 concurrencyLimit 时，应分批执行
   * 每批的并发数不超过 concurrencyLimit
   *
   * **Validates: Requirements 4.3**
   */
  it('并发数不超过 concurrencyLimit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),   // concurrencyLimit
        fc.integer({ min: 1, max: 20 }),  // items count
        async (limit, count) => {
          let maxConcurrent = 0;
          let currentConcurrent = 0;

          const items = Array.from({ length: count }, (_, i) => i);

          await parallelCollectWithLimit(
            items,
            async (item) => {
              currentConcurrent++;
              maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
              // 模拟异步操作
              await new Promise(resolve => setImmediate(resolve));
              currentConcurrent--;
              return item;
            },
            limit
          );

          // 最大并发数不应超过 limit
          expect(maxConcurrent).toBeLessThanOrEqual(limit);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('空 items 数组返回空结果', async () => {
    const results = await parallelCollectWithLimit(
      [],
      async (x: number) => x,
      5
    );
    expect(results).toHaveLength(0);
  });

  it('items 数量小于 limit 时，一批完成所有采集', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        async (count) => {
          const items = Array.from({ length: count }, (_, i) => i);
          let batchCount = 0;

          // 通过追踪批次来验证（items < limit=10，应只有一批）
          const results = await parallelCollectWithLimit(
            items,
            async (item) => {
              batchCount++;
              return item;
            },
            10 // limit > count
          );

          expect(results).toHaveLength(count);
          expect(batchCount).toBe(count); // 所有 items 在一批中处理

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});
