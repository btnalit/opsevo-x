/**
 * ReActFormat 模块 - ReAct 格式规范
 *
 * 定义 Thought/Action/Action Input/Final Answer 的输出格式规范，
 * 确保 LLM 按照 ReAct 循环模式进行推理和工具调用。
 *
 * @see Requirements 1.5 - ReActFormat 模块生成不超过 150 Token 的 ReAct 格式规范内容
 */

import { PromptModule } from '../types';

export const reActFormat: PromptModule = {
  name: 'ReActFormat',
  tokenBudget: 150,
  dependencies: [],
  templateName: '[模块化] ReActFormat - ReAct 格式',
  render(): string {
    return `## 输出格式要求

如果需要继续执行操作：
Thought: 你的思考过程（必须具体说明要做什么，不要重复之前的思考）
Action: 工具名称
Action Input: {"参数名": "具体值", ...}

如果问题已解决：
Thought: 总结思考
Final Answer: 最终回答

重要规则：
1. 每次只能选择一个工具执行
2. Action 必须是可用工具列表中的工具名称
3. Action Input 必须是有效的 JSON 格式
4. 如果工具调用失败，分析原因并尝试其他方法
5. 回答时使用中文`;
  },
};
