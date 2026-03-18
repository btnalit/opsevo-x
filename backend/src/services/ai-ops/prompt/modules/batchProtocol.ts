/**
 * BatchProtocol 模块 - 分批处理协议
 *
 * 定义大数据量查询的分批处理规范，包括探测总量、强制分页、
 * 迭代处理和截断恢复策略，确保 LLM 不会对大数据量路径使用不带限制的查询。
 *
 * @see Requirements 1.7 - REACT_LOOP_PROMPT 模块化重构
 */

import { PromptModule } from '../types';

export const batchProtocol: PromptModule = {
  name: 'BatchProtocol',
  tokenBudget: 200,
  dependencies: [],
  templateName: '[模块化] BatchProtocol - 分批协议',
  render(): string {
    return `## ⚠️ 分批处理协议

1. **探测总量优先**：查询前先确认数据规模，使用 count 或 limit=1 探测
2. **强制分页查询**：使用 proplist 限制字段、limit 限制条数（每批 20-50 条）、offset 分页
3. **迭代处理模式**：获取一批 → 分析提炼 → 获取下一批 → 合并要点
4. **截断检测与恢复**：发现数据截断时立即改用更小的 limit 重新查询

严禁对大数据量路径使用不带限制的查询。`;
  },
};
