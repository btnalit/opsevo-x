/**
 * KnowledgeDistiller — 知识提炼器
 *
 * 两条写入路径：
 * 1. 主动写入（activeWrite）：P0/P1 事件处理后，将因果分析结构化写入知识库
 *    - source: 'brain-active-write'
 *    - 每次 Tick 最多执行 1 次（限流）
 * 2. 巩固提炼（distillEpisode + mergeAndDeduplicate）：夜间巩固时对情景记忆提炼去重
 *    - source: 'brain-consolidation'
 *
 * 需求: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { logger } from '../../../utils/logger';
import { EpisodicMemory } from '../../../types/autonomous-brain';
import { BrainTickContext } from '../../../types/autonomous-brain';
import type { ReActStep } from '../../../types/ai-ops';

// ====================================================================
// 类型定义
// ====================================================================

/** 主动写入用：P0/P1 事件处理后的因果分析条目（需求 4.2） */
export interface CausalAnalysisEntry {
    trigger: string;           // 触发事件描述
    root_cause: string;        // 根因分析
    actions_taken: string[];   // 执行的操作列表
    outcome: string;           // 最终结果
    prevention: string;        // 预防建议
    source: 'brain-active-write' | 'brain-consolidation';
}

/** 巩固提炼用：情景记忆浓缩后的结构化知识条目（需求 4.4） */
export interface KnowledgeEntry {
    /** 原始 EpisodicMemory 的 ID，用于 consolidateMemory 中精确映射，防止 mergeAndDeduplicate 乱序导致错配 */
    episodeId: string;
    title: string;               // 知识条目标题
    summary: string;             // 摘要
    detailedSteps: string;       // 详细步骤
    applicableScenarios: string; // 适用场景
    caveats: string;             // 注意事项
    trigger?: string;            // 触发类型（用于去重）
}

// ====================================================================
// KnowledgeDistiller 类
// ====================================================================

export class KnowledgeDistiller {

    /** 🔴 FIX 1.6: 失败写入队列（上限 20 条），用于重试 */
    private failedWrites: Array<{
        entry: unknown;
        retries: number;
        lastError: string;
        addedAt: number;
    }> = [];
    private static readonly MAX_FAILED_QUEUE = 20;
    private static readonly MAX_TOTAL_RETRIES = 3;

    /**
     * 从情景记忆提炼结构化知识条目（需求 4.3, 4.4）
     * 将原始操作记录浓缩为可复用的运维知识
     */
    async distillEpisode(episode: EpisodicMemory): Promise<KnowledgeEntry> {
        // 从 episode.content 中提取关键信息
        const content = episode.content;
        const ctx = episode.context || '';

        // 解析工具调用摘要（格式：toolName({...}); toolName({...})）
        const toolMatches = content.match(/(\w+)\(({[^)]*})\)/g) || [];
        const toolNames = toolMatches.map(m => m.split('(')[0]).filter(Boolean);
        const toolDetails = toolMatches.map(m => {
            const name = m.split('(')[0];
            const params = m.slice(name.length);
            return `- 工具: ${name}\n  参数: ${params}`;
        });

        // 从 context 中提取触发信息
        const triggerMatch = ctx.match(/Trigger:\s*(\w+)/);
        const alertMatch = ctx.match(/Alerts:\s*(\d+)/);
        const trigger = triggerMatch?.[1] || 'unknown';
        const alertCount = alertMatch?.[1] || '0';

        const triggerLabelMap: Record<string, string> = {
            schedule: '例行巡检',
            critical_alert: '紧急告警',
            decision_pending: '待决决策',
            manual: '手动触发',
        };
        const triggerLabel = triggerLabelMap[trigger] || trigger;
        const dateStr = new Date(episode.createdAt).toISOString().split('T')[0];

        const title = `[巩固] ${dateStr} ${triggerLabel} — ${toolNames.slice(0, 3).join(', ')}${toolNames.length > 3 ? '...' : ''}`;

        const summary = [
            `触发源: ${trigger} (${triggerLabel}) ${dateStr}`,
            `感知状态 (Observe): ${triggerLabel}场景，活跃告警: ${alertCount} 条。`,
            `执行动作 (Act):`,
            toolDetails.length > 0 ? toolDetails.join('\n') : '- (无工具调用记录)',
            `经验价值评分: ${episode.verificationCount >= 5 ? '高' : '中'} (验证 ${episode.verificationCount} 次，衰减权重 ${episode.decayWeight.toFixed(2)})`,
        ].join('\n');

        return {
            episodeId: episode.id,
            title,
            summary,
            detailedSteps: content,
            applicableScenarios: `触发类型: ${trigger}，活跃告警数: ${alertCount}`,
            caveats: `此条目由 Brain 夜间巩固自动提炼，验证次数: ${episode.verificationCount}。`,
            trigger,
        };
    }

    /**
     * 对相似知识条目合并去重（需求 4.5）
     * 策略：提取 title 中的触发类型和工具名列表作为分组键，
     * 比纯前缀截断更精确 — 避免不同触发类型被误合并，也避免同触发+同工具因标题长度差异被漏合并
     */
    async mergeAndDeduplicate(entries: KnowledgeEntry[]): Promise<KnowledgeEntry[]> {
        if (entries.length <= 1) return entries;

        const groups = new Map<string, KnowledgeEntry[]>();

        for (const entry of entries) {
            const key = this.buildDeduplicationKey(entry);
            const group = groups.get(key) ?? [];
            group.push(entry);
            groups.set(key, group);
        }

        const merged: KnowledgeEntry[] = [];
        for (const group of groups.values()) {
            if (group.length === 1) {
                merged.push(group[0]);
                continue;
            }
            // 保留 detailedSteps 最长的条目（含其 episodeId），合并 caveats
            const best = group.reduce((a, b) => a.detailedSteps.length >= b.detailedSteps.length ? a : b);
            const allCaveats = [...new Set(group.map(e => e.caveats))].join(' | ');
            merged.push({ ...best, caveats: allCaveats });
        }

        const reduced = entries.length - merged.length;
        if (reduced > 0) {
            logger.debug(`[KnowledgeDistiller] mergeAndDeduplicate: ${entries.length} → ${merged.length} (reduced ${reduced})`);
        }
        return merged;
    }

    /**
     * 构建去重分组键：从 title 中提取触发类型 + 排序后的工具名列表
     * 格式: "trigger:toolA,toolB,toolC"
     * 比标题前 30 字符更精确：
     * - 不同触发类型不会被误合并
     * - 同触发+同工具集合即使标题措辞不同也能正确合并
     */
    private buildDeduplicationKey(entry: KnowledgeEntry): string {
        // 优先从结构化字段获取触发类型，降级到从 title 反向解析（支持旧数据）
        let trigger = entry.trigger;
        if (!trigger) {
            const triggerMatch = entry.title.match(/\[Brain\]\s*(\S+)\s*触发/) || entry.title.match(/\[巩固\]\s*\d{4}-\d{2}-\d{2}\s*(\S+)\s*—/);
            trigger = triggerMatch?.[1] || 'unknown';
        }

        // 提取 — 后面的工具名列表
        const toolsPart = entry.title.split('—')[1]?.trim() || '';
        const tools = toolsPart
            .replace(/\.{3}$/, '')  // 移除尾部省略号
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
            .sort();

        return `${trigger}:${tools.join(',')}`;
    }

    /**
     * P0/P1 场景主动写入因果分析（需求 4.1, 4.6, 4.7）
     * 条件：trigger 为 critical_alert 或 decision_pending，且至少有 1 个成功工具调用
     * 限流：每次 Tick 最多调用 1 次（由调用方保证）
     */
    async activeWrite(
        tickContext: BrainTickContext,
        toolResults: ReActStep[],
        knowledgeBase: { add(entry: unknown): Promise<unknown> },
    ): Promise<void> {
        const { trigger, activeAlerts } = tickContext;

        // 🔴 FIX: 扩展触发条件 — 所有 trigger 类型都可以生产知识
        // 原因：schedule/manual 触发的 tick 如果执行了工具且成功，也有学习价值
        // P0/P1 场景标记为高价值，其他场景标记为中等价值
        const isP0P1 = trigger === 'critical_alert' || trigger === 'decision_pending';

        // 精确找出成功执行的 action — 将 action 与紧随其后的 observation 关联
        // 只有 observation.success === true 的 action 才计入知识库，避免污染因果关系
        // 并行执行场景：多个 action 共享一个 merged observation，此时通过
        // observation.toolOutput（MergedObservation.results 数组）精确匹配每个 action 的独立成功状态
        const verifiedActions: Array<{ name: string; input: unknown; output: unknown; success: boolean }> = [];
        for (let i = 0; i < toolResults.length; i++) {
            const step = toolResults[i];
            if (step.type === 'action' && step.toolName) {
                const obs = toolResults.slice(i + 1).find(s => s.type === 'observation');
                if (!obs || obs.success !== true) continue;

                // 并行场景：obs.toolOutput 是 MergedObservation.results 数组
                const mergedResults = Array.isArray(obs.toolOutput) ? obs.toolOutput as Array<{ toolName?: string; success?: boolean; output?: unknown }> : null;
                if (mergedResults) {
                    const match = mergedResults.find(r => r.toolName === step.toolName);
                    if (match && match.success === true) {
                        verifiedActions.push({ name: step.toolName, input: step.toolInput, output: match.output, success: true });
                    }
                } else {
                    verifiedActions.push({ name: step.toolName, input: step.toolInput, output: obs.toolOutput, success: true });
                }
            }
        }
        if (verifiedActions.length === 0) return;

        // 提取思考过程（从 ReActStep 中找 thought 类型）
        const thoughts = toolResults
            .filter(s => s.type === 'thought' && s.content && !s.content.startsWith('[SYSTEM'))
            .map(s => s.content)
            .slice(-2); // 取最近 2 条思考

        // 构建感知状态描述
        const alertSummary = activeAlerts.length > 0
            ? `发现 ${activeAlerts.length} 条活跃告警，最高严重度: ${activeAlerts[0]?.severity || 'unknown'}。` +
            activeAlerts.slice(0, 3).map((a: any) => `[${a.severity || '?'}] ${a.message || a.id || ''}`).join('；')
            : '未发现活跃告警。';

        const triggerLabelMap: Record<string, string> = {
            critical_alert: '紧急告警',
            decision_pending: '待决决策',
            schedule: '定时巡检',
            manual: '手动触发',
        };
        const triggerLabel = triggerLabelMap[trigger] || trigger;
        const dateStr = new Date().toISOString().split('T')[0];

        // 构建执行动作列表
        const actLines = verifiedActions.map(a => {
            const inputStr = a.input ? JSON.stringify(a.input) : '{}';
            // 截断过长的参数
            const truncatedInput = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
            return `- 工具: ${a.name}\n  参数: ${truncatedInput}`;
        }).join('\n');

        // 构建执行结果摘要
        const outcomeLines = verifiedActions.map(a => {
            const outputStr = a.output ? JSON.stringify(a.output) : '';
            const truncated = outputStr.length > 150 ? outputStr.slice(0, 150) + '...' : outputStr;
            return `- ${a.name}: ${a.success ? '✅ 成功' : '❌ 失败'}${truncated ? ' → ' + truncated : ''}`;
        }).join('\n');

        const valueLabel = isP0P1
            ? '经验价值评分: 高 (P0/P1 事件处置记录，具有因果分析价值，建议长期保留)'
            : '经验价值评分: 中 (常规运维操作记录，具有模式学习价值)';

        const content = [
            `触发源: ${trigger} (${triggerLabel}) ${dateStr}`,
            `感知状态 (Observe): ${alertSummary}`,
            `思考过程 (Thought): ${thoughts.length > 0 ? thoughts.join(' → ') : '基于系统状态进行分析和处置。'}`,
            `执行动作 (Act):`,
            actLines,
            `执行结果 (Outcome):`,
            outcomeLines,
            valueLabel,
        ].join('\n');

        const verifiedActionNames = verifiedActions.map(a => a.name);
        const titleActions = verifiedActionNames.slice(0, 2).join(', ');
        const knowledgeType = isP0P1 ? 'remediation' : 'pattern';

        const knowledgeEntry = {
                type: knowledgeType,
                title: `[${triggerLabel}] ${dateStr} ${titleActions}`,
                content,
                metadata: {
                    source: 'brain-active-write',
                    timestamp: Date.now(),
                    category: knowledgeType,
                    tags: ['brain-active-write', trigger, ...verifiedActionNames.slice(0, 3)],
                    usageCount: 0,
                    feedbackScore: 0,
                    feedbackCount: 0,
                },
            };

        // 🔴 FIX 1.6: 先尝试重试队列中的失败条目
        await this.retryFailedWrites(knowledgeBase);

        // 🔴 FIX 1.6: 带重试的写入（最多 2 次重试，退避 1s/2s）
        let written = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await knowledgeBase.add(knowledgeEntry);
                written = true;
                logger.info(`[KnowledgeDistiller] Active write completed (attempt ${attempt + 1}): trigger=${trigger}, actions=${verifiedActionNames.join(',')}`);
                break;
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                logger.warn(`[KnowledgeDistiller] Active write attempt ${attempt + 1}/3 failed: ${errMsg}`);
                if (attempt < 2) {
                    // 退避等待：1s, 2s
                    await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
                }
            }
        }

        // 全部重试失败 → 入队列
        if (!written) {
            this.enqueueFailedWrite(knowledgeEntry);
        }
    }

    /**
     * 🔴 FIX 1.6: 重试失败队列中的条目
     * 在每次 activeWrite 调用开始时执行
     */
    async retryFailedWrites(knowledgeBase: { add(entry: unknown): Promise<unknown> }): Promise<void> {
        if (this.failedWrites.length === 0) return;

        const toRetry = [...this.failedWrites];
        this.failedWrites = [];

        for (const item of toRetry) {
            try {
                await knowledgeBase.add(item.entry);
                logger.info(`[KnowledgeDistiller] Retry succeeded for queued write (was ${item.retries} retries)`);
            } catch (err) {
                item.retries++;
                item.lastError = err instanceof Error ? err.message : String(err);
                if (item.retries >= KnowledgeDistiller.MAX_TOTAL_RETRIES) {
                    logger.warn(`[KnowledgeDistiller] Discarding failed write after ${item.retries} total retries: ${item.lastError}`);
                } else {
                    this.failedWrites.push(item);
                }
            }
        }
    }

    /**
     * 🔴 FIX 1.6: 将失败条目加入队列
     */
    private enqueueFailedWrite(entry: unknown): void {
        this.failedWrites.push({
            entry,
            retries: 1, // 已经在 activeWrite 中重试过了
            lastError: 'initial failure after 3 attempts',
            addedAt: Date.now(),
        });
        // 超过上限时丢弃最旧的
        while (this.failedWrites.length > KnowledgeDistiller.MAX_FAILED_QUEUE) {
            const discarded = this.failedWrites.shift();
            logger.warn(`[KnowledgeDistiller] Failed write queue overflow, discarding oldest entry (added at ${discarded?.addedAt})`);
        }
    }

}

// 单例导出
export const knowledgeDistiller = new KnowledgeDistiller();
