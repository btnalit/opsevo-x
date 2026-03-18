/**
 * SSH Driver 类型定义
 *
 * Requirements: A8.30
 */

/** SSH 连接池配置 */
export interface SshPoolConfig {
  maxConnections: number;
  idleTimeoutMs: number;
  connectTimeoutMs: number;
}

/** 命令执行选项 */
export interface CommandOptions {
  /** 超时 (ms) */
  timeout?: number;
  /** 最大输出大小 (bytes) */
  maxOutputSize?: number;
}

/** 命令执行结果 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 输出是否被截断 */
  truncated: boolean;
}

/** 危险命令黑名单 */
export const DANGEROUS_COMMANDS = [
  /^rm\s+-rf\s+\//,
  /^mkfs\./,
  /^dd\s+if=/,
  /^shutdown/,
  /^reboot/,
  /^halt/,
  /^init\s+0/,
  /^poweroff/,
  /^:(){ :\|:& };:/,  // fork bomb
  /^chmod\s+-R\s+777\s+\//,
  /^chown\s+-R.*\s+\//,
];

/** 文件传输方向 */
export type TransferDirection = 'upload' | 'download';
