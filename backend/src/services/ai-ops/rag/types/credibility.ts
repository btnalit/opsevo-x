/**
 * 可信度计算类型定义
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { KnowledgeEntry } from '../knowledgeBase';
import { KnowledgeSource } from './intelligentRetrieval';

// ==================== 可信度权重类型 ====================

/**
 * 可信度计算权重
 * Requirements: 4.1
 * 
 * 优化后的权重分配：
 * - 反馈评分 40% -> 30%：用户反馈仍然重要，但不应过度依赖
 * - 使用频率 30% -> 10%：降低权重，避免新知识被忽视
 * - 时效性 20% -> 15%：保持适度权重
 * - 来源权重 10% -> 25%：提高权重，manual 类型应该被重视
 * - 新增内容质量 0% -> 20%：检测是否包含具体方案
 */
export interface CredibilityWeights {
  /** 反馈评分权重，默认 0.3 */
  feedbackWeight: number;
  /** 使用频率权重，默认 0.1 */
  usageWeight: number;
  /** 时效性权重，默认 0.15 */
  recencyWeight: number;
  /** 来源权重，默认 0.25 */
  sourceWeight: number;
  /** 内容质量权重，默认 0.2 */
  contentQualityWeight: number;
}

/**
 * 默认可信度权重
 */
export const DEFAULT_CREDIBILITY_WEIGHTS: CredibilityWeights = {
  feedbackWeight: 0.3,
  usageWeight: 0.1,
  recencyWeight: 0.15,
  sourceWeight: 0.25,
  contentQualityWeight: 0.2,
};

// ==================== 来源权重映射 ====================

/**
 * 来源权重映射
 * Requirements: 4.2
 * 
 * 优化：提高 manual（用户手动添加）的权重
 * - official_doc: 官方文档，最高可信度
 * - manual: 用户手动添加的知识，通常是经过验证的方案
 * - historical_case: 历史案例，有参考价值
 * - user_feedback: 用户反馈，需要验证
 * - auto_generated: 自动生成，可信度较低
 */
export const SOURCE_WEIGHTS: Record<KnowledgeSource | 'manual', number> = {
  official_doc: 1.0,
  manual: 0.9,        // 新增：用户手动添加的知识
  historical_case: 0.7,
  user_feedback: 0.5,
  auto_generated: 0.3,
};

// ==================== 内容质量指标 ====================

/**
 * 设备命令路径列表
 * 用于检测知识是否包含具体的设备配置命令
 * 
 * 注意：这些是完整的命令路径前缀，用于精确匹配
 */
export const DEVICE_COMMAND_PATHS = [
  // IP 相关
  '/ip/address',
  '/ip/route',
  '/ip/firewall',
  '/ip/dns',
  '/ip/dhcp-server',
  '/ip/dhcp-client',
  '/ip/pool',
  '/ip/arp',
  '/ip/neighbor',
  '/ip/service',
  '/ip/settings',
  '/ip/traffic-flow',
  '/ip/upnp',
  '/ip/cloud',
  '/ip/hotspot',
  '/ip/ipsec',
  '/ip/kid-control',
  '/ip/proxy',
  '/ip/smb',
  '/ip/socks',
  '/ip/ssh',
  '/ip/tftp',
  '/ip/vrf',
  
  // 接口相关
  '/interface/bridge',
  '/interface/bonding',
  '/interface/ethernet',
  '/interface/vlan',
  '/interface/vxlan',
  '/interface/wireguard',
  '/interface/wireless',
  '/interface/pppoe-client',
  '/interface/pppoe-server',
  '/interface/pptp-client',
  '/interface/pptp-server',
  '/interface/l2tp-client',
  '/interface/l2tp-server',
  '/interface/ovpn-client',
  '/interface/ovpn-server',
  '/interface/sstp-client',
  '/interface/sstp-server',
  '/interface/gre',
  '/interface/eoip',
  '/interface/ipip',
  '/interface/veth',
  '/interface/list',
  
  // 路由相关
  '/routing/bgp',
  '/routing/ospf',
  '/routing/rip',
  '/routing/filter',
  '/routing/table',
  '/routing/rule',
  '/routing/id',
  
  // 系统相关
  '/system/resource',
  '/system/identity',
  '/system/clock',
  '/system/ntp',
  '/system/scheduler',
  '/system/script',
  '/system/logging',
  '/system/package',
  '/system/routerboard',
  '/system/health',
  '/system/license',
  '/system/note',
  '/system/upgrade',
  '/system/backup',
  '/system/reset-configuration',
  
  // 队列和流量控制
  '/queue/simple',
  '/queue/tree',
  '/queue/type',
  '/queue/interface',
  
  // 工具
  '/tool/bandwidth-server',
  '/tool/bandwidth-test',
  '/tool/email',
  '/tool/fetch',
  '/tool/graphing',
  '/tool/mac-server',
  '/tool/netwatch',
  '/tool/ping',
  '/tool/profile',
  '/tool/romon',
  '/tool/sms',
  '/tool/sniffer',
  '/tool/torch',
  '/tool/traceroute',
  '/tool/traffic-generator',
  '/tool/traffic-monitor',
  
  // 用户和权限
  '/user',
  '/user/group',
  '/user/active',
  '/user/ssh-keys',
  
  // 证书
  '/certificate',
  
  // 文件
  '/file',
  
  // 日志
  '/log',
  
  // 容器
  '/container',
  '/container/config',
  '/container/envs',
  '/container/mounts',
  
  // MPLS
  '/mpls',
  '/mpls/ldp',
  '/mpls/traffic-eng',
  
  // IPv6
  '/ipv6/address',
  '/ipv6/route',
  '/ipv6/firewall',
  '/ipv6/dhcp-client',
  '/ipv6/dhcp-server',
  '/ipv6/nd',
  '/ipv6/neighbor',
  '/ipv6/pool',
  '/ipv6/settings',
  
  // RADIUS
  '/radius',
  '/radius/incoming',
  
  // SNMP
  '/snmp',
  '/snmp/community',
  
  // 端口
  '/port',
  
  // PPP
  '/ppp/profile',
  '/ppp/secret',
  '/ppp/active',
  '/ppp/aaa',
  
  // 特殊命令（print, add, set, remove 等操作）
  ':put',
  ':log',
  ':delay',
  ':foreach',
  ':if',
  ':while',
  ':do',
  ':local',
  ':global',
  ':set',
  ':execute',
  ':parse',
  ':resolve',
  ':toarray',
  ':toip',
  ':tonum',
  ':tostr',
  ':typeof',
  ':len',
  ':pick',
  ':find',
  ':environment',
  ':terminal',
  ':beep',
];

/**
 * 内容质量指标关键词
 * 用于检测知识是否包含具体方案/步骤
 */
export const CONTENT_QUALITY_INDICATORS = {
  /** 高质量指标：包含具体步骤或命令 */
  highQuality: [
    // 设备命令路径会单独检测，这里放通用指标
    '步骤', '方法', '方案', '解决', '配置',           // 方案关键词
    'step', 'solution', 'fix', 'configure',          // 英文关键词
    '```',                                            // 代码块
    'print', 'add', 'set', 'remove', 'disable', 'enable',  // 设备操作
  ],
  /** 中等质量指标：包含解释或说明 */
  mediumQuality: [
    '原因', '分析', '说明', '注意', '建议',
    'because', 'reason', 'note', 'recommend',
  ],
};

// ==================== 反馈类型 ====================

/**
 * 反馈类型
 * Requirements: 4.5
 */
export type FeedbackType = 'positive' | 'negative' | 'neutral';

/**
 * 反馈分数映射
 */
export const FEEDBACK_SCORES: Record<FeedbackType, number> = {
  positive: 1.0,
  negative: -0.5,
  neutral: 0,
};

// ==================== 带可信度的知识条目 ====================

/**
 * 可信度等级
 * Requirements: 4.3
 */
export type CredibilityLevel = 'high' | 'medium' | 'low';

/**
 * 带可信度评分的知识条目
 * Requirements: 4.1, 4.3
 */
export interface ScoredKnowledgeEntry extends KnowledgeEntry {
  /** 可信度分数 (0-1) */
  credibilityScore: number;
  /** 可信度等级 */
  credibilityLevel: CredibilityLevel;
}

// ==================== 可信度计算配置 ====================

/**
 * 可信度计算配置
 */
export interface CredibilityConfig {
  /** 权重配置 */
  weights: CredibilityWeights;
  /** 低可信度阈值，默认 0.4（提高阈值，更严格） */
  lowCredibilityThreshold: number;
  /** 高可信度阈值，默认 0.7 */
  highCredibilityThreshold: number;
  /** 来源权重映射 */
  sourceWeights: Record<KnowledgeSource | 'manual', number>;
  /** 时效性计算最大时间范围（毫秒），默认 180 天 */
  maxAgeMs: number;
  /** 最大使用次数（用于归一化），默认 50（降低，让使用次数更快达到满分） */
  maxUsageCount: number;
  /** 最大反馈分数（用于归一化），默认 5 */
  maxFeedbackScore: number;
  /** 新知识基础分（没有反馈时的默认分数），默认 0.6 */
  newKnowledgeBaseScore: number;
}

/**
 * 默认可信度计算配置
 */
export const DEFAULT_CREDIBILITY_CONFIG: CredibilityConfig = {
  weights: DEFAULT_CREDIBILITY_WEIGHTS,
  lowCredibilityThreshold: 0.4,
  highCredibilityThreshold: 0.7,
  sourceWeights: SOURCE_WEIGHTS,
  maxAgeMs: 180 * 24 * 60 * 60 * 1000, // 180 天（延长有效期）
  maxUsageCount: 50,
  maxFeedbackScore: 5,
  newKnowledgeBaseScore: 0.6,  // 新知识默认 60% 可信度
};

// ==================== 可信度计算输入 ====================

/**
 * 可信度计算输入
 */
export interface CredibilityInput {
  /** 反馈评分 (原始值) */
  feedbackScore: number;
  /** 反馈数量 */
  feedbackCount: number;
  /** 使用次数 */
  usageCount: number;
  /** 创建/更新时间戳 */
  timestamp: number;
  /** 来源类型 */
  sourceType: KnowledgeSource | 'manual';
  /** 内容（用于质量评估） */
  content?: string;
}

/**
 * 可信度计算详情
 */
export interface CredibilityDetails {
  /** 最终可信度分数 */
  score: number;
  /** 可信度等级 */
  level: CredibilityLevel;
  /** 各分量分数 */
  components: {
    /** 归一化后的反馈分数 */
    normalizedFeedback: number;
    /** 归一化后的使用频率分数 */
    normalizedUsage: number;
    /** 时效性分数 */
    recencyScore: number;
    /** 来源权重 */
    sourceWeight: number;
    /** 内容质量分数 */
    contentQualityScore: number;
  };
  /** 计算时间戳 */
  calculatedAt: number;
}
