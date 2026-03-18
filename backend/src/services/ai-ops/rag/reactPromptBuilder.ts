/**
 * ReactPromptBuilder - 提示词构建模块
 *
 * 从 ReActLoopController 拆分的提示词构建相关功能。
 * 当前阶段作为委托模块，后续可逐步将方法从主控制器迁移到此处。
 *
 * 包含方法：
 * - buildReActPrompt / buildReActPromptAsync
 * - buildActionSelectionPrompt
 * - buildContinueCheckPrompt
 * - formatStepForPrompt
 * - formatRAGContext
 *
 * Requirements: 8.1, 8.2
 */

import type { ReActStep, RAGContext } from '../../../types/ai-ops';
import type { AgentTool } from './mastraAgent';

/**
 * 格式化 ReAct 步骤用于提示词
 */
export function formatStepForPromptStandalone(step: ReActStep, fullOutput: boolean = false): string {
  switch (step.type) {
    case 'thought':
      return `Thought: ${step.content}`;
    case 'action':
      return `Action: ${step.toolName || 'unknown'}\nAction Input: ${JSON.stringify(step.toolInput || {})}`;
    case 'observation': {
      const output = fullOutput
        ? step.content
        : step.content.length > 500
          ? step.content.substring(0, 500) + '...(truncated)'
          : step.content;
      return `Observation: ${output}`;
    }
    case 'reflection':
      return `Reflection: ${step.content}`;
    default:
      return `${step.type}: ${step.content}`;
  }
}

/**
 * 格式化 RAG 上下文
 */
export function formatRAGContextStandalone(ragContext?: RAGContext): string {
  if (!ragContext || !ragContext.documents || ragContext.documents.length === 0) {
    return '无相关知识库内容';
  }

  return ragContext.documents
    .map((doc, i) => `[${i + 1}] ${doc.title || 'Untitled'} (${doc.type || 'unknown'})\n${doc.excerpt || ''}`)
    .join('\n\n');
}

/**
 * 构建工具描述文本
 */
export function buildToolDescriptions(tools: AgentTool[]): string {
  return tools.map(tool => {
    const params = Object.entries(tool.parameters)
      .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
      .join('\n');
    return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
  }).join('\n\n');
}
