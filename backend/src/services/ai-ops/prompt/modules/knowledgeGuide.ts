/**
 * KnowledgeGuide 模块 - 知识库使用指引
 *
 * 定义知识优先原则、知识库使用指引和引用格式，
 * 确保 LLM 在处理问题前优先查询知识库获取历史经验和案例。
 *
 * @see Requirements 1.8 - KNOWLEDGE_FIRST_REACT_PROMPT 模块化重构
 */

import { PromptModule } from '../types';

export const knowledgeGuide: PromptModule = {
  name: 'KnowledgeGuide',
  tokenBudget: 150,
  dependencies: [],
  templateName: '[模块化] KnowledgeGuide - 知识指引',
  render(): string {
    return `## 知识优先原则

处理问题前必须先查询知识库获取历史经验和案例。

**知识库使用指引：**
1. 首先使用 knowledge_search 查询相关历史案例
2. 如果知识库有相关方案，直接参考使用
3. 严格按照知识库步骤执行，包括指定的命令和参数
4. 在最终回答中引用知识库来源 [KB-xxx]

知识库包含：历史告警案例、配置方案、最佳实践、故障排查、操作指南`;
  },
};
