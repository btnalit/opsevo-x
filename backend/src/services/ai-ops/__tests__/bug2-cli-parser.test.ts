/**
 * Bug 2: CLI 到 API 格式转换边界错误 — 单元测试
 * 
 * 验证:
 * - 引号参数正确解析
 * - where 复合条件正确转换
 * - 完整 CLI 命令自动检测和转换
 * - 特殊字符参数值正确处理
 * - 简单 key=value 命令继续正确转换（保持检查）
 */

import { convertToApiFormat, isFullCliCommand } from '../../../utils/routerosCliParser';

describe('Bug 2: CLI 到 API 格式转换', () => {
  // ==================== Task 2.7.1 ====================
  describe('引号参数解析', () => {
    it('双引号参数值应去除引号', () => {
      const result = convertToApiFormat('/interface comment add comment="my comment" disabled=no');
      const commentParam = result.params.find(p => p.includes('comment='));
      expect(commentParam).toBe('=comment=my comment');
    });

    it('单引号参数值应去除引号', () => {
      const result = convertToApiFormat("/ip address add address='192.168.1.1/24'");
      const addrParam = result.params.find(p => p.includes('address='));
      expect(addrParam).toBe('=address=192.168.1.1/24');
    });

    it('引号内包含空格的参数应保持完整', () => {
      const result = convertToApiFormat('/system identity set name="My Router Name"');
      const nameParam = result.params.find(p => p.includes('name='));
      expect(nameParam).toBe('=name=My Router Name');
    });
  });

  // ==================== Task 2.7.2 ====================
  describe('where 复合条件', () => {
    it('and 条件应转换为多个查询参数', () => {
      const result = convertToApiFormat('/ip firewall filter print where src-address=192.168.1.0/24 and protocol=tcp');
      expect(result.apiCommand).toBe('/ip/firewall/filter/print');
      expect(result.params).toContain('?src-address=192.168.1.0/24');
      expect(result.params).toContain('?protocol=tcp');
      // and 条件不应插入 ?#| 运算符
      expect(result.params).not.toContain('?#|');
    });

    it('or 条件应转换为带 ?#| 运算符的查询参数', () => {
      const result = convertToApiFormat('/interface print where type=ether or type=vlan');
      expect(result.apiCommand).toBe('/interface/print');
      expect(result.params).toEqual(['?type=ether', '?#|', '?type=vlan']);
    });

    it('多个 or 条件应正确插入多个 ?#| 运算符', () => {
      const result = convertToApiFormat('/ip firewall filter print where action=drop or action=reject or action=tarpit');
      expect(result.apiCommand).toBe('/ip/firewall/filter/print');
      expect(result.params).toEqual(['?action=drop', '?#|', '?action=reject', '?#|', '?action=tarpit']);
    });

    it('单个 where 条件应正确转换', () => {
      const result = convertToApiFormat('/ip address print where interface=ether1');
      expect(result.apiCommand).toBe('/ip/address/print');
      expect(result.params).toContain('?interface=ether1');
    });
  });

  // ==================== Task 2.7.3 ====================
  describe('完整 CLI 命令自动检测', () => {
    it('isFullCliCommand 应检测完整 CLI 格式', () => {
      expect(isFullCliCommand('/ip/address/add address=192.168.1.1/24 interface=ether1')).toBe(true);
      expect(isFullCliCommand('/system identity set name=router1')).toBe(true);
    });

    it('isFullCliCommand 应排除纯路径命令', () => {
      expect(isFullCliCommand('/ip/address/print')).toBe(false);
      expect(isFullCliCommand('/system/resource/print')).toBe(false);
    });

    it('isFullCliCommand 应排除非路径字符串', () => {
      expect(isFullCliCommand('name=value')).toBe(false);
      expect(isFullCliCommand('simple command')).toBe(false);
    });

    it('完整 CLI 命令应正确分离路径和参数', () => {
      const result = convertToApiFormat('/ip/address/add address=192.168.1.1/24 interface=ether1');
      expect(result.apiCommand).toBe('/ip/address/add');
      expect(result.params).toContain('=address=192.168.1.1/24');
      expect(result.params).toContain('=interface=ether1');
    });
  });

  // ==================== Task 2.7.4 ====================
  describe('特殊字符参数值', () => {
    it('参数值包含 / 应正确处理', () => {
      const result = convertToApiFormat('/ip address add address=192.168.1.1/24');
      const addrParam = result.params.find(p => p.includes('address='));
      expect(addrParam).toBe('=address=192.168.1.1/24');
    });

    it('参数值包含 = 应使用第一个 = 作为分隔符', () => {
      const result = convertToApiFormat('/system script add source="if (x=1) { }"');
      const sourceParam = result.params.find(p => p.startsWith('=source='));
      expect(sourceParam).toBe('=source=if (x=1) { }');
    });
  });

  // ==================== Task 2.7.5 ====================
  describe('简单命令保持检查', () => {
    it('简单 key=value 命令应正确转换', () => {
      const result = convertToApiFormat('/ip address add address=192.168.1.1/24 interface=ether1');
      expect(result.apiCommand).toBe('/ip/address/add');
      expect(result.params.length).toBe(2);
    });

    it('纯路径命令应正确转换', () => {
      const result = convertToApiFormat('/system resource print');
      expect(result.apiCommand).toBe('/system/resource/print');
      expect(result.params.length).toBe(0);
    });

    it('CLI 修饰符应被忽略', () => {
      const result = convertToApiFormat('/interface print detail');
      expect(result.apiCommand).toBe('/interface/print');
      expect(result.params.length).toBe(0);
    });

    it('空格分隔的路径应正确组合', () => {
      const result = convertToApiFormat('/ip address print');
      expect(result.apiCommand).toBe('/ip/address/print');
    });
  });

  // ==================== Task 2.7.6 ====================
  describe('alertEngine 替换后行为一致性', () => {
    it('共享函数应与原 alertEngine 实现行为一致（简单命令）', () => {
      // 原 alertEngine 的 convertToApiFormat 对简单命令的行为
      const result = convertToApiFormat('/ip address add address=10.0.0.1/24');
      expect(result.apiCommand).toBe('/ip/address/add');
      // 原实现: params.push(`=${part}`) → `=address=10.0.0.1/24`
      // 新实现: 通过 parseKeyValue 去引号后 `=address=10.0.0.1/24`
      expect(result.params).toContain('=address=10.0.0.1/24');
    });

    it('共享函数应与原 alertEngine 实现行为一致（where 子句）', () => {
      const result = convertToApiFormat('/interface print where name=ether1');
      expect(result.apiCommand).toBe('/interface/print');
      // 原实现: params.push(`?${part}`) → `?name=ether1`
      // 新实现: 通过 parseKeyValue 去引号后 `?name=ether1`
      expect(result.params).toContain('?name=ether1');
    });
  });
});
