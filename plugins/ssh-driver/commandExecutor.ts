/**
 * CommandExecutor — SSH 命令执行器
 *
 * 超时/大小限制/危险命令黑名单拦截。
 * 输出超 1MB 截断并设置 truncated = true。
 *
 * Requirements: A8.32, A8.33
 */

import type { CommandOptions, CommandResult } from './types';
import { DANGEROUS_COMMANDS } from './types';

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024; // 1MB

export class CommandExecutor {
  /**
   * 检查命令是否在黑名单中
   */
  isDangerous(command: string): boolean {
    return DANGEROUS_COMMANDS.some(pattern => pattern.test(command.trim()));
  }

  /**
   * 执行 SSH 命令
   */
  async execute(
    client: any,
    command: string,
    options?: CommandOptions,
  ): Promise<CommandResult> {
    // 黑名单检查
    if (this.isDangerous(command)) {
      return {
        stdout: '',
        stderr: `Command rejected: matches dangerous command pattern`,
        exitCode: -1,
        truncated: false,
      };
    }

    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const maxOutput = options?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;

    return new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let totalSize = 0;

      const timer = setTimeout(() => {
        resolve({ stdout, stderr: stderr + '\nCommand timed out', exitCode: -1, truncated });
      }, timeout);

      client.exec(command, (err: Error | null, stream: any) => {
        if (err) {
          clearTimeout(timer);
          resolve({ stdout: '', stderr: err.message, exitCode: -1, truncated: false });
          return;
        }

        stream.on('data', (data: Buffer) => {
          totalSize += data.length;
          if (totalSize <= maxOutput) {
            stdout += data.toString();
          } else if (!truncated) {
            truncated = true;
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 0, truncated });
        });
      });
    });
  }
}
