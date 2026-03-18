/**
 * APISafety 模块 - API 路径安全规则
 *
 * 内联 Top 20 高频 API 路径，按风险等级（高危/中等/低危）分组，
 * 并在末尾包含知识库查询指引。
 *
 * @see Requirements 2.1 - 仅内联 Top 20 高频 API 路径，按风险等级分为三组
 * @see Requirements 2.2 - 在内联路径列表末尾包含指引文本"完整路径参考请查询知识库"
 * @see Requirements 2.3 - API 路径引用部分 Token 数不超过 300
 */

import { PromptModule } from '../types';

/**
 * API 路径风险等级
 */
export enum RiskLevel {
  HIGH = 'high',     // 🔴 高危：可能导致服务中断
  MEDIUM = 'medium', // 🟡 中等：可能影响性能
  LOW = 'low',       // 🟢 低危：只读查询
}

/**
 * API 路径条目
 */
export interface APIPathEntry {
  path: string;
  riskLevel: RiskLevel;
  description: string;
  queryHints?: string;
}

/** Top 20 高频 API 路径 */
export const TOP_API_PATHS: APIPathEntry[] = [
  // 🔴 高危
  { path: '/ip/firewall/filter', riskLevel: RiskLevel.HIGH, description: '防火墙规则', queryHints: 'limit=20, proplist=chain,action,src-address,dst-address,comment' },
  { path: '/ip/firewall/nat', riskLevel: RiskLevel.HIGH, description: 'NAT 规则', queryHints: 'limit=20' },
  { path: '/ip/firewall/connection', riskLevel: RiskLevel.HIGH, description: '连接跟踪', queryHints: 'limit=10, proplist=src-address,dst-address,protocol,state' },
  { path: '/system/scheduler', riskLevel: RiskLevel.HIGH, description: '计划任务' },
  { path: '/system/script', riskLevel: RiskLevel.HIGH, description: '系统脚本' },
  { path: '/user', riskLevel: RiskLevel.HIGH, description: '用户管理' },
  // 🟡 中等
  { path: '/ip/route', riskLevel: RiskLevel.MEDIUM, description: '路由表' },
  { path: '/routing/ospf/instance', riskLevel: RiskLevel.MEDIUM, description: 'OSPF 实例' },
  { path: '/routing/bgp/connection', riskLevel: RiskLevel.MEDIUM, description: 'BGP 连接' },
  { path: '/ip/dhcp-server/lease', riskLevel: RiskLevel.MEDIUM, description: 'DHCP 租约', queryHints: 'limit=50' },
  { path: '/queue/simple', riskLevel: RiskLevel.MEDIUM, description: '简单队列' },
  { path: '/ip/dns', riskLevel: RiskLevel.MEDIUM, description: 'DNS 设置' },
  { path: '/log', riskLevel: RiskLevel.MEDIUM, description: '系统日志', queryHints: 'limit=20' },
  // 🟢 低危
  { path: '/interface', riskLevel: RiskLevel.LOW, description: '接口列表' },
  { path: '/ip/address', riskLevel: RiskLevel.LOW, description: 'IP 地址' },
  { path: '/system/resource', riskLevel: RiskLevel.LOW, description: '系统资源' },
  { path: '/system/identity', riskLevel: RiskLevel.LOW, description: '系统标识' },
  { path: '/system/package', riskLevel: RiskLevel.LOW, description: '系统包' },
  { path: '/system/health', riskLevel: RiskLevel.LOW, description: '系统健康' },
  { path: '/routing/ospf/neighbor', riskLevel: RiskLevel.LOW, description: 'OSPF 邻居' },
];

/**
 * 风险等级配置：emoji 和标题
 */
const RISK_LEVEL_CONFIG: Record<RiskLevel, { emoji: string; label: string }> = {
  [RiskLevel.HIGH]: { emoji: '🔴', label: '高危（可能导致服务中断）' },
  [RiskLevel.MEDIUM]: { emoji: '🟡', label: '中等（可能影响性能）' },
  [RiskLevel.LOW]: { emoji: '🟢', label: '低危（只读查询）' },
};

/**
 * 按风险等级分组 API 路径
 */
function groupByRiskLevel(paths: APIPathEntry[]): Record<RiskLevel, APIPathEntry[]> {
  const groups: Record<RiskLevel, APIPathEntry[]> = {
    [RiskLevel.HIGH]: [],
    [RiskLevel.MEDIUM]: [],
    [RiskLevel.LOW]: [],
  };

  for (const entry of paths) {
    groups[entry.riskLevel].push(entry);
  }

  return groups;
}

/**
 * 格式化单个 API 路径条目
 */
function formatPathEntry(entry: APIPathEntry): string {
  const hints = entry.queryHints ? ` (${entry.queryHints})` : '';
  return `- ${entry.path} - ${entry.description}${hints}`;
}

/**
 * APISafety PromptModule
 *
 * 生成按风险等级分组的 Top 20 高频 API 路径列表，
 * 末尾包含知识库查询指引。
 */
export const apiSafety: PromptModule = {
  name: 'APISafety',
  tokenBudget: 300,
  dependencies: [],
  templateName: '[模块化] APISafety - API 安全规则',
  render(): string {
    const groups = groupByRiskLevel(TOP_API_PATHS);
    const sections: string[] = ['## API 路径安全参考'];

    // 按风险等级顺序渲染：高危 → 中等 → 低危
    const riskOrder: RiskLevel[] = [RiskLevel.HIGH, RiskLevel.MEDIUM, RiskLevel.LOW];

    for (const level of riskOrder) {
      const config = RISK_LEVEL_CONFIG[level];
      const entries = groups[level];
      if (entries.length > 0) {
        sections.push(`### ${config.emoji} ${config.label}`);
        sections.push(entries.map(formatPathEntry).join('\n'));
      }
    }

    // 知识库指引
    sections.push('> 完整路径参考请查询知识库');

    return sections.join('\n\n');
  },
};
