/**
 * OutputValidator - 输出验证器
 * 
 * 验证 LLM 输出中的知识引用格式和正确性
 * 
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 10.1, 10.4, 10.5
 * - 9.1: 使用正则表达式检查引用格式
 * - 9.2: 验证引用的知识 ID 在当前上下文中存在
 * - 9.3: 标记无效引用并记录
 * - 9.4: 输出格式不符合要求时触发修正流程
 * - 9.5: 最多触发 2 次修正重试
 * - 10.1: 构建修正提示词说明具体错误
 * - 10.4: 修正次数达到 2 次仍失败时接受当前输出并标记为未验证
 * - 10.5: 记录修正历史用于分析
 */

import { logger } from '../../../utils/logger';
import {
  KnowledgeReference,
  KnowledgeContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  ReferenceValidationResult,
  CorrectionHistory,
  OutputValidatorConfig,
  DEFAULT_OUTPUT_VALIDATOR_CONFIG,
  REFERENCE_ID_PATTERN,
} from './types/validation';
import { FormattedKnowledge } from './types/intelligentRetrieval';
import { CORRECTION_PROMPT_TEMPLATE } from './types/formatting';

/**
 * 输出验证器类
 */
export class OutputValidator {
  private config: OutputValidatorConfig;
  private correctionHistory: CorrectionHistory[] = [];

  constructor(config?: Partial<OutputValidatorConfig>) {
    this.config = { ...DEFAULT_OUTPUT_VALIDATOR_CONFIG, ...config };
    logger.debug('OutputValidator created', { config: this.config });
  }

  /**
   * 验证 LLM 输出
   * Requirements: 9.1, 9.2, 9.3, 9.4
   * 
   * @param output LLM 输出内容
   * @param contextOrKnowledge 知识上下文或格式化知识列表
   * @returns 验证结果
   */
  validate(output: string, contextOrKnowledge: KnowledgeContext | FormattedKnowledge[]): ValidationResult {
    // 如果传入的是 FormattedKnowledge[]，转换为 KnowledgeContext
    const context: KnowledgeContext = Array.isArray(contextOrKnowledge)
      ? OutputValidator.createKnowledgeContext(contextOrKnowledge, 'default-session')
      : contextOrKnowledge;
    
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // 提取所有引用
    const references = this.extractReferences(output);

    // 验证引用存在性
    const refValidation = this.validateReferences(references, context);

    // 收集错误
    for (const ref of refValidation.invalidReferences) {
      const detail = refValidation.details.get(ref.fullText);
      errors.push({
        type: 'unknown_id',
        message: detail?.reason || `引用 ${ref.fullText} 在知识上下文中不存在`,
        reference: ref.fullText,
        position: ref.position,
      });
    }

    // 检查是否需要至少一个引用
    if (this.config.requireAtLeastOneReference && references.length === 0) {
      errors.push({
        type: 'missing_reference',
        message: '输出中未包含任何知识引用，请使用 [KB-xxx] 格式引用相关知识',
      });
    }

    // 检查低可信度知识的使用
    for (const ref of refValidation.validReferences) {
      const knowledge = context.availableKnowledge.get(ref.fullText.replace(/[\[\]]/g, ''));
      if (knowledge && knowledge.credibilityLevel === 'low') {
        warnings.push({
          type: 'low_credibility',
          message: `引用 ${ref.fullText} 的知识可信度较低，请谨慎使用`,
          reference: ref.fullText,
        });
      }
    }

    const isValid = this.config.strictValidation 
      ? errors.length === 0 
      : refValidation.invalidReferences.length === 0;

    return {
      isValid,
      errors,
      warnings,
      references,
      validReferences: refValidation.validReferences,
      invalidReferences: refValidation.invalidReferences,
      validatedAt: Date.now(),
    };
  }

  /**
   * 提取知识引用
   * Requirements: 9.1
   * 
   * @param output LLM 输出内容
   * @returns 引用列表
   */
  extractReferences(output: string): KnowledgeReference[] {
    const references: KnowledgeReference[] = [];
    
    // 重置正则表达式的 lastIndex
    const pattern = new RegExp(REFERENCE_ID_PATTERN.source, 'g');
    let match;

    while ((match = pattern.exec(output)) !== null) {
      references.push({
        fullText: match[0],
        type: match[1],
        shortId: match[2],
        position: match.index,
      });
    }

    return references;
  }

  /**
   * 验证引用存在性
   * Requirements: 9.2, 9.3
   * 
   * @param references 引用列表
   * @param context 知识上下文
   * @returns 验证结果
   */
  validateReferences(
    references: KnowledgeReference[],
    context: KnowledgeContext
  ): ReferenceValidationResult {
    const validReferences: KnowledgeReference[] = [];
    const invalidReferences: KnowledgeReference[] = [];
    const details = new Map<string, { valid: boolean; reason?: string }>();

    for (const ref of references) {
      // 从引用文本中提取 ID（去掉方括号）
      const refId = ref.fullText.replace(/[\[\]]/g, '');
      
      // 检查是否在可用知识中
      const exists = context.availableKnowledge.has(refId);

      if (exists) {
        validReferences.push(ref);
        details.set(ref.fullText, { valid: true });
      } else {
        invalidReferences.push(ref);
        details.set(ref.fullText, {
          valid: false,
          reason: `知识 ID "${refId}" 在当前会话的知识上下文中不存在`,
        });
      }
    }

    return {
      allReferences: references,
      validReferences,
      invalidReferences,
      details,
    };
  }

  /**
   * 构建修正提示词
   * Requirements: 10.1
   * 
   * @param originalOutput 原始输出
   * @param validationResult 验证结果
   * @param availableKnowledge 可用的知识列表（可选）
   * @returns 修正提示词
   */
  buildCorrectionPrompt(
    originalOutput: string,
    validationResult: ValidationResult,
    availableKnowledge?: FormattedKnowledge[]
  ): string {
    // 格式化错误信息
    const errorsText = validationResult.errors
      .slice(0, 5) // 最多显示 5 个错误
      .map((err, index) => {
        let errorDesc = `${index + 1}. `;
        switch (err.type) {
          case 'invalid_format':
            errorDesc += `格式错误: ${err.message}`;
            break;
          case 'missing_reference':
            errorDesc += `缺少引用: ${err.message}`;
            break;
          case 'unknown_id':
            errorDesc += `无效引用: ${err.message}`;
            if (err.reference) {
              errorDesc += ` (引用: ${err.reference})`;
            }
            break;
        }
        return errorDesc;
      })
      .join('\n');

    let prompt = CORRECTION_PROMPT_TEMPLATE
      .replace('{{errors}}', errorsText)
      .replace('{{originalOutput}}', originalOutput);

    // 如果有有效引用，提供参考
    if (validationResult.validReferences.length > 0) {
      const validRefs = validationResult.validReferences
        .map(r => r.fullText)
        .join(', ');
      prompt += `\n\n有效的引用示例: ${validRefs}`;
    }
    
    // 如果提供了可用知识列表，添加可用引用 ID 列表
    if (availableKnowledge && availableKnowledge.length > 0) {
      const availableRefs = availableKnowledge
        .map(k => `[${k.referenceId}] - ${k.title}`)
        .join('\n');
      prompt += `\n\n可用的知识引用 ID:\n${availableRefs}`;
    }

    return prompt;
  }

  /**
   * 记录修正历史
   * Requirements: 10.5
   */
  recordCorrectionHistory(
    sessionId: string,
    originalOutput: string,
    correctedOutput: string,
    validationErrors: ValidationError[],
    correctionAttempts: number,
    finallyValid: boolean
  ): void {
    const history: CorrectionHistory = {
      sessionId,
      originalOutput,
      correctedOutput,
      validationErrors,
      correctionAttempts,
      finallyValid,
      timestamp: Date.now(),
    };

    this.correctionHistory.push(history);

    // 保持历史记录在合理范围内
    if (this.correctionHistory.length > 1000) {
      this.correctionHistory = this.correctionHistory.slice(-500);
    }

    logger.info('Correction history recorded', {
      sessionId,
      correctionAttempts,
      finallyValid,
    });
  }

  /**
   * 获取修正历史
   */
  getCorrectionHistory(sessionId?: string): CorrectionHistory[] {
    if (sessionId) {
      return this.correctionHistory.filter(h => h.sessionId === sessionId);
    }
    return [...this.correctionHistory];
  }

  /**
   * 检查是否已达到最大修正次数
   * Requirements: 9.5, 10.4
   */
  hasReachedMaxCorrections(attempts: number): boolean {
    return attempts >= this.config.maxCorrectionAttempts;
  }

  /**
   * 获取最大修正次数
   */
  getMaxCorrectionAttempts(): number {
    return this.config.maxCorrectionAttempts;
  }

  /**
   * 创建知识上下文
   * 
   * @param knowledge 格式化的知识列表
   * @param sessionId 会话 ID
   * @returns 知识上下文
   */
  static createKnowledgeContext(
    knowledge: FormattedKnowledge[],
    sessionId: string
  ): KnowledgeContext {
    const availableKnowledge = new Map<string, FormattedKnowledge>();
    
    for (const k of knowledge) {
      availableKnowledge.set(k.referenceId, k);
    }

    return {
      availableKnowledge,
      sessionId,
    };
  }

  /**
   * 清除修正历史（用于测试）
   */
  clearHistory(): void {
    this.correctionHistory = [];
  }
}

// 导出单例实例
export const outputValidator = new OutputValidator();
