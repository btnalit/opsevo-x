/**
 * DependencyAnalyzer - 依赖分析器
 * 
 * 分析工具调用之间的依赖关系，确定哪些调用可以并行执行
 * 
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 * - 3.1: 识别数据依赖（输出作为输入）
 * - 3.2: 识别资源依赖（访问同一设备/资源）
 * - 3.3: 使用参数检查检测隐式依赖
 * - 3.4: 分类依赖为硬依赖或软依赖
 * - 3.5: 支持自定义依赖规则
 * - 3.6: 返回可用于构建执行 DAG 的依赖图
 * 
 * @risk DEPENDENCY_ANALYSIS_FALSE_POSITIVE
 * @impact 简单的字符串包含检查可能产生误报，导致不必要的串行执行，降低并行效率
 * @mitigation
 *   1. 使用更精确的参数匹配（如 JSON path）
 *   2. 实现依赖规则的白名单/黑名单
 *   3. 添加依赖分析的置信度评分
 *   4. 允许用户配置自定义依赖规则覆盖默认行为
 */

import { logger } from '../../../utils/logger';
import {
  ToolCall,
  Dependency,
  DependencyGraph,
  DependencyType,
  DependencyStrength,
  DependencyRule,
} from '../../../types/parallel-execution';

/**
 * 依赖分析器配置
 */
export interface DependencyAnalyzerConfig {
  /** 是否启用数据依赖检测 */
  enableDataDependencyDetection: boolean;
  /** 是否启用资源依赖检测 */
  enableResourceDependencyDetection: boolean;
  /** 资源依赖的默认强度 */
  defaultResourceDependencyStrength: DependencyStrength;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: DependencyAnalyzerConfig = {
  enableDataDependencyDetection: true,
  enableResourceDependencyDetection: true,
  defaultResourceDependencyStrength: DependencyStrength.SOFT,
};

/**
 * 已知的数据依赖模式
 * 定义哪些工具的输出可能被其他工具使用
 */
const DATA_DEPENDENCY_PATTERNS: Array<{
  sourceTools: string[];
  targetTools: string[];
  outputFields: string[];
}> = [
  {
    sourceTools: ['device_query'],
    targetTools: ['execute_command', 'device_query'],
    outputFields: ['id', '.id', 'name', 'interface', 'address'],
  },
  {
    sourceTools: ['knowledge_search'],
    targetTools: ['device_query', 'execute_command'],
    outputFields: ['command', 'script', 'config'],
  },
];

/**
 * 资源标识参数名
 * 用于检测资源依赖
 */
const RESOURCE_IDENTIFIER_PARAMS = [
  'device_id',
  'deviceId',
  'device',
  'host',
  'hostname',
  'target',
  'interface',
  'address',
];

/**
 * DependencyAnalyzer 类
 * 分析工具调用之间的依赖关系
 */
export class DependencyAnalyzer {
  private config: DependencyAnalyzerConfig;
  private customRules: DependencyRule[] = [];

  constructor(config?: Partial<DependencyAnalyzerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    logger.debug('DependencyAnalyzer initialized', { config: this.config });
  }

  /**
   * 分析工具调用之间的依赖关系
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.6
   * 
   * @param toolCalls 工具调用列表
   * @returns 依赖图
   */
  analyze(toolCalls: ToolCall[]): DependencyGraph {
    const startTime = Date.now();
    const nodes = toolCalls.map(tc => tc.callId);
    const edges: Dependency[] = [];

    // 检测数据依赖
    if (this.config.enableDataDependencyDetection) {
      const dataDeps = this.detectDataDependencies(toolCalls);
      edges.push(...dataDeps);
    }

    // 检测资源依赖
    if (this.config.enableResourceDependencyDetection) {
      const resourceDeps = this.detectResourceDependencies(toolCalls);
      // 过滤掉已存在的依赖（避免重复）
      for (const dep of resourceDeps) {
        if (!edges.some(e => e.from === dep.from && e.to === dep.to)) {
          edges.push(dep);
        }
      }
    }

    // 应用自定义规则
    const customDeps = this.applyCustomRules(toolCalls);
    for (const dep of customDeps) {
      if (!edges.some(e => e.from === dep.from && e.to === dep.to)) {
        edges.push(dep);
      }
    }

    // 检测环
    const hasCycle = this.detectCycle(nodes, edges);

    // 生成拓扑排序
    const topologicalOrder = hasCycle ? [nodes] : this.topologicalSort(nodes, edges);

    const graph: DependencyGraph = {
      nodes,
      edges,
      hasCycle,
      topologicalOrder,
    };

    logger.debug('Dependency analysis completed', {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      hasCycle,
      stageCount: topologicalOrder.length,
      duration: Date.now() - startTime,
    });

    return graph;
  }

  /**
   * 检测数据依赖
   * Requirements: 3.1, 3.3
   * 
   * @param toolCalls 工具调用列表
   * @returns 数据依赖列表
   */
  detectDataDependencies(toolCalls: ToolCall[]): Dependency[] {
    const dependencies: Dependency[] = [];

    for (let i = 0; i < toolCalls.length; i++) {
      for (let j = i + 1; j < toolCalls.length; j++) {
        const source = toolCalls[i];
        const target = toolCalls[j];

        // 检查是否存在数据依赖模式
        const hasDataDep = this.checkDataDependencyPattern(source, target);
        if (hasDataDep) {
          dependencies.push({
            from: source.callId,
            to: target.callId,
            type: DependencyType.DATA,
            strength: DependencyStrength.HARD, // 数据依赖是硬依赖
            reason: `Tool ${target.toolName} may depend on output from ${source.toolName}`,
          });
        }

        // 检查参数中是否引用了其他调用的输出占位符
        const paramDep = this.checkParameterReferences(source, target);
        if (paramDep && !hasDataDep) {
          dependencies.push({
            from: source.callId,
            to: target.callId,
            type: DependencyType.DATA,
            strength: DependencyStrength.HARD,
            reason: paramDep,
          });
        }
      }
    }

    return dependencies;
  }

  /**
   * 检测资源依赖
   * Requirements: 3.2, 3.3
   * 
   * @param toolCalls 工具调用列表
   * @returns 资源依赖列表
   */
  detectResourceDependencies(toolCalls: ToolCall[]): Dependency[] {
    const dependencies: Dependency[] = [];

    // 按资源标识分组
    const resourceGroups = new Map<string, ToolCall[]>();

    for (const call of toolCalls) {
      const resourceId = this.extractResourceIdentifier(call);
      if (resourceId) {
        const group = resourceGroups.get(resourceId) || [];
        group.push(call);
        resourceGroups.set(resourceId, group);
      }
    }

    // 对于同一资源的调用，创建资源依赖
    for (const [resourceId, calls] of resourceGroups) {
      if (calls.length > 1) {
        // 按调用顺序创建依赖链
        for (let i = 0; i < calls.length - 1; i++) {
          dependencies.push({
            from: calls[i].callId,
            to: calls[i + 1].callId,
            type: DependencyType.RESOURCE,
            strength: this.config.defaultResourceDependencyStrength,
            reason: `Both tools access the same resource: ${resourceId}`,
          });
        }
      }
    }

    return dependencies;
  }

  /**
   * 注册自定义依赖规则
   * Requirements: 3.5
   * 
   * @param rule 依赖规则
   */
  registerCustomRule(rule: DependencyRule): void {
    this.customRules.push(rule);
    logger.debug('Custom dependency rule registered', { ruleName: rule.name });
  }

  /**
   * 清除所有自定义规则
   */
  clearCustomRules(): void {
    this.customRules = [];
  }

  /**
   * 获取已注册的自定义规则
   */
  getCustomRules(): DependencyRule[] {
    return [...this.customRules];
  }

  /**
   * 生成可并行执行的批次
   * Requirements: 3.6
   * 
   * @param graph 依赖图
   * @returns 可并行执行的工具调用 ID 批次
   */
  generateParallelBatches(graph: DependencyGraph): string[][] {
    if (graph.hasCycle) {
      logger.warn('Dependency graph has cycle, returning all nodes as single batch');
      return [graph.nodes];
    }

    // 只考虑硬依赖进行批次划分
    const hardEdges = graph.edges.filter(e => e.strength === DependencyStrength.HARD);
    
    if (hardEdges.length === 0) {
      // 没有硬依赖，所有调用可以并行
      return [graph.nodes];
    }

    // 使用拓扑排序结果作为批次
    return graph.topologicalOrder;
  }

  // ==================== 私有方法 ====================

  /**
   * 检查数据依赖模式
   */
  private checkDataDependencyPattern(source: ToolCall, target: ToolCall): boolean {
    for (const pattern of DATA_DEPENDENCY_PATTERNS) {
      if (
        pattern.sourceTools.includes(source.toolName) &&
        pattern.targetTools.includes(target.toolName)
      ) {
        // 检查目标参数是否可能使用源的输出
        const targetParams = JSON.stringify(target.params).toLowerCase();
        for (const field of pattern.outputFields) {
          if (targetParams.includes(field.toLowerCase())) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 检查参数中的引用
   */
  private checkParameterReferences(source: ToolCall, target: ToolCall): string | null {
    const targetParamsStr = JSON.stringify(target.params);
    
    // 检查是否引用了源调用的 ID
    if (targetParamsStr.includes(source.callId)) {
      return `Target params reference source call ID: ${source.callId}`;
    }

    // 检查是否有占位符模式 {{callId.field}}
    const placeholderPattern = new RegExp(`\\{\\{${source.callId}\\.\\w+\\}\\}`, 'g');
    if (placeholderPattern.test(targetParamsStr)) {
      return `Target params contain placeholder referencing source call`;
    }

    return null;
  }

  /**
   * 提取资源标识符
   */
  private extractResourceIdentifier(call: ToolCall): string | null {
    for (const paramName of RESOURCE_IDENTIFIER_PARAMS) {
      const value = call.params[paramName];
      if (value && typeof value === 'string') {
        return `${paramName}:${value}`;
      }
    }

    // 对于 device_query，使用 command 路径作为资源标识的一部分
    if (call.toolName === 'device_query' && call.params.command) {
      return `device:${String(call.params.command).split('/')[1] || 'default'}`;
    }

    return null;
  }

  /**
   * 应用自定义规则
   */
  private applyCustomRules(toolCalls: ToolCall[]): Dependency[] {
    const dependencies: Dependency[] = [];

    for (const rule of this.customRules) {
      for (let i = 0; i < toolCalls.length; i++) {
        for (let j = 0; j < toolCalls.length; j++) {
          if (i === j) continue;

          const source = toolCalls[i];
          const target = toolCalls[j];

          // 检查工具名称是否匹配
          const sourceMatches = this.matchPattern(source.toolName, rule.sourceToolPattern);
          const targetMatches = this.matchPattern(target.toolName, rule.targetToolPattern);

          if (sourceMatches && targetMatches) {
            // 检查条件函数
            if (!rule.condition || rule.condition(source, target)) {
              dependencies.push({
                from: source.callId,
                to: target.callId,
                type: rule.dependencyType,
                strength: rule.strength,
                reason: `Custom rule: ${rule.name}`,
              });
            }
          }
        }
      }
    }

    return dependencies;
  }

  /**
   * 匹配模式
   */
  private matchPattern(value: string, pattern: string | RegExp): boolean {
    if (typeof pattern === 'string') {
      return value === pattern || value.includes(pattern);
    }
    return pattern.test(value);
  }

  /**
   * 检测环
   */
  private detectCycle(nodes: string[], edges: Dependency[]): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const adjacencyList = new Map<string, string[]>();
    for (const node of nodes) {
      adjacencyList.set(node, []);
    }
    for (const edge of edges) {
      const neighbors = adjacencyList.get(edge.from) || [];
      neighbors.push(edge.to);
      adjacencyList.set(edge.from, neighbors);
    }

    const dfs = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const neighbors = adjacencyList.get(node) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const node of nodes) {
      if (!visited.has(node)) {
        if (dfs(node)) return true;
      }
    }

    return false;
  }

  /**
   * 拓扑排序（Kahn's algorithm）
   * 返回分层结果，每层可以并行执行
   */
  private topologicalSort(nodes: string[], edges: Dependency[]): string[][] {
    // 只考虑硬依赖
    const hardEdges = edges.filter(e => e.strength === DependencyStrength.HARD);

    // 计算入度
    const inDegree = new Map<string, number>();
    const adjacencyList = new Map<string, string[]>();

    for (const node of nodes) {
      inDegree.set(node, 0);
      adjacencyList.set(node, []);
    }

    for (const edge of hardEdges) {
      const currentDegree = inDegree.get(edge.to) || 0;
      inDegree.set(edge.to, currentDegree + 1);
      
      const neighbors = adjacencyList.get(edge.from) || [];
      neighbors.push(edge.to);
      adjacencyList.set(edge.from, neighbors);
    }

    // 分层拓扑排序
    const result: string[][] = [];
    const remaining = new Set(nodes);

    while (remaining.size > 0) {
      // 找出所有入度为 0 的节点
      const currentLevel: string[] = [];
      for (const node of remaining) {
        if ((inDegree.get(node) || 0) === 0) {
          currentLevel.push(node);
        }
      }

      if (currentLevel.length === 0) {
        // 存在环，将剩余节点作为一个批次
        result.push([...remaining]);
        break;
      }

      result.push(currentLevel);

      // 移除当前层节点，更新入度
      for (const node of currentLevel) {
        remaining.delete(node);
        const neighbors = adjacencyList.get(node) || [];
        for (const neighbor of neighbors) {
          const degree = inDegree.get(neighbor) || 0;
          inDegree.set(neighbor, degree - 1);
        }
      }
    }

    return result;
  }
}

// 导出单例实例
export const dependencyAnalyzer = new DependencyAnalyzer();
