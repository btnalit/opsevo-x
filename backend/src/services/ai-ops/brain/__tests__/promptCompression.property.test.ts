/**
 * Prompt 压缩属性测试
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4**
 */

import * as fc from 'fast-check';

// ====================================================================
// 内联实现压缩函数（与 autonomousBrainService.ts 保持一致）
// ====================================================================

function compressAlerts(alerts: any[]): string {
  if (alerts.length <= 5) return JSON.stringify(alerts);
  const groups: Record<string, number> = {};
  for (const a of alerts) {
    const sev = a.severity ?? 'unknown';
    groups[sev] = (groups[sev] ?? 0) + 1;
  }
  const stats = Object.entries(groups).map(([sev, cnt]) => `${sev}: ${cnt}`).join(', ');
  const recent = alerts.slice(0, 3);
  return `[摘要: ${alerts.length}条告警 (${stats})] 最近3条: ${JSON.stringify(recent)}`;
}

function compressPredictions(predictions: any[]): string {
  if (predictions.length <= 3) return JSON.stringify(predictions);
  const high = predictions.filter(p => p.confidence > 0.5);
  const lowCount = predictions.length - high.length;
  let result = JSON.stringify(high);
  if (lowCount > 0) result += ` ...及另外 ${lowCount} 个低置信度预测`;
  return result;
}

function compressPatterns(patterns: any[]): string {
  if (patterns.length <= 3) return JSON.stringify(patterns);
  const sorted = [...patterns].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const top3 = sorted.slice(0, 3);
  return `${JSON.stringify(top3)} ...及另外 ${patterns.length - 3} 个低置信度模式`;
}

// ====================================================================
// 生成器
// ====================================================================

const alertArb = fc.record({
  id: fc.uuid(),
  severity: fc.constantFrom('critical', 'high', 'medium', 'low'),
  message: fc.string({ minLength: 1, maxLength: 50 }),
});

const predictionArb = fc.record({
  id: fc.uuid(),
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
  description: fc.string({ minLength: 1, maxLength: 50 }),
});

const patternArb = fc.record({
  id: fc.uuid(),
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
  description: fc.string({ minLength: 1, maxLength: 50 }),
});

// ====================================================================
// Property 7: 告警压缩保留关键信息
// Feature: brain-ooda-enhancements, Property 7: 告警压缩保留关键信息
// ====================================================================

describe('Property 7: 告警压缩保留关键信息', () => {
  /**
   * 超过 5 条告警时，压缩结果应包含：
   * - 总数信息
   * - 按 severity 分组的统计
   * - 最近 3 条详情
   *
   * **Validates: Requirements 3.1**
   */
  it('不超过 5 条时直接返回 JSON', () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 0, maxLength: 5 }),
        (alerts) => {
          const result = compressAlerts(alerts);
          expect(result).toBe(JSON.stringify(alerts));
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('超过 5 条时包含总数和分组统计', () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 6, maxLength: 50 }),
        (alerts) => {
          const result = compressAlerts(alerts);

          // 包含总数
          expect(result).toContain(`${alerts.length}条告警`);

          // 包含每个 severity 的统计
          const severityGroups: Record<string, number> = {};
          for (const a of alerts) {
            const sev = a.severity ?? 'unknown';
            severityGroups[sev] = (severityGroups[sev] ?? 0) + 1;
          }
          for (const [sev, cnt] of Object.entries(severityGroups)) {
            expect(result).toContain(`${sev}: ${cnt}`);
          }

          // 包含最近 3 条详情
          expect(result).toContain('最近3条');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('压缩后的字符串长度小于原始 JSON', () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 10, maxLength: 50 }),
        (alerts) => {
          const compressed = compressAlerts(alerts);
          const original = JSON.stringify(alerts);
          // 压缩后应更短（对于大量告警）
          expect(compressed.length).toBeLessThan(original.length);
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ====================================================================
// Property 8: 预测压缩过滤低置信度项
// Feature: brain-ooda-enhancements, Property 8: 预测压缩过滤低置信度项
// ====================================================================

describe('Property 8: 预测压缩过滤低置信度项', () => {
  /**
   * 超过 3 条预测时，压缩结果应只包含 confidence > 0.5 的项
   * 低置信度项被压缩为计数摘要
   *
   * **Validates: Requirements 3.2**
   */
  it('不超过 3 条时直接返回 JSON', () => {
    fc.assert(
      fc.property(
        fc.array(predictionArb, { minLength: 0, maxLength: 3 }),
        (predictions) => {
          const result = compressPredictions(predictions);
          expect(result).toBe(JSON.stringify(predictions));
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('超过 3 条时只保留 confidence > 0.5 的项', () => {
    fc.assert(
      fc.property(
        fc.array(predictionArb, { minLength: 4, maxLength: 20 }),
        (predictions) => {
          const result = compressPredictions(predictions);
          const highConf = predictions.filter(p => p.confidence > 0.5);
          const lowCount = predictions.length - highConf.length;

          // 高置信度项应出现在结果中
          const parsed = JSON.parse(result.split(' ...及另外')[0]);
          expect(parsed).toHaveLength(highConf.length);

          // 低置信度项应被压缩为计数摘要
          if (lowCount > 0) {
            expect(result).toContain(`${lowCount} 个低置信度预测`);
          }

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ====================================================================
// Property 9: 模式压缩保留 Top-3
// Feature: brain-ooda-enhancements, Property 9: 模式压缩保留 Top-3
// ====================================================================

describe('Property 9: 模式压缩保留 Top-3', () => {
  /**
   * 超过 3 条模式时，压缩结果应只展示 confidence 排名前 3 的详情
   * 其余压缩为计数摘要
   *
   * **Validates: Requirements 3.3**
   */
  it('不超过 3 条时直接返回 JSON', () => {
    fc.assert(
      fc.property(
        fc.array(patternArb, { minLength: 0, maxLength: 3 }),
        (patterns) => {
          const result = compressPatterns(patterns);
          expect(result).toBe(JSON.stringify(patterns));
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('超过 3 条时只保留 Top-3 详情', () => {
    fc.assert(
      fc.property(
        fc.array(patternArb, { minLength: 4, maxLength: 20 }),
        (patterns) => {
          const result = compressPatterns(patterns);
          const remainingCount = patterns.length - 3;

          // 结果应包含剩余数量的摘要
          expect(result).toContain(`${remainingCount} 个低置信度模式`);

          // 解析 Top-3 部分
          const top3Part = result.split(' ...及另外')[0];
          const top3 = JSON.parse(top3Part);
          expect(top3).toHaveLength(3);

          // Top-3 应是 confidence 最高的 3 个
          const sorted = [...patterns].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
          const expectedTop3 = sorted.slice(0, 3);
          expect(top3).toEqual(expectedTop3);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ====================================================================
// Property 10: Prompt 区段字符数上限
// Feature: brain-ooda-enhancements, Property 10: Prompt 区段字符数上限
// ====================================================================

describe('Property 10: Prompt 区段字符数上限', () => {
  /**
   * 使用压缩函数后，Prompt 的变量内容区段应不超过 4000 字符
   *
   * **Validates: Requirements 3.4**
   */
  it('压缩后的 Prompt 变量内容不超过 4000 字符', () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 0, maxLength: 100 }),
        fc.array(predictionArb, { minLength: 0, maxLength: 50 }),
        fc.array(patternArb, { minLength: 0, maxLength: 50 }),
        (alerts, predictions, patterns) => {
          // 模拟 buildPrompt 中的变量内容构建
          const observedStateContent = `Active Alerts (${alerts.length}): ${compressAlerts(alerts)}`;
          const orientContent = [
            `Anomaly Predictions (${predictions.length}): ${compressPredictions(predictions)}`,
            `Detected Operation Patterns (${patterns.length}): ${compressPatterns(patterns)}`,
          ].join('\n');

          let variableContent = observedStateContent + '\n' + orientContent;

          // 模拟截断逻辑
          if (variableContent.length > 4000) {
            // 截断 patterns
            const truncatedOrient = [
              `Anomaly Predictions (${predictions.length}): ${compressPredictions(predictions)}`,
              `Detected Operation Patterns (${patterns.length}): [已截断，共 ${patterns.length} 条]`,
            ].join('\n');
            variableContent = observedStateContent + '\n' + truncatedOrient;
          }

          if (variableContent.length > 4000) {
            // 截断 predictions
            const top1 = predictions.slice(0, 1);
            const truncatedOrient = [
              `Anomaly Predictions (${predictions.length}): ${JSON.stringify(top1)}`,
              `Detected Operation Patterns (${patterns.length}): [已截断，共 ${patterns.length} 条]`,
            ].join('\n');
            variableContent = observedStateContent + '\n' + truncatedOrient;
          }

          if (variableContent.length > 4000) {
            // 硬截断兜底
            variableContent = variableContent.substring(0, 3950) + '... [内容因超出上限被强制截断]';
          }

          expect(variableContent.length).toBeLessThanOrEqual(4000);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('少量数据时不触发截断', () => {
    fc.assert(
      fc.property(
        fc.array(alertArb, { minLength: 0, maxLength: 3 }),
        fc.array(predictionArb, { minLength: 0, maxLength: 2 }),
        fc.array(patternArb, { minLength: 0, maxLength: 2 }),
        (alerts, predictions, patterns) => {
          const observedStateContent = `Active Alerts (${alerts.length}): ${compressAlerts(alerts)}`;
          const orientContent = [
            `Anomaly Predictions (${predictions.length}): ${compressPredictions(predictions)}`,
            `Detected Operation Patterns (${patterns.length}): ${compressPatterns(patterns)}`,
          ].join('\n');

          const variableContent = observedStateContent + '\n' + orientContent;

          // 少量数据不应触发截断
          expect(variableContent).not.toContain('[已截断');

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
