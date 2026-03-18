/**
 * 操作后验证模板属性测试
 *
 * 测试 VERIFICATION_DIRECTIVE_TEMPLATES 的结构完整性和纯函数性质。
 * 旧的 INTENT_VERIFICATION_MAP + checkFn 路径已移除，验证逻辑统一由
 * VERIFICATION_DIRECTIVE_TEMPLATES + LLM 驱动的 verification_directive 完成。
 *
 * **Validates: Requirements 3.2, 3.4, 3.5**
 */

import * as fc from 'fast-check';
import { VERIFICATION_DIRECTIVE_TEMPLATES } from '../../brain/intentRegistry';
import type { IntentParams } from '../../brain/intentRegistry';

// ====================================================================
// Property: VERIFICATION_DIRECTIVE_TEMPLATES 结构完整性
// ====================================================================

describe('Property: VERIFICATION_DIRECTIVE_TEMPLATES 结构完整性', () => {
  it('所有必需的 medium+ 风险意图都有验证模板', () => {
    const requiredIntents = [
      // 接口操作
      'disable_interface',
      'enable_interface',
      // 防火墙操作
      'add_firewall_rule',
      'remove_firewall_rule',
      'add_nat_rule',
      'remove_nat_rule',
      'enable_firewall_rule',
      'disable_nat_rule',
      'enable_nat_rule',
      // 地址列表
      'add_address_list_entry',
      'remove_address_list_entry',
      // DHCP
      'add_dhcp_lease',
      'remove_dhcp_lease',
      // 路由
      'add_static_route',
      'remove_route',
      // 防火墙禁用
      'disable_firewall_rule',
      // 队列/IP 删除
      'remove_queue',
      'remove_ip_address',
      // 系统备份
      'system_backup',
      // 配置类
      'modify_queue',
      'set_dns_server',
      'set_interface_comment',
      'set_ntp_server',
      'add_queue',
      'add_ip_address',
      'modify_firewall_rule',
      'modify_nat_rule',
      'flush_dns_cache',
      'flush_arp_table',
      'disconnect_ppp',
    ];

    for (const intent of requiredIntents) {
      expect(VERIFICATION_DIRECTIVE_TEMPLATES).toHaveProperty(intent);
      const templateFn = VERIFICATION_DIRECTIVE_TEMPLATES[intent];
      expect(typeof templateFn).toBe('function');
    }
  });

  it('每个模板函数是纯函数（相同输入返回相同结构）', () => {
    fc.assert(
      fc.property(
        fc.record({
          target: fc.string({ minLength: 1, maxLength: 20 }),
          deviceId: fc.string({ minLength: 1, maxLength: 20 }),
          comment: fc.option(fc.string({ minLength: 1, maxLength: 30 })),
        }),
        (params) => {
          const mockParams = {
            ...params,
            comment: params.comment ?? undefined,
          } as IntentParams;

          for (const [, templateFn] of Object.entries(VERIFICATION_DIRECTIVE_TEMPLATES)) {
            const result1 = templateFn(mockParams);
            const result2 = templateFn(mockParams);

            // 纯函数：相同输入返回相同结果
            expect(result1.verify_action).toBe(result2.verify_action);
            expect(result1.expected_condition).toBe(result2.expected_condition);
            expect(result1.timeout_ms).toBe(result2.timeout_ms);
          }

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });

  it('每个模板返回的 VerificationDirective 包含所有必要字段', () => {
    const mockParams: IntentParams = {
      target: 'ether1',
      deviceId: 'test-device',
      comment: 'test-comment',
      _verifyComment: 'test-comment [brain-op-abc123]',
    };

    for (const [intentAction, templateFn] of Object.entries(VERIFICATION_DIRECTIVE_TEMPLATES)) {
      const directive = templateFn(mockParams);

      // verify_action 必须是非空字符串
      expect(typeof directive.verify_action).toBe('string');
      expect(directive.verify_action.length).toBeGreaterThan(0);

      // expected_condition 必须是非空字符串
      expect(typeof directive.expected_condition).toBe('string');
      expect(directive.expected_condition.length).toBeGreaterThan(0);

      // timeout_ms 必须是正整数
      expect(typeof directive.timeout_ms).toBe('number');
      expect(directive.timeout_ms).toBeGreaterThan(0);

      // verify_params 如果存在，必须是对象
      if (directive.verify_params !== undefined) {
        expect(typeof directive.verify_params).toBe('object');
      }
    }
  });

  it('timeout_ms 在合理范围内（1s ~ 60s）', () => {
    const mockParams: IntentParams = { target: 'ether1', deviceId: 'test-device' };

    for (const [intentAction, templateFn] of Object.entries(VERIFICATION_DIRECTIVE_TEMPLATES)) {
      const directive = templateFn(mockParams);
      expect(directive.timeout_ms).toBeGreaterThanOrEqual(1_000);
      expect(directive.timeout_ms).toBeLessThanOrEqual(60_000);
    }
  });

  it('add_firewall_rule 模板使用 _verifyComment 而非 comment（防止假阳性）', () => {
    const verifyComment = 'test-rule [brain-op-xyz789]';
    const params: IntentParams = {
      deviceId: 'test-device',
      comment: 'original-comment',
      _verifyComment: verifyComment,
    };

    const directive = VERIFICATION_DIRECTIVE_TEMPLATES['add_firewall_rule'](params);

    // expected_condition 应包含 _verifyComment，不应包含原始 comment
    expect(directive.expected_condition).toContain(verifyComment);
    expect(directive.expected_condition).not.toContain('original-comment');
  });

  it('add_nat_rule 模板使用 _verifyComment 而非 comment（防止假阳性）', () => {
    const verifyComment = 'nat-rule [brain-op-abc456]';
    const params: IntentParams = {
      deviceId: 'test-device',
      comment: 'original-nat-comment',
      _verifyComment: verifyComment,
    };

    const directive = VERIFICATION_DIRECTIVE_TEMPLATES['add_nat_rule'](params);

    expect(directive.expected_condition).toContain(verifyComment);
    expect(directive.expected_condition).not.toContain('original-nat-comment');
  });

  it('disable_interface 和 enable_interface 模板的 expected_condition 语义相反', () => {
    const params: IntentParams = { target: 'ether1', deviceId: 'test-device' };

    const disableDirective = VERIFICATION_DIRECTIVE_TEMPLATES['disable_interface'](params);
    const enableDirective = VERIFICATION_DIRECTIVE_TEMPLATES['enable_interface'](params);

    // disable 期望 disabled=true，enable 期望 disabled=false
    expect(disableDirective.expected_condition).toContain('true');
    expect(enableDirective.expected_condition).toContain('false');

    // 两者的 verify_action 应相同（都查询接口详情）
    expect(disableDirective.verify_action).toBe(enableDirective.verify_action);
  });

  it('add/remove 操作对的 verify_action 应相同', () => {
    const params: IntentParams = { target: '*id*', deviceId: 'test-device' };

    const pairs = [
      ['add_firewall_rule', 'remove_firewall_rule'],
      ['add_nat_rule', 'remove_nat_rule'],
      ['add_dhcp_lease', 'remove_dhcp_lease'],
      ['add_static_route', 'remove_route'],
    ] as const;

    for (const [addAction, removeAction] of pairs) {
      const addDirective = VERIFICATION_DIRECTIVE_TEMPLATES[addAction](params);
      const removeDirective = VERIFICATION_DIRECTIVE_TEMPLATES[removeAction](params);
      expect(addDirective.verify_action).toBe(removeDirective.verify_action);
    }
  });
});
