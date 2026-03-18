/**
 * SynonymExpander - 同义词扩展器
 * 
 * 扩展查询中的关键词，提高知识检索的召回率。
 * 支持内置字典、自定义同义词和从反馈学习。
 * 
 * Requirements: 3.2
 * - 支持同义词扩展（如 "网络不通" -> "连接失败/断网/丢包"）
 */

import { logger } from '../../../utils/logger';
import { SynonymExpansion, SynonymDictionary } from '../../../types/fast-path';

// ==================== 内置同义词字典 ====================

/**
 * 网络运维领域同义词字典
 */
const NETWORK_OPS_SYNONYMS: Record<string, string[]> = {
  // 网络连接问题
  '网络不通': ['连接失败', '断网', '丢包', '网络中断', '无法连接', '网络故障'],
  '连接失败': ['网络不通', '断网', '连接超时', '无法连接', '连接中断'],
  '断网': ['网络不通', '连接失败', '网络中断', '掉线', '离线'],
  '丢包': ['网络不通', '数据包丢失', '包丢失', '丢失数据包'],
  '延迟高': ['延迟大', '响应慢', '网络慢', '高延迟', 'ping高'],
  '网络慢': ['延迟高', '带宽不足', '速度慢', '传输慢'],
  
  // 设备状态
  '离线': ['断网', '掉线', '不在线', '无法访问', '失联'],
  '在线': ['连接正常', '正常运行', '可访问'],
  '重启': ['重新启动', '重新开机', '重启设备', 'reboot'],
  '宕机': ['崩溃', '死机', '停机', '故障', '不可用'],
  
  // 性能问题
  'CPU高': ['CPU使用率高', 'CPU占用高', 'CPU负载高', '处理器繁忙'],
  '内存高': ['内存使用率高', '内存占用高', '内存不足', '内存溢出'],
  '负载高': ['高负载', '系统繁忙', '资源紧张', '过载'],
  '流量大': ['带宽占用高', '流量高', '数据量大', '传输量大'],
  
  // 配置相关
  '配置': ['设置', '参数', '选项', '设定'],
  '设置': ['配置', '参数', '选项', '设定'],
  '规则': ['策略', '条件', '过滤器', '规则集'],
  '策略': ['规则', '条件', '方案', '政策'],
  
  // 接口相关
  '接口': ['端口', '网口', 'interface', '网卡'],
  '端口': ['接口', '网口', 'port', '端口号'],
  'IP地址': ['IP', '地址', 'IP地址', '网络地址'],
  'MAC地址': ['MAC', '物理地址', '硬件地址'],
  
  // 防火墙相关
  '防火墙': ['firewall', '安全策略', '访问控制'],
  'NAT': ['地址转换', '网络地址转换', '端口映射'],
  '端口映射': ['NAT', '端口转发', '映射'],
  '访问控制': ['ACL', '权限控制', '访问限制'],
  
  // 路由相关
  '路由': ['route', '路由表', '路由规则'],
  '网关': ['gateway', '默认网关', '出口'],
  '静态路由': ['手动路由', '固定路由'],
  '动态路由': ['自动路由', 'OSPF', 'BGP'],
  
  // VLAN相关
  'VLAN': ['虚拟局域网', '虚拟网络', 'vlan'],
  '子网': ['网段', '子网络', 'subnet'],
  
  // 告警相关
  '告警': ['警告', '报警', '异常', 'alert'],
  '异常': ['告警', '错误', '故障', '问题'],
  '错误': ['异常', '故障', '失败', 'error'],
  
  // 操作相关
  '查看': ['检查', '显示', '获取', '查询'],
  '修改': ['更改', '编辑', '更新', '变更'],
  '删除': ['移除', '清除', '去掉', '取消'],
  '添加': ['新增', '创建', '增加', '加入'],
  
  // 问题解决
  '解决': ['处理', '修复', '解决方案', '修正'],
  '修复': ['解决', '修正', '恢复', '修补'],
  '排查': ['诊断', '排障', '故障排除', '检查'],
  '诊断': ['排查', '分析', '检测', '判断'],
};

// ==================== SynonymExpander 类 ====================

/**
 * SynonymExpander 配置
 */
export interface SynonymExpanderConfig {
  /** 是否启用内置字典 */
  useBuiltinDictionary: boolean;
  /** 最大同义词数量 */
  maxSynonyms: number;
  /** 学习的同义词持久化路径 */
  learnedSynonymsPath?: string;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: SynonymExpanderConfig = {
  useBuiltinDictionary: true,
  maxSynonyms: 10,
};

/**
 * SynonymExpander 类
 * 
 * 同义词扩展器，支持内置字典、自定义同义词和从反馈学习。
 */
export class SynonymExpander {
  private config: SynonymExpanderConfig;
  private customSynonyms: Map<string, Set<string>> = new Map();
  private learnedSynonyms: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<SynonymExpanderConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.info('SynonymExpander created', { config: this.config });
  }

  /**
   * 扩展单个词的同义词
   * 
   * @param term 原始词
   * @returns 同义词扩展结果
   */
  expand(term: string): SynonymExpansion {
    const normalizedTerm = term.trim().toLowerCase();
    const synonyms: string[] = [];
    let source: SynonymExpansion['source'] = 'dictionary';

    // 1. 检查自定义同义词
    const customSet = this.customSynonyms.get(normalizedTerm);
    if (customSet && customSet.size > 0) {
      synonyms.push(...customSet);
      source = 'dictionary';
    }

    // 2. 检查学习的同义词
    const learnedSet = this.learnedSynonyms.get(normalizedTerm);
    if (learnedSet && learnedSet.size > 0) {
      synonyms.push(...learnedSet);
      source = 'learned';
    }

    // 3. 检查内置字典
    if (this.config.useBuiltinDictionary) {
      // 精确匹配
      const builtinSynonyms = NETWORK_OPS_SYNONYMS[term] || NETWORK_OPS_SYNONYMS[normalizedTerm];
      if (builtinSynonyms) {
        synonyms.push(...builtinSynonyms);
        if (source === 'dictionary') source = 'dictionary';
      }

      // 部分匹配（检查是否包含关键词）
      for (const [key, values] of Object.entries(NETWORK_OPS_SYNONYMS)) {
        if (normalizedTerm.includes(key.toLowerCase()) || key.toLowerCase().includes(normalizedTerm)) {
          if (key.toLowerCase() !== normalizedTerm) {
            synonyms.push(...values.slice(0, 3)); // 部分匹配只取前3个
          }
        }
      }
    }

    // 去重并限制数量
    const uniqueSynonyms = [...new Set(synonyms)]
      .filter(s => s.toLowerCase() !== normalizedTerm)
      .slice(0, this.config.maxSynonyms);

    return {
      original: term,
      synonyms: uniqueSynonyms,
      source,
    };
  }

  /**
   * 批量扩展同义词
   * 
   * @param terms 词列表
   * @returns 同义词扩展结果列表
   */
  expandBatch(terms: string[]): SynonymExpansion[] {
    return terms.map(term => this.expand(term));
  }

  /**
   * 扩展查询中的所有关键词
   * 
   * @param query 查询字符串
   * @returns 扩展后的关键词列表
   */
  expandQuery(query: string): { original: string; expanded: string[]; expansions: SynonymExpansion[] } {
    const expansions: SynonymExpansion[] = [];
    const expanded: string[] = [];

    // 检查查询中是否包含已知的同义词键
    const allKeys = [
      ...Object.keys(NETWORK_OPS_SYNONYMS),
      ...this.customSynonyms.keys(),
      ...this.learnedSynonyms.keys(),
    ];

    for (const key of allKeys) {
      if (query.toLowerCase().includes(key.toLowerCase())) {
        const expansion = this.expand(key);
        if (expansion.synonyms.length > 0) {
          expansions.push(expansion);
          expanded.push(...expansion.synonyms);
        }
      }
    }

    return {
      original: query,
      expanded: [...new Set(expanded)],
      expansions,
    };
  }

  /**
   * 添加自定义同义词
   * 
   * @param term 原始词
   * @param synonyms 同义词列表
   */
  addSynonyms(term: string, synonyms: string[]): void {
    const normalizedTerm = term.trim().toLowerCase();
    
    if (!this.customSynonyms.has(normalizedTerm)) {
      this.customSynonyms.set(normalizedTerm, new Set());
    }
    
    const set = this.customSynonyms.get(normalizedTerm)!;
    for (const synonym of synonyms) {
      set.add(synonym.trim());
    }

    logger.info('Added custom synonyms', { term, count: synonyms.length });
  }

  /**
   * 移除自定义同义词
   * 
   * @param term 原始词
   * @param synonyms 要移除的同义词列表（可选，不提供则移除所有）
   */
  removeSynonyms(term: string, synonyms?: string[]): void {
    const normalizedTerm = term.trim().toLowerCase();
    
    if (!this.customSynonyms.has(normalizedTerm)) {
      return;
    }

    if (synonyms) {
      const set = this.customSynonyms.get(normalizedTerm)!;
      for (const synonym of synonyms) {
        set.delete(synonym.trim());
      }
      if (set.size === 0) {
        this.customSynonyms.delete(normalizedTerm);
      }
    } else {
      this.customSynonyms.delete(normalizedTerm);
    }

    logger.info('Removed custom synonyms', { term, synonyms });
  }

  /**
   * 从反馈学习同义词
   * 当用户使用某个词成功找到了相关知识，记录这个关联
   * 
   * @param original 原始查询词
   * @param successful 成功匹配的词
   */
  learnFromFeedback(original: string, successful: string): void {
    const normalizedOriginal = original.trim().toLowerCase();
    const normalizedSuccessful = successful.trim().toLowerCase();

    if (normalizedOriginal === normalizedSuccessful) {
      return; // 相同的词不需要学习
    }

    if (!this.learnedSynonyms.has(normalizedOriginal)) {
      this.learnedSynonyms.set(normalizedOriginal, new Set());
    }

    this.learnedSynonyms.get(normalizedOriginal)!.add(successful.trim());

    // 双向学习
    if (!this.learnedSynonyms.has(normalizedSuccessful)) {
      this.learnedSynonyms.set(normalizedSuccessful, new Set());
    }
    this.learnedSynonyms.get(normalizedSuccessful)!.add(original.trim());

    logger.info('Learned synonym from feedback', { original, successful });
  }

  /**
   * 获取所有自定义同义词
   */
  getCustomSynonyms(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, set] of this.customSynonyms) {
      result[key] = [...set];
    }
    return result;
  }

  /**
   * 获取所有学习的同义词
   */
  getLearnedSynonyms(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, set] of this.learnedSynonyms) {
      result[key] = [...set];
    }
    return result;
  }

  /**
   * 清除学习的同义词
   */
  clearLearnedSynonyms(): void {
    this.learnedSynonyms.clear();
    logger.info('Cleared all learned synonyms');
  }

  /**
   * 获取内置字典
   */
  getBuiltinDictionary(): Record<string, string[]> {
    return { ...NETWORK_OPS_SYNONYMS };
  }

  /**
   * 获取配置
   */
  getConfig(): SynonymExpanderConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SynonymExpanderConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('SynonymExpander config updated', { config: this.config });
  }

  /**
   * 导出所有同义词数据（用于持久化）
   */
  exportData(): SynonymDictionary {
    return {
      id: 'synonym-expander-data',
      name: 'SynonymExpander Data',
      mappings: {
        ...this.getCustomSynonyms(),
        ...this.getLearnedSynonyms(),
      },
      domain: 'network-ops',
      updatedAt: Date.now(),
    };
  }

  /**
   * 导入同义词数据
   */
  importData(data: SynonymDictionary): void {
    for (const [term, synonyms] of Object.entries(data.mappings)) {
      this.addSynonyms(term, synonyms);
    }
    logger.info('Imported synonym data', { count: Object.keys(data.mappings).length });
  }
}

// 导出单例实例
export const synonymExpander = new SynonymExpander();
