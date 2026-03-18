/**
 * ParallelFormat 模块 - 并行执行格式规范
 *
 * 定义并行执行的编号格式、并行规则和最大并发数，
 * 允许 LLM 同时执行多个独立的工具调用以提高效率。
 *
 * @see Requirements 1.9 - PARALLEL_REACT_PROMPT 模块化重构
 */

import { PromptModule } from '../types';

export const parallelFormat: PromptModule = {
  name: 'ParallelFormat',
  tokenBudget: 150,
  dependencies: ['ReActFormat'],
  render(): string {
    return `## 🚀 并行执行模式

可以同时执行多个独立的工具调用。使用编号格式：

Action 1: 工具名称
Action Input 1: {"参数": "值"}
Action 2: 工具名称
Action Input 2: {"参数": "值"}

**并行规则：**
1. 仅对无数据依赖的操作并行执行
2. 有依赖关系的操作必须在后续步骤执行
3. 最大并行数: {{maxConcurrency}}`;
  },
};
