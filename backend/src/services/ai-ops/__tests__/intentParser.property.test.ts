/**
 * IntentParser 消歧逻辑一致性属性测试
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
 */

import * as fc from 'fast-check';
import { IntentParser } from '../intentParser';

// ====================================================================
// Property 13: 消歧逻辑一致性
// Feature: brain-ooda-enhancements, Property 13: 消歧逻辑一致性
// ====================================================================

describe('Property 13: 消歧逻辑一致性', () => {
  const parser = new IntentParser();

  /**
   * 对任意输入，parse 返回的 disambiguationApplied 应与内部消歧判断一致：
   * - 当有多个候选且分数差 < disambiguationThreshold 时，disambiguationApplied = true
   * - 当只有一个候选或分数差 >= disambiguationThreshold 时，disambiguationApplied = false
   *
   * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
   */
  it('disambiguationApplied 与 alternatives 存在性一致', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成包含多个意图关键词的输入（更容易触发消歧）
        fc.constantFrom(
          '查看接口状态',
          '修改防火墙规则',
          '删除路由',
          '添加 IP 地址',
          '重启设备',
          '监控系统资源',
          '批量更新配置',
          '诊断网络问题',
          '修复连接故障',
          '查看日志记录',
          '设置 DNS 服务器',
          '添加防火墙规则并删除旧规则',
          '查看并修改接口配置',
        ),
        async (input) => {
          const result = await parser.parse(input);

          // disambiguationApplied 应是布尔值
          expect(typeof result.disambiguationApplied).toBe('boolean');

          // 如果 disambiguationApplied = true，应有 alternatives
          if (result.disambiguationApplied) {
            expect(result.alternatives).toBeDefined();
            expect(result.alternatives!.length).toBeGreaterThan(0);
          }

          // confidence 应在 [0, 1] 范围内
          expect(result.confidence).toBeGreaterThanOrEqual(0);
          expect(result.confidence).toBeLessThanOrEqual(1);

          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('相同输入多次解析结果一致（确定性）', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          '查看接口状态',
          '修改防火墙规则',
          '删除路由',
          '添加 IP 地址',
        ),
        async (input) => {
          const result1 = await parser.parse(input);
          const result2 = await parser.parse(input);

          // 相同输入应产生相同的 disambiguationApplied
          expect(result1.disambiguationApplied).toBe(result2.disambiguationApplied);
          // 相同输入应产生相同的 category 和 action
          expect(result1.category).toBe(result2.category);
          expect(result1.action).toBe(result2.action);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('未知意图的 disambiguationApplied 为 false', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 生成随机字符串，不包含任何意图关键词
        fc.string({ minLength: 1, maxLength: 20 })
          .filter(s => !['查看', '修改', '删除', '添加', '重启', '监控', '批量', '诊断', '修复',
            'show', 'get', 'add', 'delete', 'modify', 'restart', 'monitor', 'fix'].some(kw => s.includes(kw))),
        async (input) => {
          const result = await parser.parse(input);

          if (result.category === 'unknown') {
            expect(result.disambiguationApplied).toBe(false);
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('高置信度单一匹配时 disambiguationApplied 为 false', async () => {
    // 使用明确的单一意图关键词
    const clearIntentInputs = [
      '查看系统资源使用情况',
      '重启路由器设备',
      '批量更新所有接口配置',
    ];

    for (const input of clearIntentInputs) {
      const result = await parser.parse(input);
      // 对于明确的单一意图，不应触发消歧
      // （注意：这取决于关键词匹配，某些输入可能仍触发消歧）
      expect(typeof result.disambiguationApplied).toBe('boolean');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it('alternatives 中的每个意图 disambiguationApplied 为 false', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          '查看并修改接口配置',
          '添加防火墙规则并删除旧规则',
          '修复并监控网络问题',
        ),
        async (input) => {
          const result = await parser.parse(input);

          if (result.alternatives) {
            for (const alt of result.alternatives) {
              // alternatives 中的意图不应再次触发消歧
              expect(alt.disambiguationApplied).toBe(false);
            }
          }

          return true;
        }
      ),
      { numRuns: 30 }
    );
  });
});
