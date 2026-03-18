/**
 * RuleEvolutionService - 规则进化服务
 * 
 * 核心职责：
 * 1. 规则提取：从 Reflector 的反思结果和 PatternLearner 的成功模式中提炼规则
 * 2. 规则存储：持久化 OperationalRule
 * 3. 规则检索：为 ReAct 循环提供上下文相关的规则（RAG）
 * 
 * Requirements:
 * - 阶段一：规则引擎与反馈闭环
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
    OperationalRule,
    IRuleEvolutionService,
    CreateRuleInput,
    RuleRetrievalResult,
    RuleType,
    FaultPattern,
    ReflectionResult
} from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { aiAnalyzer } from './aiAnalyzer';
import { knowledgeBase } from './rag';
import { RemediationPlan } from '../../types/ai-ops';
// Lazy load scriptSynthesizer and faultHealer to avoid circular dependencies
// import { scriptSynthesizer } from './scriptSynthesizer';
// import { faultHealer } from './faultHealer';
// import { scriptSynthesizer } from './scriptSynthesizer';
// import { faultHealer } from './faultHealer';

const DATA_DIR = path.join(process.cwd(), 'data', 'ai-ops');
const RULES_DIR = path.join(DATA_DIR, 'rules');
const RULES_FILE = path.join(RULES_DIR, 'operational_rules.json');

export class RuleEvolutionService implements IRuleEvolutionService {
    private rules: OperationalRule[] = [];
    private initialized = false;

    /**
     * 确保数据目录存在
     */
    private async ensureDataDir(): Promise<void> {
        try {
            await fs.mkdir(RULES_DIR, { recursive: true });
        } catch (error) {
            logger.error('Failed to create rules directory:', error);
        }
    }

    /**
     * 初始化服务
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        await this.ensureDataDir();
        await this.loadRules();
        this.initialized = true;
        logger.info('RuleEvolutionService initialized');
    }

    /**
     * 加载规则
     */
    private async loadRules(): Promise<void> {
        try {
            const data = await fs.readFile(RULES_FILE, 'utf-8');
            this.rules = JSON.parse(data) as OperationalRule[];
            logger.info(`Loaded ${this.rules.length} operational rules`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.rules = [];
                await this.saveRules();
            } else {
                logger.error('Failed to load rules:', error);
                this.rules = [];
            }
        }
    }

    /**
     * 保存规则
     */
    private async saveRules(): Promise<void> {
        await this.ensureDataDir();
        await fs.writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf-8');
    }

    /**
     * 创建规则
     */
    async createRule(input: CreateRuleInput): Promise<OperationalRule> {
        await this.initialize();

        const rule: OperationalRule = {
            id: uuidv4(),
            ...input,
            confidence: input.initialConfidence || 0.5,
            usageCount: 0,
            tags: input.tags || [],
        };

        this.rules.push(rule);
        await this.saveRules();

        // 索引到知识库 (向量存储) 用于检索
        try {
            // 适配 knowledgeBase 以支持 Rule 类型的索引
            await knowledgeBase.add({
                title: `[Rule:${rule.type}] ${rule.description}`,
                content: `Condition: ${rule.condition}\nSource: ${rule.source.type}\n\n${rule.description}`,
                type: 'manual', // 暂时使用 manual 类型，因 KnowledgeEntryType 尚未扩展 rule 类型
                metadata: {
                    source: 'rule_evolution_service',
                    category: 'operational_rule',
                    timestamp: Date.now(),
                    tags: ['operational_rule', rule.type, ...(rule.tags || [])],
                    usageCount: 0,
                    feedbackScore: 0,
                    feedbackCount: 0,
                    originalData: {
                        ruleId: rule.id,
                        ruleType: rule.type,
                        condition: rule.condition
                    }
                }
            });
            logger.debug(`Operational rule indexed: ${rule.id}`);
        } catch (error) {
            logger.warn(`Failed to index rule ${rule.id}:`, error);
        }

        logger.info(`Created operational rule: ${rule.description.substring(0, 50)}... (${rule.id})`);
        return rule;
    }

    /**
     * 从反思结果中学习并生成规则
     */
    async learnFromReflection(reflection: ReflectionResult): Promise<OperationalRule[]> {
        await this.initialize();

        // 如果反思结果没有明确的改进点，则忽略
        if (!reflection.nextAction || reflection.nextAction === 'complete') {
            return [];
        }

        // 使用 AI 分析反思结果，提取规则建议
        // 这里使用 AIAnalyzer 来完成 "Unstructured Insight -> Structured Rule" 的转换
        try {
            const analysisCheck = await aiAnalyzer.analyze({
                type: 'fault_diagnosis', // 复用 fault_diagnosis 或扩展新的 analysis type
                context: {
                    analysisType: 'rule_extraction',
                    reflectionSummary: reflection.summary,
                    insights: reflection.insights,
                    gapAnalysis: reflection.gapAnalysis,
                    failureCategory: reflection.patternMatch?.patternId // 实际上这里应该是 failureCategory，需从 reflection 上下文获取
                }
            });

            const extractedRules: OperationalRule[] = [];

            // 解析 AI 建议并创建规则
            if (analysisCheck.recommendations && analysisCheck.recommendations.length > 0) {
                for (const recommendation of analysisCheck.recommendations) {
                    // 假设 recommendation 是自然语言，这里简化处理，实际应要求 LLM 返回 JSON 结构
                    // 或者进行二次解析
                    const rule = await this.createRule({
                        type: 'correction', // 默认为修正
                        description: recommendation,
                        condition: 'relevant_context', // 需要 LLM 生成具体条件
                        source: {
                            type: 'feedback',
                            refId: reflection.id,
                            createdAt: Date.now()
                        },
                        initialConfidence: 0.7
                    });
                    extractedRules.push(rule);
                }
            }

            return extractedRules;

        } catch (error) {
            logger.error('Failed to learn from reflection:', error);
            return [];
        }
    }

    /**
     * 从成功模式中学习并生成规则
     */
    async learnFromPattern(pattern: FaultPattern): Promise<OperationalRule[]> {
        await this.initialize();

        // 将 FaultPattern 转换为 OperationalRule (Best Practice)
        // 当检测到特定 Condition 时，推荐使用 pattern.remediationScript

        const rule = await this.createRule({
            type: 'best_practice',
            description: `针对 ${pattern.name} 的处理建议: ${pattern.description}`,
            condition: `alert_metric == '${pattern.conditions[0]?.metric}'`, // 简化转换
            correction: `建议执行脚本: ${pattern.remediationScript}`,
            source: {
                type: 'pattern',
                refId: pattern.id,
                createdAt: Date.now()
            },
            tags: ['auto_healing', pattern.name],
            initialConfidence: 0.9
        });

        return [rule];
    }

    /**
     * 根据上下文查找适用的规则
     */
    async findApplicableRules(context: string, limit: number = 5): Promise<RuleRetrievalResult[]> {
        await this.initialize();

        // 1. 使用向量检索查找相关规则
        // 使用 tags 过滤，无需 filter 对象
        const searchResults = await knowledgeBase.search({
            query: context,
            limit: limit * 2,
            tags: ['operational_rule']
        });

        // 2. 映射回 OperationalRule 对象
        const results: RuleRetrievalResult[] = [];

        for (const result of searchResults) {
            // result 是 KnowledgeSearchResult，包含 entry
            const ruleId = result.entry.metadata?.originalData?.ruleId as string;
            if (ruleId) {
                const rule = this.rules.find(r => r.id === ruleId);
                if (rule) {
                    results.push({
                        rule,
                        similarity: result.score,
                        relevance: 'Based on semantic similarity' // 后续可优化
                    });
                }
            }
        }

        // 3. 按相似度排序并截取
        return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
    }

    /**
     * 获取所有规则
     */
    async getAllRules(): Promise<OperationalRule[]> {
        await this.initialize();
        return [...this.rules];
    }

    /**
     * 更新规则统计信息
     */
    async recordRuleUsage(ruleId: string, helpful: boolean): Promise<void> {
        await this.initialize();

        const rule = this.rules.find(r => r.id === ruleId);
        if (!rule) return;

        rule.usageCount++;
        rule.lastUsedAt = Date.now();

        // 简单的置信度调整算法
        if (helpful) {
            rule.confidence = Math.min(1.0, rule.confidence + 0.05);
        } else {
            rule.confidence = Math.max(0.1, rule.confidence - 0.1);
        }

        await this.saveRules();
    }

    /**
     * 删除规则
     */
    async deleteRule(id: string): Promise<void> {
        await this.initialize();

        const index = this.rules.findIndex(r => r.id === id);
        if (index !== -1) {
            this.rules.splice(index, 1);
            await this.saveRules();
        }
    }

    /**
     * 从成功修复中学习并生成故障模式
     */
    async learnFromSuccessfulRemediation(plan: RemediationPlan, alertDescription: string): Promise<void> {
        await this.initialize();

        try {
            logger.info(`Learning from successful remediation plan: ${plan.id}`);

            // 1. Synthesize Script
            // Lazy load to avoid circular dependency
            const { scriptSynthesizer } = await import('./scriptSynthesizer');
            const script = await scriptSynthesizer.synthesizeScript(plan);
            if (!script) {
                logger.warn('Failed to synthesize script, skipping learning.');
                return;
            }

            // 2. Extract Conditions (using AIAnalyzer)
            // We'll ask AI to generate conditions based on the alert description
            const conditionPrompt = `
Analyze the following alert description and extract a precise condition for a Fault Pattern.
Alert: "${alertDescription}"

Return the condition in JSON format:
{
  "metric": "string (e.g., cpu, memory, interface_status)",
  "operator": "string (eq, gt, lt, ne)",
  "threshold": number
}
            `;

            // Use AIAnalyzer to get conditions (simplified for now as we don't have a direct method)
            // For now, we'll try to use a heuristic or just a default condition for the "Pending" review
            // In a real implementation, we would call LLM here.
            // Let's create a placeholder condition.
            const condition: any = {
                metric: 'system', // specific metric extraction needs LLM
                operator: 'eq',
                threshold: 1
            };

            // 3. Propose Pattern
            const { faultHealer } = await import('./faultHealer');
            await faultHealer.proposePattern({
                name: `Auto-Learned: ${alertDescription.substring(0, 30)}...`,
                description: `Automatically learned from remediation of: ${alertDescription}`,
                enabled: false, // Proposed patterns are disabled by default until approved
                autoHeal: false,
                conditions: [condition], // Placeholder
                remediationScript: script,
                verificationScript: plan.steps.find(s => s.verification)?.verification.command || '/log print'
            });

            logger.info(`Successfully proposed new fault pattern from plan ${plan.id}`);

        } catch (error) {
            logger.error('Failed to learn from remediation:', error);
        }
    }
}

export const ruleEvolutionService = new RuleEvolutionService();
