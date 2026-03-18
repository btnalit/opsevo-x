/**
 * Skill Capsule 类型定义
 * 
 * Skill Capsule 是自包含的技能胶囊单元，将技能的元数据、能力描述、
 * 执行逻辑、依赖声明封装为标准化单元。
 * 
 * Requirements: E1.1, E1.2
 * - E1.1: 定义标准化 Skill_Capsule 规范（JSON Schema）
 * - E1.2: 支持声明依赖关系和健康检查
 */

/**
 * Skill Capsule 运行时类型
 */
export type SkillCapsuleRuntime = 'node' | 'python' | 'bash';

/**
 * Skill Capsule 依赖声明
 */
export interface SkillCapsuleDependency {
  /** 依赖名称 */
  name: string;
  /** 依赖版本 */
  version: string;
  /** 依赖类型 */
  type: 'npm' | 'pip' | 'system';
}

/**
 * Skill Capsule 健康检查配置
 * Requirements: E1.2
 */
export interface SkillCapsuleHealthCheck {
  /** 健康检查端点（相对路径或命令） */
  endpoint: string;
  /** 检查间隔（毫秒），默认 60000 */
  intervalMs: number;
}

/**
 * JSON Schema 简化表示（用于 inputSchema / outputSchema）
 */
export interface JsonSchemaDefinition {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  description?: string;
  [key: string]: unknown;
}

/**
 * Skill Capsule 规范
 * 
 * Requirements: E1.1, E1.2
 * 
 * JSON Schema 必填字段: id, name, version, description, capabilities,
 *   inputSchema, outputSchema, runtime, entrypoint
 * 可选字段: dependencies, healthCheck
 */
export interface SkillCapsule {
  /** 唯一标识符 (UUID) */
  id: string;
  /** 胶囊名称 */
  name: string;
  /** 语义化版本号 (x.y.z) */
  version: string;
  /** 能力描述（用于向量化检索） */
  description: string;
  /** 能力标签数组 */
  capabilities: string[];
  /** 输入 JSON Schema */
  inputSchema: JsonSchemaDefinition;
  /** 输出 JSON Schema */
  outputSchema: JsonSchemaDefinition;
  /** 运行时类型 */
  runtime: SkillCapsuleRuntime;
  /** 入口文件路径（相对于胶囊目录） */
  entrypoint: string;
  /** 依赖声明（可选） */
  dependencies?: SkillCapsuleDependency[];
  /** 健康检查配置（可选） */
  healthCheck?: SkillCapsuleHealthCheck;
}

/**
 * 已加载的 Skill Capsule（包含运行时信息）
 */
export interface LoadedSkillCapsule {
  /** 胶囊规范 */
  capsule: SkillCapsule;
  /** 胶囊目录的绝对路径 */
  path: string;
  /** 是否内置 */
  isBuiltin: boolean;
  /** 是否启用 */
  enabled: boolean;
  /** 加载时间 */
  loadedAt: Date;
  /** 最后修改时间 */
  modifiedAt: Date;
  /** 健康状态 */
  healthy: boolean;
}

/**
 * Skill Capsule 执行结果
 */
export interface SkillCapsuleExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 输出数据 */
  output?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 退出码（仅子进程执行） */
  exitCode?: number;
}

/**
 * 验证 Skill Capsule config.json 的必填字段
 */
export function validateSkillCapsule(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['config.json must be a JSON object'] };
  }

  const obj = data as Record<string, unknown>;

  // 必填字段检查
  const requiredStringFields = ['id', 'name', 'version', 'description', 'entrypoint'];
  for (const field of requiredStringFields) {
    if (!obj[field] || typeof obj[field] !== 'string') {
      errors.push(`Missing or invalid required field: "${field}" (must be a non-empty string)`);
    }
  }

  // version 格式检查
  if (typeof obj.version === 'string' && !/^\d+\.\d+\.\d+$/.test(obj.version)) {
    errors.push(`Invalid version format: "${obj.version}" (must be semver x.y.z)`);
  }

  // capabilities 检查
  if (!Array.isArray(obj.capabilities) || obj.capabilities.length === 0) {
    errors.push('Missing or invalid required field: "capabilities" (must be a non-empty array of strings)');
  } else if (!obj.capabilities.every((c: unknown) => typeof c === 'string')) {
    errors.push('"capabilities" must contain only strings');
  }

  // inputSchema / outputSchema 检查
  for (const schemaField of ['inputSchema', 'outputSchema']) {
    if (!obj[schemaField] || typeof obj[schemaField] !== 'object') {
      errors.push(`Missing or invalid required field: "${schemaField}" (must be a JSON Schema object)`);
    }
  }

  // runtime 检查
  const validRuntimes = ['node', 'python', 'bash'];
  if (!obj.runtime || !validRuntimes.includes(obj.runtime as string)) {
    errors.push(`Missing or invalid required field: "runtime" (must be one of: ${validRuntimes.join(', ')})`);
  }

  // 可选字段类型检查
  if (obj.dependencies !== undefined) {
    if (!Array.isArray(obj.dependencies)) {
      errors.push('"dependencies" must be an array');
    }
  }

  if (obj.healthCheck !== undefined) {
    if (typeof obj.healthCheck !== 'object' || obj.healthCheck === null) {
      errors.push('"healthCheck" must be an object');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 将 raw JSON 解析为 SkillCapsule
 */
export function parseSkillCapsule(data: Record<string, unknown>): SkillCapsule {
  return {
    id: data.id as string,
    name: data.name as string,
    version: data.version as string,
    description: data.description as string,
    capabilities: data.capabilities as string[],
    inputSchema: data.inputSchema as JsonSchemaDefinition,
    outputSchema: data.outputSchema as JsonSchemaDefinition,
    runtime: data.runtime as SkillCapsuleRuntime,
    entrypoint: data.entrypoint as string,
    dependencies: data.dependencies as SkillCapsuleDependency[] | undefined,
    healthCheck: data.healthCheck
      ? {
          endpoint: (data.healthCheck as Record<string, unknown>).endpoint as string,
          intervalMs: ((data.healthCheck as Record<string, unknown>).intervalMs as number) ?? 60000,
        }
      : undefined,
  };
}
