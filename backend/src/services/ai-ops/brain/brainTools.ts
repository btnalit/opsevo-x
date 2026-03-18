import { AgentTool } from '../rag/mastraAgent';
import { skillManager } from '../skill/skillManager';
import { knowledgeBase } from '../rag/knowledgeBase';
import { notificationService } from '../notificationService';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../../utils/logger';
import { RouterOSClient } from '../../routerosClient';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnalysisEntry, AnalysisReportSummary, SystemHealthSummary, StateDiff } from '../../../types/autonomous-brain';

// P3 升级：绝对白名单制 — Intent Registry 取代原始命令
import { executeIntent, getIntentSummaryForPrompt, getIntentSummaryForPromptFiltered, listIntentCategories, getRegisteredIntents, IntentParams, IntentCategory, classifyIntentError } from './intentRegistry';

// P2 Supplements: Missing tools integration targets
import { alertPipeline } from '../alertPipeline';
import { patternLearner } from '../patternLearner';
import { decisionEngine } from '../decisionEngine';
import { knowledgeGraphBuilder } from '../knowledgeGraphBuilder';
import type { DecisionType } from '../../../types/ai-ops';

// StateMachineOrchestrator 通过 alertPipeline 已持有实例
// 使用延迟获取的方式复用系统中唯一的 orchestrator
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
function getOrchestrator(): any {
    // 使用 alertPipeline 的公开 getter 获取编排器实例
    const orch = alertPipeline.getStateMachineOrchestrator();
    if (!orch) {
        throw new Error('StateMachineOrchestrator not initialized yet. AlertPipeline may not be fully started.');
    }
    return orch;
}

/**
 * P9: 合法的知识类型
 */
const VALID_KNOWLEDGE_TYPES = ['remediation', 'pattern', 'rule', 'other'] as const;
type KnowledgeType = typeof VALID_KNOWLEDGE_TYPES[number];

function isValidKnowledgeType(type: string): type is KnowledgeType {
    return (VALID_KNOWLEDGE_TYPES as readonly string[]).includes(type);
}

// ====================================================================
// 意图语义路由：当前 Tick 注入的类别（Brain 单例 + 串行 tick，模块级变量安全）
// ====================================================================

/** 当前 Tick 注入到 Prompt 的意图类别集合，由 Brain 在每次 tick 前设置 */
let _currentInjectedCategories: Set<IntentCategory> = new Set();

/**
 * 由 AutonomousBrainService 在每次 tick 构建 Prompt 后调用，
 * 记录本轮注入的类别，供 execute_intent 工具做优雅降级判断
 */
export function setCurrentInjectedCategories(categories: IntentCategory[]): void {
    _currentInjectedCategories = new Set(categories);
}

/**
 * 🔴 FIX: 动态 Tool Schema — 多设备时强制 device 为必填
 * 由 AutonomousBrainService 在每次 tick 构建 Prompt 前调用，
 * 根据当前受管设备数量动态修改 execute_intent 的 device required 状态。
 * 效果：LLM 的 Function Calling 机制会强制生成 device 字段，从源头提高传参率。
 */
export function updateDeviceRequirement(managedDeviceCount: number): void {
    const isMultiDevice = managedDeviceCount > 1;
    executeIntentTool.parameters.device = {
        type: 'string',
        description: isMultiDevice
            ? '【强制必填】目标设备标识符。必须使用 Managed Devices 列表中的 [设备名称] 或 [主机 IP]。例如: "Router-Main" 或 "192.168.88.1"。"UUID" 仅作为后备支持。'
            : '目标设备标识符。当 Managed Devices 列表不为空时，建议填入 [设备名称] 或 [IP]。只有列表为空（单设备模式）时可省略。',
        required: isMultiDevice,
    };
    // [DELETE] 移除旧的参数名引用，防止 Schema 膨胀
    delete executeIntentTool.parameters.deviceId;
}

/**
 * 辅助：将设备标识符（Name/IP/ID）解析为内部 UUID
 * 策略：如果是 UUID 则直接返回；否则查询 DeviceManager 做模糊匹配
 * 用于 execute_intent 和 invoke_skill 工具
 */
async function resolveDeviceLabel(label: string): Promise<{ id: string } | { error: string, brainHint?: string }> {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_REGEX.test(label)) {
        return { id: label };
    }

    try {
        const { serviceRegistry } = await import('../../serviceRegistry');
        const { SERVICE_NAMES } = await import('../../bootstrap');
        const deviceManager = await serviceRegistry.getAsync<{ getDevices(tenantId: string, filter?: any, options?: any): Promise<any[]> }>(SERVICE_NAMES.DEVICE_MANAGER);
        const allDevices = await deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
        
        const matchedDevices = allDevices.filter((d: any) =>
            (d.name && d.name.toLowerCase() === label.toLowerCase()) ||
            (d.host === label) ||
            (d.id === label)
        );

        if (matchedDevices.length > 1) {
            const ambiguousList = matchedDevices
                .slice(0, 5)
                .map((d: any) => `name="${d.name}" host="${d.host}"`)
                .join(', ');
            return {
                error: `[PARAM_VALIDATION] 标识符 "${label}" 匹配到 ${matchedDevices.length} 个设备，存在歧义。请使用更精确的设备名称或 IP。匹配列表: ${ambiguousList}`,
                brainHint: `"${label}" 对应多个设备，请从 Managed Devices 列表中复制唯一的设备名称或主机 IP。`
            };
        }

        const matched = matchedDevices.length === 1 ? matchedDevices[0] : null;
        if (matched) {
            return { id: matched.id };
        }

        const MAX_HINT_LIST = 10;
        const deviceList = allDevices.length > MAX_HINT_LIST
            ? `${allDevices.slice(0, MAX_HINT_LIST).map((d: any) => `${d.name} (${d.host})`).join(', ')}...`
            : allDevices.map((d: any) => `${d.name} (${d.host})`).join(', ');

        return {
            error: `[PARAM_VALIDATION] 无法识别设备 "${label}"。请确保设备已连接并在受管列表中。`,
            brainHint: `请直接使用 Managed Devices 列表中的 [设备名称] 或 [主机 IP]。可选: ${deviceList}`
        };
    } catch (err) {
        return { error: `[PARAM_VALIDATION] 设备解析故障: ${err instanceof Error ? err.message : String(err)}` };
    }
}

// ====================================================================
// 1. 设备操作工具（绝对白名单制）
// 师傅教导：大脑只生成结构化 Intent，服务端翻译为命令
// 未注册的 Intent 一律丢弃，根治 AI 幻觉安全风险
// ====================================================================

export const executeIntentTool: AgentTool = {
    name: 'execute_intent',
    description: `通过结构化意图（Intent）对 RouterOS 设备执行操作。你不允许生成原始命令，只能从白名单中选择合法意图。\n合法意图列表已在 System Prompt 中提供。未注册意图一律被拒绝。\n⚠️ 注意：如果设备连接状态为 error/disconnected，请勿调用此工具，改用 send_notification 通知管理员。`,
    parameters: {
        action: {
            type: 'string',
            description: '白名单意图名称。合法的 action 值已在 System Prompt 的 [REGISTERED INTENTS] 区段完整列出，必须从中逐字复制，禁止自造名称。',
            required: true,
        },
        target: {
            type: 'string',
            description: '操作目标（接口名、规则 ID 等，具体取决于意图的参数要求）',
            required: false,
        },
        device: {
            type: 'string',
            description: '目标设备标识符。请从 Managed Devices 列表中复制 [设备名称] 或 [主机 IP]。',
            required: false,
        },
        deviceName: {
            type: 'string',
            description: '目标设备名称。建议优先使用此参数或 ip。',
            required: false,
        },
        ip: {
            type: 'string',
            description: '目标设备的主机 IP（如 192.168.88.1）。',
            required: false,
        },
        paramsJson: {
            type: 'string',
            description: '可选的额外参数 JSON（如 {"chain": "forward", "action": "drop"}）',
            required: false,
        },
        justification: {
            type: 'string',
            description: '执行该操作的理由（特别是高危操作必须填写）',
            required: true,
        }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { action, target, device, deviceName, ip, paramsJson, justification } = params as {
                action: string; 
                target?: string; 
                device?: string; 
                deviceName?: string; 
                ip?: string; 
                paramsJson?: string; 
                justification: string;
            };

            // 解析额外参数
            let intentParams: IntentParams = {};
            if (target) intentParams.target = target;
            
            // 🔴 FIX: 过滤非法设备标识符（如 tick ID、请求 ID 等内部标识符）
            // LLM 可能从 Prompt 上下文中错误提取这些值作为设备名称
            const INTERNAL_ID_PATTERN = /^(tick-\d+-\d+|req-|session-|ctx-)/i;
            
            // 🔴 FIX: 多个设备标识符并存时报错，避免静默路由到错误设备
            const providedIdentifiers = [deviceName, ip, device].filter(Boolean);
            if (providedIdentifiers.length > 1) {
                return {
                    success: false,
                    error: `[PARAM_VALIDATION] 提供了多个设备标识符 (deviceName="${deviceName}", ip="${ip}", device="${device}")，存在歧义。请只提供一个。`,
                    _brainHint: `You provided multiple device identifiers. Please choose only one: deviceName, ip, or device.`,
                };
            }

            // 优先顺序：deviceName > ip > device
            const rawLabel = (deviceName || ip || device || '').trim();
            const trimmedLabel = INTERNAL_ID_PATTERN.test(rawLabel) ? '' : rawLabel;
            if (INTERNAL_ID_PATTERN.test(rawLabel)) {
                logger.warn(`[Brain Intent] 🚫 Filtered internal ID as device label: "${rawLabel}". LLM误用了内部标识符作为设备名。`);
            }
            if (trimmedLabel) {
                intentParams.deviceId = trimmedLabel;
                intentParams.originalDeviceId = trimmedLabel;
            }
            // tenantId 由 intentRegistry 从 DB 自动解析，此处不传递
            if (paramsJson) {
                try {
                    const parsed = JSON.parse(paramsJson) as Record<string, unknown>;
                    // 🟢 FIX 1.10: 结构化参数在后，确保 deviceId/target/tenantId 不被 LLM JSON 覆盖
                    intentParams = { ...parsed, ...intentParams };
                } catch {
                    return { success: false, error: '[PARAM_VALIDATION] paramsJson 解析失败，必须是合法 JSON' };
                }
            }

            // ═══════════════════════════════════════════════════════════════════
            // 设备标识符解析：LLM 使用 Name 或 IP
            // 策略：优先解析为真实 UUID；如果是 UUID 格式则直接通过
            // 🔴 FIX: 解析失败时，如果有 tickDeviceId 则降级到它，而不是直接报错退出
            // ═══════════════════════════════════════════════════════════════════
            if (intentParams.deviceId) {
                const resolution = await resolveDeviceLabel(intentParams.deviceId);
                if ('error' in resolution) {
                    // 降级策略：如果有 tickDeviceId 可用，使用它代替失败的 label
                    if (params.tickDeviceId) {
                        logger.warn(`[Brain Intent] 🔧 Device label "${intentParams.deviceId}" resolution failed. Falling back to tickDeviceId.`, {
                            originalError: resolution.error,
                        });
                        intentParams.deviceId = params.tickDeviceId as string;
                    } else {
                        return {
                            success: false,
                            error: resolution.error,
                            _brainHint: resolution.brainHint
                        };
                    }
                } else {
                    logger.info(`[Brain Intent] 🔧 Resolved device: "${intentParams.deviceId}" → (Internal UUID Masked)`);
                    intentParams.deviceId = resolution.id;
                }
            }

            // 🔴 FIX v2: 多设备补全（系统层兜底）
            if (!intentParams.deviceId && params.tickDeviceId) {
                intentParams.deviceId = params.tickDeviceId as string;
                logger.debug(`[Brain Intent] 🔧 Auto-injected tickDeviceId (Internal UUID)`);
            }

            // _client 注入策略（单设备模式 — 无受管设备 或 仅 1 台受管设备时）
            // intentRegistry 的路由逻辑：
            //   - 有 _client → 跳过 DevicePool 路由，直接使用 _client 执行
            //   - 有 deviceId + 无 _client → 强制走 DevicePool（Route A）
            //   - 无 deviceId + 无 _client + 无受管设备 → 单设备模式，使用全局 routerosClient
            // 🔴 FIX: 当只有 1 台受管设备时，也注入 _client 走单机模式
            // 原因：单台设备可能通过全局 routerosClient 连接（非 DevicePool），Route A 会失败
            // 注入条件：Brain tick 提供了 routerosClient，且 deviceId 是系统自动补全的（等于 tickDeviceId）
            if (params.routerosClient && !intentParams.deviceId) {
                // 无受管设备的纯单机模式
                intentParams._client = params.routerosClient as RouterOSClient;
                logger.debug(`[Brain Intent] Single-device mode (no managed devices): injecting tick-level routerosClient.`);
            } else if (params.routerosClient && intentParams.deviceId && params.tickDeviceId
                       && intentParams.deviceId === params.tickDeviceId) {
                // 单台受管设备：deviceId 是系统自动补全的（等于 tickDeviceId），注入 _client 作为单机模式后备
                // intentRegistry 会优先使用 _client，跳过 DevicePool Route A
                intentParams._client = params.routerosClient as RouterOSClient;
                logger.debug(`[Brain Intent] Single managed device mode: injecting routerosClient as standalone fallback (deviceId === tickDeviceId).`);
            }

            logger.info(`[Brain Intent] action="${action}", justification="${justification}"`, {
                intentParams: { ...intentParams, _client: undefined, justification }
            });

            // ── 未注入意图动态类别扩展（需求 1.7）──────────────────────────────────
            // 当前 Prompt 只注入了部分类别的意图（≤20个）。
            // 如果 LLM 请求的 action 在注册表中存在，但不属于本轮注入的类别，
            // 🔴 FIX 1.7: 自动扩展类别并执行，而不是返回拒绝
            if (_currentInjectedCategories.size > 0) {
                const allIntents = getRegisteredIntents();
                const requestedIntent = allIntents.find(i => i.action === action);
                if (requestedIntent) {
                    const isInjected = requestedIntent.category.some(c => _currentInjectedCategories.has(c));
                    if (!isInjected) {
                        const intentCats = requestedIntent.category.join(', ');
                        const injectedCats = Array.from(_currentInjectedCategories).join(', ');
                        // 动态扩展：将缺失的类别加入当前注入集合，然后继续执行
                        for (const cat of requestedIntent.category) {
                            _currentInjectedCategories.add(cat);
                        }
                        logger.info(`[Brain Intent] Dynamic category expansion: "${action}" (categories: ${intentCats}) auto-expanded into current context (was: ${injectedCats}, now: ${Array.from(_currentInjectedCategories).join(', ')})`);
                        // 不 return — 继续往下执行白名单逻辑
                    }
                }
            }

            // 白名单执行——intentRegistry 内部处理未注册拒绝、参数校验、审批拦截、连接预检
            const result = await executeIntent(action, intentParams);

            // UNKNOWN_INTENT：LLM 自造了不存在的意图名，返回完整白名单列表供下一轮重试
            if (!result.success && result.errorCode === 'UNKNOWN_INTENT') {
                const validActions = getRegisteredIntents().map(i => i.action).join(', ');
                return {
                    ...result,
                    _brainHint: `"${action}" 不在白名单中。合法的 action 值（必须逐字复制）：${validActions}`,
                };
            }

            // 🔴 FIX 5: 当设备断开时，返回明确的指导信息，帮助大脑在后续 OODA 循环中避免重复调用
            if (!result.success && result.errorCode && ['DEVICE_DISCONNECTED', 'DEVICE_UNREACHABLE', 'CONNECTION_REFUSED'].includes(result.errorCode)) {
                logger.warn(`[Brain Intent] Device connectivity issue detected (${result.errorCode}). Brain should avoid retrying execute_intent until device recovers.`);
                return {
                    ...result,
                    _brainHint: `设备连接异常 (${result.errorCode})。在设备恢复连接之前，请勿重复调用 execute_intent。建议使用 send_notification 通知管理员检查设备状态。`,
                };
            }

            // 高危审批时推送通知
            if (result.status === 'pending_approval') {
                try {
                    const channels = await notificationService.getChannels();
                    const enabledIds = channels.filter(c => c.enabled).map(c => c.id);
                    if (enabledIds.length > 0) {
                        await notificationService.send(enabledIds, {
                            type: 'alert',
                            title: '🧠 大脑请求高危操作审批',
                            body: `意图: ${action}\n目标: ${target || 'N/A'}\n理由: ${justification}\n风险: ${result.riskLevel}\n审批ID: ${result.approvalId}`,
                        });
                    }
                } catch (notifyErr) {
                    logger.warn('Failed to send approval notification', { error: notifyErr });
                    // 🟢 FIX: 通知失败不再静默吞没 — 将失败信息附加到返回结果，让大脑知晓
                    return {
                        ...result,
                        notificationFailed: true,
                        notificationError: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
                    };
                }
                // FIX: 不再覆盖 approvalId，使用 intentRegistry 返回的真实 ID
            }

            return result;
        } catch (error) {
            const errMessage = error instanceof Error ? error.message : String(error);
            const errorCode = classifyIntentError(errMessage);
            logger.error(`[Brain Intent] ❌ execute failed: ${errMessage} (errorCode=${errorCode})`);
            return {
                success: false,
                error: `[${errorCode}] ${errMessage}`,
                errorCode
            };
        }
    }
};

// ====================================================================
// 2. 技能调用工具
// ====================================================================

export const invokeSkillTool: AgentTool = {
    name: 'invoke_skill',
    description: '调用特定的专家技能来处理特定领域的次级任务。',
    parameters: {
        skillName: {
            type: 'string',
            description: '要调用的技能名称',
            required: true,
        },
        input: {
            type: 'string',
            description: '发给该技能的具体任务指令或上下文描述',
            required: true,
        },
        deviceName: {
            type: 'string',
            description: '目标设备名称（可选，若技能需要操作特定设备）',
            required: false,
        },
        ip: {
            type: 'string',
            description: '目标设备 IP（可选）',
            required: false,
        }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { skillName, input } = params as { skillName: string, input: string };

            // 🔴 FIX 1.9: 动态验证技能名称（每次调用时从 skillManager 获取最新列表）
            const availableSkills = skillManager.listSkills({ enabled: true });
            const skillNames = availableSkills
                .map(s => s.metadata?.name)
                .filter((n): n is string => typeof n === 'string' && n.length > 0);

            logger.info(`Brain invoking skill: ${skillName}`);
            const skill = await skillManager.getSkill(skillName);

            if (!skill) {
                return {
                    success: false,
                    error: `技能 "${skillName}" 不存在。当前已注册技能: [${skillNames.join(', ')}]`,
                    _brainHint: `技能 "${skillName}" 未找到。请从以下列表中选择: ${skillNames.join(' | ')}。如果需要的功能不在列表中，请使用其他工具或跳过此操作。`,
                };
            }

            // P6: 尝试执行技能（如果有 execute 方法）
            if (typeof (skill as any).execute === 'function') {
                try {
                    // P1: 解析目标设备上下文
                    const { deviceName, ip } = params as { deviceName?: string, ip?: string };
                    let deviceLabel = (deviceName || ip || '').trim();
                    let resolvedDeviceId: string | undefined;

                    // 🔴 FIX 1.9: 当 deviceName 和 ip 均未指定时，使用 tickDeviceId 作为默认设备
                    if (!deviceLabel && params.tickDeviceId) {
                        resolvedDeviceId = params.tickDeviceId as string;
                        logger.info(`[Brain Skill] Auto-injected tickDeviceId for ${skillName}`);
                    } else if (deviceLabel) {
                        const resolution = await resolveDeviceLabel(deviceLabel);
                        if ('id' in resolution) {
                            resolvedDeviceId = resolution.id;
                            logger.info(`[Brain Skill] Resolved target device for ${skillName}: "${deviceLabel}" → (Internal UUID Masked)`);
                        } else if (params.tickDeviceId) {
                            // 解析失败时降级到 tickDeviceId
                            resolvedDeviceId = params.tickDeviceId as string;
                            logger.warn(`[Brain Skill] Device "${deviceLabel}" resolution failed, falling back to tickDeviceId`);
                        }
                    }

                    // 🔴 FIX 1.9: 通过 deviceManager 获取 routerosClient
                    let routerosClient: any = params.routerosClient;
                    if (!routerosClient && resolvedDeviceId) {
                        try {
                            const { serviceRegistry } = await import('../../serviceRegistry');
                            const { SERVICE_NAMES } = await import('../../bootstrap');
                            const deviceManager = await serviceRegistry.getAsync<any>(SERVICE_NAMES.DEVICE_MANAGER);
                            if (deviceManager && typeof deviceManager.getClient === 'function') {
                                routerosClient = await deviceManager.getClient(resolvedDeviceId);
                            }
                        } catch (clientErr) {
                            logger.debug(`[Brain Skill] Could not get routerosClient for device ${resolvedDeviceId}: ${clientErr instanceof Error ? clientErr.message : String(clientErr)}`);
                        }
                    }

                    const result = await (skill as any).execute(input, { 
                        deviceId: resolvedDeviceId,
                        deviceName,
                        ip,
                        originalLabel: deviceLabel,
                        routerosClient,
                    });

                    return {
                        success: true,
                        status: 'executed',
                        message: `技能 ${skillName} 已执行完成。${resolvedDeviceId ? '(Target device resolved)' : ''}`,
                        result
                    };
                } catch (execErr) {
                    // 🔴 FIX 1.9: 增加 _brainHint 错误指导
                    const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
                    return {
                        success: false,
                        error: `[EXECUTION_ERROR] 技能 ${skillName} 执行失败: ${errMsg}`,
                        _brainHint: `技能 "${skillName}" 执行失败。建议: 1) 检查参数是否正确; 2) 尝试指定不同的目标设备; 3) 如果技能持续失败，跳过此操作并使用 send_notification 通知管理员。`,
                    };
                }
            }

            return {
                success: true,
                status: 'skill_dispatched',
                message: `技能 ${skillName} 已准备好接管后续子任务。建议大脑通过生成的 prompt 向其下发指令。`,
                skillMetadata: skill.metadata
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: `[EXECUTION_ERROR] ${errMsg}`,
                _brainHint: `invoke_skill 调用异常。建议: 1) 确认技能名称正确; 2) 重试一次; 3) 如果仍然失败，跳过此技能。`,
            };
        }
    }
};

// ====================================================================
// 2.5. read_analysis_report 工具
// ====================================================================

const ANALYSIS_DIR = path.resolve(process.cwd(), 'backend/data/ai-ops/analysis');
const MAX_REPORTS = 7;

export const readAnalysisReportTool: AgentTool = {
    name: 'read_analysis_report',
    description: '读取历史分析报告。接受日期范围参数，从 analysis 目录读取对应日期的 JSON 报告并返回结构化摘要。单次最多返回 7 份完整报告，超出时返回统计摘要。',
    parameters: {
        startDate: {
            type: 'string',
            description: '起始日期，格式 YYYY-MM-DD（含）',
            required: true,
        },
        endDate: {
            type: 'string',
            description: '结束日期，格式 YYYY-MM-DD（含）',
            required: true,
        },
    },
    execute: async (params: Record<string, unknown>): Promise<AnalysisReportSummary> => {
        const { startDate, endDate } = params as { startDate: string; endDate: string };

        let files: string[];
        try {
            files = await fs.readdir(ANALYSIS_DIR);
        } catch {
            return {
                success: false,
                reportCount: 0,
                parseErrors: 0,
                dateRange: { start: startDate, end: endDate },
            };
        }

        // 过滤符合日期范围的文件（YYYY-MM-DD.json）
        const dateRegex = /^(\d{4}-\d{2}-\d{2})\.json$/;
        const matchedFiles = files
            .filter(f => {
                const m = dateRegex.exec(f);
                if (!m) return false;
                const d = m[1];
                return d >= startDate && d <= endDate;
            })
            .sort();

        let parseErrors = 0;
        const reports: AnalysisEntry[] = [];

        for (const file of matchedFiles) {
            try {
                const raw = await fs.readFile(path.join(ANALYSIS_DIR, file), 'utf-8');
                const parsed = JSON.parse(raw) as AnalysisEntry | AnalysisEntry[];
                const entries = Array.isArray(parsed) ? parsed : [parsed];
                reports.push(...entries);
            } catch {
                parseErrors++;
                logger.warn(`[read_analysis_report] Failed to parse file: ${file}`);
            }
        }

        const warning = parseErrors > 0
            ? `${parseErrors} 个报告文件因格式错误未能读取，实际可用报告数量可能少于预期。`
            : undefined;

        if (reports.length > MAX_REPORTS) {
            // 超出上限，返回聚合统计摘要
            const rootCauseMap = new Map<string, number>();
            const impactDist: Record<string, number> = {};
            let totalAlerts = 0;

            for (const entry of reports) {
                totalAlerts += entry.rootCauses?.length ?? 0;
                for (const rc of entry.rootCauses ?? []) {
                    const desc = rc.description ?? 'unknown';
                    rootCauseMap.set(desc, (rootCauseMap.get(desc) ?? 0) + 1);
                }
                const scope = entry.impact?.scope ?? 'unknown';
                impactDist[scope] = (impactDist[scope] ?? 0) + 1;
            }

            const topRootCauses = Array.from(rootCauseMap.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([description, count]) => ({ description, count }));

            return {
                success: true,
                reportCount: reports.length,
                parseErrors,
                warning,
                dateRange: { start: startDate, end: endDate },
                summary: { totalAlerts, topRootCauses, impactDistribution: impactDist },
            };
        }

        return {
            success: true,
            reportCount: reports.length,
            parseErrors,
            warning,
            dateRange: { start: startDate, end: endDate },
            reports,
        };
    },
};

// ====================================================================
// 2.6. compare_state 工具
// ====================================================================

/**
 * 深度对比两个对象，生成结构化 diff
 */
function deepDiff(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    prefix = ''
): StateDiff['changes'] {
    const changes: StateDiff['changes'] = [];
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

    for (const key of allKeys) {
        const fieldPath = prefix ? `${prefix}.${key}` : key;
        const bVal = before[key];
        const aVal = after[key];

        if (bVal === aVal) continue;

        if (
            bVal !== null && aVal !== null &&
            typeof bVal === 'object' && typeof aVal === 'object' &&
            !Array.isArray(bVal) && !Array.isArray(aVal)
        ) {
            // 递归对比嵌套对象
            const nested = deepDiff(
                bVal as Record<string, unknown>,
                aVal as Record<string, unknown>,
                fieldPath
            );
            changes.push(...nested);
        } else {
            let direction: 'increased' | 'decreased' | 'changed' = 'changed';
            let magnitude: number | undefined;

            if (typeof bVal === 'number' && typeof aVal === 'number') {
                if (aVal > bVal) direction = 'increased';
                else if (aVal < bVal) direction = 'decreased';
                if (bVal !== 0) {
                    magnitude = Math.abs(((aVal - bVal) / bVal) * 100);
                } else if (aVal !== 0) {
                    // bVal=0 时无法计算百分比变化，明确标记为不适用（避免 Infinity 污染 JSON）
                    magnitude = undefined;
                }
            }

            changes.push({ field: fieldPath, before: bVal, after: aVal, direction, magnitude });
        }
    }

    return changes;
}

export const compareStateTool: AgentTool = {
    name: 'compare_state',
    description: '对比两个系统状态快照（SystemHealthSummary），生成包含变化字段、变化方向和变化幅度的结构化 diff。',
    parameters: {
        before: {
            type: 'string',
            description: 'SystemHealthSummary 对象的 JSON 字符串，或时间点 ISO 字符串',
            required: true,
        },
        after: {
            type: 'string',
            description: 'SystemHealthSummary 对象的 JSON 字符串，或时间点 ISO 字符串',
            required: true,
        },
    },
    execute: async (params: Record<string, unknown>): Promise<StateDiff | { success: false; error: string }> => {
        const { before, after } = params as { before: unknown; after: unknown };

        const parseSnapshot = (input: unknown): SystemHealthSummary | null => {
            if (typeof input === 'object' && input !== null) {
                return input as SystemHealthSummary;
            }
            if (typeof input === 'string') {
                // 尝试 JSON 解析
                try {
                    return JSON.parse(input) as SystemHealthSummary;
                } catch {
                    // 时间点字符串：暂不支持从缓存查找
                    return null;
                }
            }
            return null;
        };

        const beforeSnap = parseSnapshot(before);
        const afterSnap = parseSnapshot(after);

        if (!beforeSnap) {
            return { success: false, error: '未找到 before 对应时间点的快照，请提供有效的 SystemHealthSummary JSON 或已缓存的时间点。' };
        }
        if (!afterSnap) {
            return { success: false, error: '未找到 after 对应时间点的快照，请提供有效的 SystemHealthSummary JSON 或已缓存的时间点。' };
        }

        const changes = deepDiff(
            beforeSnap as unknown as Record<string, unknown>,
            afterSnap as unknown as Record<string, unknown>
        );

        const summary = changes.length === 0
            ? '两个快照状态完全一致，无变化。'
            : `共发现 ${changes.length} 处变化：${changes.map(c => `${c.field}(${c.direction})`).join(', ')}`;

        return { success: true, changes, summary };
    },
};

// ====================================================================
// 3. 状态机流转控制工具
// ====================================================================

export const triggerStateMachineFlowTool: AgentTool = {
    name: 'trigger_state_machine_flow',
    description: '触发或干预一个状态机工作流（例如：告警排查流 alert-orchestration、故障防御流 react-orchestration）。',
    parameters: {
        machineId: {
            type: 'string',
            description: '工作流引擎 ID（如：alert-orchestration-machine）',
            required: true,
        },
        event: {
            type: 'string',
            description: '要发送给状态机的事件名称，如 START_DIAGNOSIS, CONFIRM_HEALING',
            required: true,
        },
        payload: {
            type: 'string',
            description: '事件的 JSON 格式 Payload 数据',
            required: false,
        }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { machineId, event, payload } = params as { machineId: string, event: string, payload?: string };

            let parsedPayload = {};
            if (payload) {
                try { parsedPayload = JSON.parse(payload); } catch {
                    return { success: false, error: `[PARAM_VALIDATION] payload JSON 解析失败，请提供合法的 JSON 字符串。收到: ${payload}` };
                }
            }

            logger.info(`Brain dispatching execution payload to StateMachine [${machineId}]`, { event, payload: parsedPayload });

            let orchestrator;
            try {
                orchestrator = getOrchestrator();
            } catch {
                return { success: false, error: '[SERVICE_NOT_READY] StateMachineOrchestrator 尚未初始化，AlertPipeline 可能未完全启动。请稍后重试。' };
            }
            const result = await orchestrator.execute(machineId, { event, ...parsedPayload });

            return {
                success: true,
                message: `事件 ${event} 已发送至状态机 ${machineId} 并且进入执行链路。`,
                dispatched: true,
                executionResult: result
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

// ====================================================================
// 3.5. (P2) 补充的编排控制工具集
// ====================================================================

export const triggerAlertPipelineTool: AgentTool = {
    name: 'trigger_alert_pipeline',
    description: '通过注入合成事件，主动触发告警流水线（AlertPipeline）。常用于大脑巡检发现隐患。',
    parameters: {
        severity: { type: 'string', description: '严重程度: info, warning, critical, emergency', required: true },
        source: { type: 'string', description: '来源标识（例如: brain-inspection）', required: true },
        message: { type: 'string', description: '隐患告警描述', required: true },
        category: { type: 'string', description: '分类（如: network, security, hardware）', required: true },
        deviceId: { type: 'string', description: '目标设备 ID（多设备模式下指定告警关联的设备）', required: false },
        tenantId: { type: 'string', description: '租户 ID（默认 "default"）', required: false },
        metadata: { type: 'string', description: '可选的 JSON 附加上下文数据', required: false }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { severity, source, message, category, deviceId, tenantId, metadata } = params as any;
            let metaObj = {};
            if (metadata) {
                try { metaObj = JSON.parse(metadata); } catch {
                    return { success: false, error: `[PARAM_VALIDATION] metadata JSON 解析失败，请提供合法的 JSON 字符串。收到: ${metadata}` };
                }
            }
            const syntheticEvent = {
                id: `synthetic-${uuidv4()}`,
                type: 'synthetic_alert',
                timestamp: Date.now(),
                severity,
                source,
                message,
                category,
                deviceId: deviceId || undefined,
                tenantId: tenantId || 'default',
                metadata: metaObj
            };
            logger.info('Brain synthetic alert triggered', { syntheticEvent });
            // FIX P1: 添加 _syntheticFromBrain 标记，防止 pipeline 处理后再次唤醒大脑造成无限循环
            await alertPipeline.process({
                id: syntheticEvent.id,
                hostname: 'local',
                severity,
                facility: 'local0',
                message,
                timestamp: syntheticEvent.timestamp,
                raw: message,
                _syntheticFromBrain: true,
                deviceId: deviceId || undefined,
                tenantId: tenantId || 'default',
                ...metaObj
            } as any);
            return { success: true, message: 'Synthetic alert injected successfully' };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

export const extractPatternTool: AgentTool = {
    name: 'extract_pattern',
    description: '命令 PatternLearner 分析特定用户的操作习惯，提取或验证操作模式。',
    parameters: {
        userId: { type: 'string', description: '用户名或 ID (大脑自身可以填 "brain")', required: true },
        action: { type: 'string', description: 'identify (识别新模式) 或 get_recommendations (获取推荐)', required: true }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { userId, action } = params as any;
            if (action === 'identify') {
                const patterns = patternLearner.identifyPatterns(userId);
                return { success: true, count: patterns.length, patterns };
            } else if (action === 'get_recommendations') {
                const context = { userId, sessionId: 'brain-query', recentOperations: [], currentTime: Date.now() };
                const recs = patternLearner.getRecommendations(context);
                return { success: true, count: recs.length, recommendations: recs };
            }
            return { success: false, error: '[PARAM_VALIDATION] Unknown action. 合法值: identify, get_recommendations' };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

export const proposeDecisionRuleTool: AgentTool = {
    name: 'propose_decision_rule',
    description: '大脑自动综合经验，向 DecisionEngine 提审一条新的决策规则。',
    parameters: {
        name: { type: 'string', description: '新规则名称', required: true },
        priority: { type: 'number', description: '优先级 (数字大优先)', required: true },
        conditionsJson: { type: 'string', description: '判断条件数组的 JSON 字符串', required: true },
        action: { type: 'string', description: '动作: auto_execute, notify_and_wait, escalate, silence, auto_remediate, observe', required: true },
    },
    execute: async (params: Record<string, unknown>) => {
        const { name, priority, conditionsJson, action } = params as any;

        let conditions;
        try {
            conditions = JSON.parse(conditionsJson);
        } catch (parseError) {
            const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
            return { success: false, error: `[PARAM_VALIDATION] conditionsJson 解析失败: ${errMsg}` };
        }

        try {
            logger.info(`Brain proposing new decision rule: ${name}`);
            const rule = await decisionEngine.createRule({
                name,
                conditions,
                action: action as DecisionType,
                priority,
                enabled: true,
            });
            return { success: true, message: `Rule ${name} created`, ruleId: rule.id };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

export const queryTopologyTool: AgentTool = {
    name: 'query_topology',
    description: '通过 KnowledgeGraphBuilder 查询网络拓扑的节点依赖关系。',
    parameters: {
        componentId: { type: 'string', description: '要查询的网络节点 / 组件 ID', required: true },
        direction: { type: 'string', description: 'both, upstream, downstream', required: true }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { componentId, direction } = params as { componentId: string, direction: 'both' | 'upstream' | 'downstream' };
            const deps = knowledgeGraphBuilder.queryDependencies(componentId, direction);
            return { success: true, result: deps };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

// ====================================================================
// 4. 知识库 CRUD 管理工具
// ====================================================================

export const manageKnowledgeTool: AgentTool = {
    name: 'manage_knowledge',
    description: '全权管理知识库（LanceDB/BM25）。支持增(add)、删(delete)、改(update)、查(search)。',
    parameters: {
        action: {
            type: 'string',
            description: '操作动作：search, add, update, delete',
            required: true,
        },
        type: {
            type: 'string',
            description: '知识类别：remediation（修复方案）, pattern（故障模式）, rule（规则）, other',
            required: true,
        },
        title: {
            type: 'string',
            description: '知识标题（add 和 update 动作时必须提供）',
            required: false,
        },
        content: {
            type: 'string',
            description: '核心内容或查询语句。search 动作对应查询关键词。其它动作对应正文内容。',
            required: true,
        },
        referenceId: {
            type: 'string',
            description: '更新或删除时的文档参考 ID',
            required: false,
        }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { action, type, title, content, referenceId } = params as { action: string, type: string, title: string, content: string, referenceId?: string };

            // P9: 类型校验
            if (!isValidKnowledgeType(type)) {
                return { success: false, error: `[PARAM_VALIDATION] 无效的知识类型 "${type}"。合法值: ${VALID_KNOWLEDGE_TYPES.join(', ')}` };
            }

            if (!knowledgeBase.isInitialized()) {
                await knowledgeBase.initialize();
            }

            if (action === 'search') {
                const results = await knowledgeBase.search({ query: content, limit: 5 });
                return { success: true, count: results.length, data: results.map(r => ({ id: r.entry.id, title: r.entry.title, score: r.score })) };
            }
            else if (action === 'add') {
                if (!title) {
                    return { success: false, error: '[PARAM_VALIDATION] add 操作需要提供 title' };
                }
                const savedEntry = await knowledgeBase.add({
                    title,
                    content,
                    type: type as any,
                    metadata: { timestamp: Date.now(), source: 'brain-auto', category: type, tags: [], usageCount: 0, feedbackScore: 0, feedbackCount: 0 }
                });
                return { success: true, action: 'added', entryId: savedEntry.id };
            }
            else if (action === 'update') {
                if (!referenceId) {
                    return { success: false, error: '[PARAM_VALIDATION] update 操作需要提供 referenceId' };
                }
                // P6: 使用 knowledgeBase.update 方法更新条目
                try {
                    await knowledgeBase.update(referenceId, {
                        title: title || undefined,
                        content,
                        metadata: { timestamp: Date.now(), source: 'brain-auto-update' } as any
                    });
                    return { success: true, action: 'updated', entryId: referenceId };
                } catch (updateErr) {
                    return { success: false, error: `[EXECUTION_ERROR] 更新失败: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}` };
                }
            }
            else if (action === 'delete') {
                if (!referenceId) {
                    return { success: false, error: '[PARAM_VALIDATION] delete 操作需要提供 referenceId' };
                }
                try {
                    await knowledgeBase.delete(referenceId);
                    return { success: true, action: 'deleted', entryId: referenceId };
                } catch (deleteErr) {
                    return { success: false, error: `[EXECUTION_ERROR] 删除失败: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}` };
                }
            }
            else {
                return { success: false, error: `[PARAM_VALIDATION] 未知操作: ${action}。合法操作: search, add, update, delete` };
            }
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

// ====================================================================
// 5. 通讯与通知工具
// ====================================================================

export const sendNotificationTool: AgentTool = {
    name: 'send_notification',
    description: '向管理员发送通知。消息会同时推送到所有已启用的通知渠道（前端推送、邮件、企业微信/钉钉 Webhook 等）。各渠道根据自身配置的 severityFilter 自动过滤——例如邮件可能只接收 warning 及以上级别。',
    parameters: {
        type: {
            type: 'string',
            description: '通知类型：alert (告警事件), recovery (故障恢复), report (巡检/分析报告), remediation (修复操作通知)',
            required: true,
        },
        severity: {
            type: 'string',
            description: '严重级别：info (信息), warning (警告), critical (严重), emergency (紧急)。各通知渠道会根据此级别过滤是否发送。',
            required: true,
        },
        message: {
            type: 'string',
            description: '正文内容',
            required: true,
        }
    },
    execute: async (params: Record<string, unknown>) => {
        try {
            const { type: notifType, severity, message } = params as { type: string, severity: string, message: string };

            // 兼容旧参数名（LLM 可能仍使用 channel/level）
            const resolvedType = notifType || (params.channel as string) || 'report';
            const resolvedSeverity = severity || (params.level as string) || 'info';

            const typeMap: Record<string, string> = { frontend: 'report', system: 'report', alert: 'alert' };
            const finalType = typeMap[resolvedType] || resolvedType;
            const validTypes = ['alert', 'recovery', 'report', 'remediation'];
            const safeType = validTypes.includes(finalType) ? finalType : 'report';

            const validSeverities = ['info', 'warning', 'critical', 'emergency'];
            const safeSeverity = validSeverities.includes(resolvedSeverity) ? resolvedSeverity : 'info';

            const titlePrefix = safeSeverity === 'emergency' ? '🚨 紧急' : safeSeverity === 'critical' ? '🔴 严重' : safeSeverity === 'warning' ? '⚠️ 警告' : 'ℹ️';
            const title = `${titlePrefix} 大脑通知 [${safeType}]`;

            logger.info(`[Brain Notification] type=${safeType} severity=${safeSeverity}: ${message.slice(0, 100)}`);

            const channels = await notificationService.getChannels();
            const enabledIds = channels.filter(c => c.enabled).map(c => c.id);

            if (enabledIds.length === 0) {
                return {
                    success: true,
                    status: 'no_channels',
                    message: '没有已启用的通知渠道，消息已记录到系统日志。',
                    deliveredTo: 'system_log_only',
                };
            }

            const sendResult = await notificationService.send(enabledIds, {
                type: safeType as 'alert' | 'recovery' | 'report' | 'remediation',
                title,
                body: message,
                data: { severity: safeSeverity, source: 'autonomous-brain' },
            }, safeSeverity);

            // 构建投递摘要
            const deliveredChannels = channels
                .filter(c => c.enabled && !sendResult.failedChannels.includes(c.id))
                .filter(c => !sendResult.skippedChannels || !sendResult.skippedChannels.includes(c.id))
                .map(c => `${c.name}(${c.type})`);
            const skippedChannels = (sendResult.skippedChannels || [])
                .map(id => channels.find(c => c.id === id))
                .filter(Boolean)
                .map(c => `${c!.name}(${c!.type})`);

            if (!sendResult.success) {
                return {
                    success: false,
                    error: `[NOTIFICATION_PARTIAL_FAILURE] 部分渠道发送失败: ${sendResult.failedChannels.join(', ')}`,
                    delivered: deliveredChannels,
                    skipped: skippedChannels,
                    failed: sendResult.failedChannels,
                };
            }

            return {
                success: true,
                status: 'sent',
                delivered: deliveredChannels,
                skipped: skippedChannels,
                message: skippedChannels.length > 0
                    ? `已发送到 ${deliveredChannels.length} 个渠道，${skippedChannels.length} 个渠道因 severityFilter 跳过`
                    : `已发送到 ${deliveredChannels.length} 个渠道`,
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    }
};

// ====================================================================
// 6. 意图类别查询工具（IntentSemanticRouter 配套）
// ====================================================================

export const listIntentCategoriesTool: AgentTool = {
    name: 'list_intent_categories',
    description: '列出所有可用的意图类别及其描述。当你需要执行的意图未出现在当前 Prompt 的 [REGISTERED INTENTS] 区段时，调用此工具查看所有类别，系统将在下一轮 Tick 根据场景自动注入对应类别的意图。',
    parameters: {},
    execute: async (_params: Record<string, unknown>) => {
        try {
            const categories = listIntentCategories();
            return {
                success: true,
                categories: categories.map(c => ({
                    name: c.name,
                    description: c.description,
                    riskRange: c.riskRange,
                })),
                hint: '如需使用某类别的意图，请在下一轮 Tick 中描述你的操作意图，系统会根据场景自动注入对应类别。',
            };
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `[EXECUTION_ERROR] ${errMsg}` };
        }
    },
};

// 在所有 registerIntent() 调用完成后，将完整白名单枚举注入到工具参数描述
// intentRegistry 不依赖 brainTools，无循环依赖，此处调用安全
// 目的：LLM 填写 action 参数时能直接看到完整枚举，从源头杜绝自造意图名
executeIntentTool.parameters.action = {
    type: 'string',
    description: `必须从以下合法意图中选择，禁止使用未列出的名称：\n${getRegisteredIntents().map(i => i.action).join(' | ')}`,
    required: true,
};

// 🔴 FIX 1.9: 删除 setTimeout 一次性注入，改为动态更新函数
// 由 AutonomousBrainService 在每次 tick 的 buildPrompt 之前调用
/**
 * 动态更新 invoke_skill 工具的描述和参数中的可用技能列表
 * 确保每次 tick 时技能列表都是最新的（技能可能在运行时增删）
 */
export function updateSkillToolDescription(): void {
    try {
        const skills = skillManager.listSkills({ enabled: true });
        if (skills.length > 0) {
            const skillList = skills
                .map(s => `${s.metadata.name}${s.metadata.description ? ' — ' + s.metadata.description : ''}`)
                .join('\n');
            invokeSkillTool.description = `调用特定的专家技能来处理特定领域的次级任务。\n可用技能列表：\n${skillList}`;
            invokeSkillTool.parameters.skillName = {
                type: 'string',
                description: `必须从以下已注册技能中选择，禁止使用未列出的名称：\n${skills.map(s => s.metadata.name).join(' | ')}`,
                required: true,
            };
        } else {
            invokeSkillTool.description = '调用特定的专家技能来处理特定领域的次级任务。（当前无可用技能）';
        }
    } catch (err) {
        logger.warn(`[brainTools] Failed to update skill list in invoke_skill: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export const brainTools: AgentTool[] = [
    executeIntentTool,
    invokeSkillTool,
    readAnalysisReportTool,
    compareStateTool,
    triggerStateMachineFlowTool,
    triggerAlertPipelineTool,
    extractPatternTool,
    proposeDecisionRuleTool,
    queryTopologyTool,
    manageKnowledgeTool,
    sendNotificationTool,
    listIntentCategoriesTool,
];

/** 导出 Intent 列表摘要，供 System Prompt 使用 */
export { getIntentSummaryForPrompt, getIntentSummaryForPromptFiltered, listIntentCategories };
export type { IntentCategory };
