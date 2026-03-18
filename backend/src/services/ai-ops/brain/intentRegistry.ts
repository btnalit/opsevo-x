/**
 * Intent Registry — 绝对白名单制
 * 
 * 大脑只生成结构化的 JSON Intent，服务端翻译为 RouterOS 命令。
 * 未注册的 Intent 一律丢弃，根治 AI 幻觉安全风险。
 * 
 * 设计原则（师傅教导）：
 * - 不要试图限制 AI "不能想什么"，而是严格限制系统"只接受什么"
 * - 大脑绝不能生成原始 RouterOS 命令行脚本
 * - 每个合法意图都有完整的解析、校验、执行路径
 */

import { routerosClient, RouterOSClient } from '../../routerosClient';
import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { serviceRegistry } from '../../serviceRegistry';
import { SERVICE_NAMES } from '../../bootstrap';

// ====================================================================
// 类型定义
// ====================================================================

export type IntentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ====================================================================
// 意图类别（IntentSemanticRouter）
// ====================================================================

export type IntentCategory =
    | 'network_query'
    | 'firewall_ops'
    | 'system_config'
    | 'system_danger'
    | 'dhcp_dns'
    | 'monitoring'
    | 'routing';

export interface IntentCategoryMeta {
    name: IntentCategory;
    description: string;
    riskRange: [IntentRiskLevel, IntentRiskLevel];
}

const INTENT_CATEGORY_META: IntentCategoryMeta[] = [
    { name: 'network_query', description: '网络状态查询（接口、IP、ARP、连接等只读操作）', riskRange: ['low', 'low'] },
    { name: 'firewall_ops', description: '防火墙规则管理（过滤、NAT、地址列表的增删改查）', riskRange: ['low', 'critical'] },
    { name: 'system_config', description: '系统配置变更（DNS、NTP、队列、IP 地址等中风险操作）', riskRange: ['medium', 'medium'] },
    { name: 'system_danger', description: '高危系统操作（重启、关机、重置配置、系统升级）', riskRange: ['critical', 'critical'] },
    { name: 'dhcp_dns', description: 'DHCP/DNS 配置与租约管理', riskRange: ['low', 'medium'] },
    { name: 'monitoring', description: '系统监控与健康检查（资源、日志、健康状态等只读操作）', riskRange: ['low', 'low'] },
    { name: 'routing', description: '路由表管理（静态路由增删）', riskRange: ['medium', 'high'] },
];

/** Intent 解析器的输入参数 */
export interface IntentParams {
    target?: string;       // 目标资源（接口名、IP地址、规则 ID 等）
    deviceId?: string;     // 多设备模式：目标设备 ID（内部解析后为 UUID）
    /** AI 提供的原始设备标识符（名称或 IP），用于返回给 AI 的反馈信息，防止 UUID 泄漏 */
    originalDeviceId?: string;
    /** @internal 由 executeIntent 注入的设备专属客户端，resolver 优先使用 */
    _client?: RouterOSClient;
    /** @internal add_firewall_rule resolver 写回的唯一 comment，供 checkFn 精确匹配 */
    _verifyComment?: string;
    [key: string]: unknown;
}

/**
 * 获取 Intent 应使用的 RouterOS 客户端
 * 优先使用 params._client（由 executeIntent 通过 DevicePool 注入），
 * 不存在时回退到全局 routerosClient（向后兼容）
 */
function getClient(params: IntentParams): RouterOSClient {
    return (params._client as RouterOSClient) || routerosClient;
}

/**
 * 🔴 FIX 3: 连接预检 — 在调用 resolver 之前验证客户端连接状态
 * 避免深入 resolver 内部才发现断开，提供清晰的结构化错误。
 * @note 这是一个 TOCTOU (Time-of-check to time-of-use) 检查。在检查和使用之间，连接仍可能断开。
 *       因此，外层的 try/catch 依然是必须的最终保障。
 */
function preflightConnectivityCheck(client: RouterOSClient): { ok: boolean; errorCode?: IntentErrorCode; errorMsg?: string } {
    try {
        if (!client.isConnected()) {
            const config = client.getConfig();
            const host = config?.host || 'unknown';
            return {
                ok: false,
                errorCode: 'DEVICE_DISCONNECTED',
                errorMsg: `[DEVICE_DISCONNECTED] 设备 ${host} 的 RouterOS 连接已断开。请检查设备状态或等待自动重连。`,
            };
        }
        return { ok: true };
    } catch {
        return {
            ok: false,
            errorCode: 'DEVICE_DISCONNECTED',
            errorMsg: '[DEVICE_DISCONNECTED] 无法检查设备连接状态。',
        };
    }
}

/**
 * 🔴 FIX 4: 从错误消息推断结构化错误码
 * 覆盖中文和英文错误消息，确保反思系统能正确分类
 * @note 匹配顺序很重要：更具体的错误类型（超时、认证）优先于通用连接错误（socket/closed）
 */
export function classifyIntentError(errMsg: string): IntentErrorCode {
    const lower = errMsg.toLowerCase();
    // 1. 优先匹配更具体的错误
    // 租户 ID 不匹配（DevicePool TENANT_ID_MISMATCH）— 必须在通用 FORBIDDEN 之前检查
    if (lower.includes('tenant_id_mismatch') || lower.includes('租户 id 不匹配')) {
        return 'FORBIDDEN'; // 对外仍用 FORBIDDEN，但内部原因更精确
    }
    // 权限拒绝（其他 forbidden 场景）— 必须在通用连接错误之前检查
    if (lower.includes('无权访问') || lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('access denied')) {
        return 'FORBIDDEN';
    }
    // 超时
    if (lower.includes('timeout') || lower.includes('超时') || lower.includes('etimedout') || lower.includes('timed out')) {
        return 'TIMEOUT';
    }
    // 认证失败
    if (lower.includes('密码错误') || lower.includes('invalid user') || lower.includes('cannot log in') || lower.includes('login failure')) {
        return 'AUTH_FAILURE';
    }
    // 连接被拒绝
    if (lower.includes('econnrefused') || lower.includes('无法连接') || lower.includes('connection refused')) {
        return 'CONNECTION_REFUSED';
    }
    // 设备不可达（DNS/路由问题）
    if (lower.includes('device_unreachable') || lower.includes('enotfound') || lower.includes('无法解析')) {
        return 'DEVICE_UNREACHABLE';
    }
    // 2. 然后匹配更通用的连接状态错误
    // 连接断开
    if (lower.includes('not connected') || lower.includes('连接已断开') || lower.includes('closed') || lower.includes('socket')) {
        return 'DEVICE_DISCONNECTED';
    }
    return 'EXECUTION_ERROR';
}

/** 每个合法意图的注册信息 */
export interface RegisteredIntent {
    action: string;
    description: string;
    riskLevel: IntentRiskLevel;
    requiresApproval: boolean;
    /** 参数校验：列出合法参数名及是否必填 */
    paramSchema: Record<string, { required: boolean; description: string }>;
    /** 意图解析器：将参数翻译为安全的 RouterOS API 调用 */
    resolver: (params: IntentParams) => Promise<unknown>;
    /** 意图所属类别（可属于多个类别），用于按场景按需注入 */
    category: IntentCategory[];
}

/** 结构化错误码 — 让反思系统无需正则即可分类失败原因 */
export type IntentErrorCode =
    | 'UNKNOWN_INTENT'       // 未注册的意图
    | 'PARAM_VALIDATION'     // 参数校验失败
    | 'DEVICE_UNREACHABLE'   // 设备不可达（DevicePool 获取失败）
    | 'DEVICE_DISCONNECTED'  // 设备连接已断开（全局客户端或设备客户端未连接）
    | 'REQUIRES_APPROVAL'    // 高危操作等待审批
    | 'EXECUTION_ERROR'      // resolver 执行时抛出异常
    | 'TIMEOUT'              // 执行超时
    | 'CONNECTION_REFUSED'   // 连接被拒绝
    | 'AUTH_FAILURE'         // 认证失败
    | 'FORBIDDEN';           // tenantId 不匹配，无权访问该设备连接

/** Intent 执行结果 */
export interface IntentResult {
    success: boolean;
    action: string;
    riskLevel: IntentRiskLevel;
    status: 'executed' | 'pending_approval' | 'rejected';
    output?: unknown;
    error?: string;
    /** 结构化错误码，供反思系统直接分类，无需正则匹配 */
    errorCode?: IntentErrorCode;
    approvalId?: string;
    /** 验证指令 — medium+ 风险意图执行成功后附加，要求 ReAct 循环执行验证 */
    verification_directive?: VerificationDirective;
}

/**
 * 验证指令 — 附加到 IntentResult 上，指示 ReAct 循环在下一步执行验证查询
 * 需求 3.1, 3.3, 3.6
 */
export interface VerificationDirective {
    /** 用于验证的意图动作名（必须是已注册的查询类意图） */
    verify_action: string;
    /** 验证查询所需的参数（从原始操作参数派生） */
    verify_params: Record<string, unknown>;
    /** 验证通过的期望条件描述（自然语言，供 LLM 判断） */
    expected_condition: string;
    /** 验证超时（ms），超时后自动执行验证 */
    timeout_ms: number;
}

// ====================================================================
// medium+ 风险意图的验证指令模板（需求 3.6）
// ====================================================================

export const VERIFICATION_DIRECTIVE_TEMPLATES: Record<string, (params: IntentParams) => VerificationDirective> = {
    // ─── 接口操作 ───────────────────────────────────────────────────
    disable_interface: (p) => ({
        verify_action: 'query_interface_detail',
        verify_params: { target: p.target, deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `接口 "${p.target}" 的 disabled 字段应为 true`,
        timeout_ms: 10_000,
    }),
    enable_interface: (p) => ({
        verify_action: 'query_interface_detail',
        verify_params: { target: p.target, deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `接口 "${p.target}" 的 disabled 字段应为 false`,
        timeout_ms: 10_000,
    }),
    // ─── 防火墙操作 ─────────────────────────────────────────────────
    add_firewall_rule: (p) => ({
        verify_action: 'query_firewall_filter',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `防火墙过滤规则列表中应存在 comment 为 "${p._verifyComment}" 的规则`,
        timeout_ms: 10_000,
    }),
    remove_firewall_rule: (p) => ({
        verify_action: 'query_firewall_filter',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `防火墙过滤规则列表中不应存在 .id 为 "${p.target}" 的规则`,
        timeout_ms: 10_000,
    }),
    add_nat_rule: (p) => ({
        verify_action: 'query_firewall_nat',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NAT 规则列表中应存在 comment 为 "${p._verifyComment}" 的规则`,
        timeout_ms: 10_000,
    }),
    remove_nat_rule: (p) => ({
        verify_action: 'query_firewall_nat',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NAT 规则列表中不应存在 .id 为 "${p.target}" 的规则`,
        timeout_ms: 10_000,
    }),
    // ─── 地址列表操作 ───────────────────────────────────────────────
    add_address_list_entry: (p) => ({
        verify_action: 'query_firewall_address_list',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `地址列表 "${p.list as string}" 中应包含地址 "${p.address as string}"`,
        timeout_ms: 10_000,
    }),
    remove_address_list_entry: (p) => ({
        verify_action: 'query_firewall_address_list',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `地址列表中不应存在 .id 为 "${p.target}" 的条目`,
        timeout_ms: 10_000,
    }),
    // ─── DHCP 操作 ──────────────────────────────────────────────────
    add_dhcp_lease: (p) => ({
        verify_action: 'query_dhcp_leases',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `DHCP 租约列表中应存在 MAC "${p.macAddress}" 绑定到 IP "${p.address}" 的静态租约`,
        timeout_ms: 10_000,
    }),
    remove_dhcp_lease: (p) => ({
        verify_action: 'query_dhcp_leases',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `DHCP 租约列表中不应存在 .id 为 "${p.target}" 的租约`,
        timeout_ms: 10_000,
    }),
    // ─── 路由操作 ───────────────────────────────────────────────────
    add_static_route: (p) => ({
        verify_action: 'query_routes',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `路由表中应存在目标网络为 "${p.dstAddress}" 经由网关 "${p.gateway}" 的静态路由`,
        timeout_ms: 10_000,
    }),
    remove_route: (p) => ({
        verify_action: 'query_routes',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `路由表中不应存在 .id 为 "${p.target}" 的路由条目`,
        timeout_ms: 10_000,
    }),
    // ─── 防火墙禁用 ─────────────────────────────────────────────────
    disable_firewall_rule: (p) => ({
        verify_action: 'query_firewall_filter',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `防火墙规则 ID "${p.target}" 的 disabled 字段应为 true`,
        timeout_ms: 10_000,
    }),
    // ─── 队列删除 ───────────────────────────────────────────────────
    remove_queue: (p) => ({
        verify_action: 'query_queue',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `队列列表中不应存在 .id 为 "${p.target}" 的队列`,
        timeout_ms: 8_000,
    }),
    // ─── IP 地址删除 ────────────────────────────────────────────────
    remove_ip_address: (p) => ({
        verify_action: 'query_ip_addresses',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `IP 地址列表中不应存在 .id 为 "${p.target}" 的条目`,
        timeout_ms: 8_000,
    }),
    // ─── 系统备份 ───────────────────────────────────────────────────
    system_backup: (p) => ({
        verify_action: 'query_system_resource',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `系统资源查询正常响应（确认设备在备份操作${p.name ? ` "${p.name}"` : ''}后仍可达且未挂起）`,
        timeout_ms: 30_000,
    }),
    // ─── 配置类补全（medium 风险，低危修复）────────────────────────────
    modify_queue: (p) => ({
        verify_action: 'query_queue',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `队列 ID "${p.target}" 的 max-limit 应已更新为 "${p.maxLimit}"`,
        timeout_ms: 8_000,
    }),
    set_dns_server: (p) => ({
        verify_action: 'query_dns',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `DNS servers 字段应包含 "${p.servers}"`,
        timeout_ms: 8_000,
    }),
    set_interface_comment: (p) => ({
        verify_action: 'query_interface_detail',
        verify_params: { target: p.target, deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `接口 "${p.target}" 的 comment 字段应为 "${p.comment}"`,
        timeout_ms: 8_000,
    }),
    set_ntp_server: (p) => ({
        verify_action: 'query_ntp',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NTP primary-ntp 应已更新为 "${p.primaryNtp}"`,
        timeout_ms: 8_000,
    }),
    add_queue: (p) => ({
        verify_action: 'query_queue',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `队列列表中应存在名称为 "${p.name}" 的队列`,
        timeout_ms: 8_000,
    }),
    add_ip_address: (p) => ({
        verify_action: 'query_ip_addresses',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `IP 地址列表中应存在接口 "${p.interface}" 上的地址 "${p.address}"`,
        timeout_ms: 8_000,
    }),
    modify_firewall_rule: (p) => ({
        verify_action: 'query_firewall_filter',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `防火墙规则 ID "${p.target}" 的属性应已更新`,
        timeout_ms: 8_000,
    }),
    modify_nat_rule: (p) => ({
        verify_action: 'query_firewall_nat',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NAT 规则 ID "${p.target}" 的属性应已更新`,
        timeout_ms: 8_000,
    }),
    enable_firewall_rule: (p) => ({
        verify_action: 'query_firewall_filter',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `防火墙规则 ID "${p.target}" 的 disabled 字段应为 false`,
        timeout_ms: 8_000,
    }),
    disable_nat_rule: (p) => ({
        verify_action: 'query_firewall_nat',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NAT 规则 ID "${p.target}" 的 disabled 字段应为 true`,
        timeout_ms: 8_000,
    }),
    enable_nat_rule: (p) => ({
        verify_action: 'query_firewall_nat',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `NAT 规则 ID "${p.target}" 的 disabled 字段应为 false`,
        timeout_ms: 8_000,
    }),
    flush_dns_cache: (p) => ({
        verify_action: 'query_dns',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `DNS 缓存已清空（查询 DNS 配置确认服务仍正常运行）`,
        timeout_ms: 8_000,
    }),
    flush_arp_table: (p) => ({
        verify_action: 'query_arp_table',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `ARP 表已清空或仅剩少量动态条目（清空后设备会重新学习）`,
        timeout_ms: 8_000,
    }),
    disconnect_ppp: (p) => ({
        verify_action: 'query_ppp_active',
        verify_params: { deviceId: p.originalDeviceId || p.deviceId },
        expected_condition: `活跃 PPP 连接列表中不应存在 ID 为 "${p.target}" 的连接`,
        timeout_ms: 8_000,
    }),
};

// ====================================================================
// 白名单意图注册表
// ====================================================================

const INTENT_REGISTRY: Map<string, RegisteredIntent> = new Map();

function registerIntent(intent: RegisteredIntent): void {
    INTENT_REGISTRY.set(intent.action, intent);
}

// ─── 查询类意图（低风险，自动执行）───────────────────────────────────

registerIntent({
    action: 'query_interfaces',
    description: '查询所有网络接口的状态',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface'),
});

registerIntent({
    action: 'query_interface_detail',
    description: '查询特定网络接口的详细信息',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: { target: { required: true, description: '接口名称' } },
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface', { name: p.target as string }),
});

registerIntent({
    action: 'query_ip_addresses',
    description: '查询所有 IP 地址分配',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/ip/address'),
});

registerIntent({
    action: 'query_routes',
    description: '查询路由表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['routing', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/route'),
});

registerIntent({
    action: 'query_firewall_filter',
    description: '查询防火墙过滤规则',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['firewall_ops', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/filter'),
});

registerIntent({
    action: 'query_firewall_nat',
    description: '查询 NAT 规则',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['firewall_ops', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/nat'),
});

registerIntent({
    action: 'query_dns',
    description: '查询 DNS 配置和缓存',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['dhcp_dns', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/dns'),
});

registerIntent({
    action: 'query_dhcp_leases',
    description: '查询 DHCP 租约列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['dhcp_dns', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/dhcp-server/lease'),
});

registerIntent({
    action: 'query_system_resource',
    description: '查询系统资源使用情况（CPU/内存/磁盘）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/resource'),
});

registerIntent({
    action: 'query_system_identity',
    description: '查询设备标识信息',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/identity'),
});

registerIntent({
    action: 'query_arp_table',
    description: '查询 ARP 表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/ip/arp'),
});

registerIntent({
    action: 'query_bridge_hosts',
    description: '查询网桥主机表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface/bridge/host'),
});

registerIntent({
    action: 'query_active_connections',
    description: '查询当前活跃连接数',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/connection'),
});

registerIntent({
    action: 'query_logs',
    description: '查询系统日志',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/log'),
});

registerIntent({
    action: 'query_queue',
    description: '查询队列/限速规则',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query', 'system_config'],
    resolver: async (p) => getClient(p).print('/queue/simple'),
});

// ─── 查询类别名（LLM 常用的同义词，映射到已有 resolver）────────────────

// query_system_state / query_system_resources / query_system_health / query_health_snapshot / query_status
// 都是 LLM 对"查系统状态"的自然表达，统一映射到 /system/resource
registerIntent({
    action: 'query_system_state',
    description: '查询设备整体系统状态（CPU/内存/磁盘/运行时间），等同于 query_system_resource',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/resource'),
});

registerIntent({
    action: 'query_system_resources',
    description: '查询系统资源使用情况（query_system_resource 的复数别名）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/resource'),
});

registerIntent({
    action: 'query_health_snapshot',
    description: '查询系统健康快照（CPU/内存/磁盘/运行时间），等同于 query_system_resource',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/resource'),
});

registerIntent({
    action: 'query_status',
    description: '查询设备当前状态（query_system_resource 的通用别名）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/resource'),
});

registerIntent({
    action: 'query_system_health',
    description: '查询设备健康状态（电压/温度/风扇等硬件指标）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/health'),
});

registerIntent({
    action: 'query_system_clock',
    description: '查询设备系统时间和时区配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/clock'),
});

registerIntent({
    action: 'query_system_routerboard',
    description: '查询 RouterBoard 硬件信息（型号/序列号/固件版本）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/routerboard'),
});

registerIntent({
    action: 'query_system_license',
    description: '查询 RouterOS 授权信息',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/license'),
});

// ─── 网络诊断类查询 ───────────────────────────────────────────────────

registerIntent({
    action: 'query_firewall_address_list',
    description: '查询防火墙地址列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['firewall_ops', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/address-list'),
});

registerIntent({
    action: 'query_firewall_mangle',
    description: '查询防火墙 Mangle 规则（流量标记）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['firewall_ops', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/mangle'),
});

registerIntent({
    action: 'query_firewall_raw',
    description: '查询防火墙 Raw 规则（连接跟踪前处理）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['firewall_ops', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/firewall/raw'),
});

registerIntent({
    action: 'query_dhcp_server',
    description: '查询 DHCP 服务器配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['dhcp_dns', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/dhcp-server'),
});

registerIntent({
    action: 'query_dhcp_network',
    description: '查询 DHCP 网络配置（网关/DNS/子网）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['dhcp_dns', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/dhcp-server/network'),
});

registerIntent({
    action: 'query_ip_pools',
    description: '查询 IP 地址池',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['dhcp_dns', 'network_query'],
    resolver: async (p) => getClient(p).print('/ip/pool'),
});

registerIntent({
    action: 'query_neighbors',
    description: '查询 CDP/LLDP 邻居发现信息',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/ip/neighbor'),
});

registerIntent({
    action: 'query_bridge_ports',
    description: '查询网桥端口配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface/bridge/port'),
});

registerIntent({
    action: 'query_bridge_vlans',
    description: '查询网桥 VLAN 配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface/bridge/vlan'),
});

registerIntent({
    action: 'query_vlan_interfaces',
    description: '查询 VLAN 接口列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface/vlan'),
});

registerIntent({
    action: 'query_wireless',
    description: '查询无线接口状态和配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query', 'monitoring'],
    resolver: async (p) => getClient(p).print('/interface/wireless'),
});

registerIntent({
    action: 'query_wireless_clients',
    description: '查询当前连接的无线客户端列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query', 'monitoring'],
    resolver: async (p) => getClient(p).print('/interface/wireless/registration-table'),
});

registerIntent({
    action: 'query_ppp_active',
    description: '查询活跃的 PPP/PPPoE 连接',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query', 'monitoring'],
    resolver: async (p) => getClient(p).print('/ppp/active'),
});

registerIntent({
    action: 'query_hotspot_active',
    description: '查询 Hotspot 当前活跃用户',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['network_query', 'monitoring'],
    resolver: async (p) => getClient(p).print('/ip/hotspot/active'),
});

registerIntent({
    action: 'query_snmp',
    description: '查询 SNMP 配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring', 'system_config'],
    resolver: async (p) => getClient(p).print('/snmp'),
});

registerIntent({
    action: 'query_ntp',
    description: '查询 NTP 客户端配置和同步状态',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring', 'system_config'],
    resolver: async (p) => getClient(p).print('/system/ntp/client'),
});

registerIntent({
    action: 'query_users',
    description: '查询系统用户列表（不含密码）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/user'),
});

registerIntent({
    action: 'query_scheduler',
    description: '查询计划任务列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/scheduler'),
});

registerIntent({
    action: 'query_scripts',
    description: '查询脚本列表（不含脚本内容）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/system/script'),
});

registerIntent({
    action: 'query_certificates',
    description: '查询证书列表',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/certificate'),
});

registerIntent({
    action: 'query_ip_services',
    description: '查询开放的 IP 服务（SSH/Telnet/HTTP/API 等端口配置）',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {},
    category: ['monitoring'],
    resolver: async (p) => getClient(p).print('/ip/service'),
});

registerIntent({
    action: 'query_traffic',
    description: '查询指定接口的实时流量统计',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {
        target: { required: true, description: '接口名称（如 ether1, wlan1）' },
    },
    category: ['network_query'],
    resolver: async (p) => getClient(p).print('/interface', { name: p.target as string }),
});

// ─── 配置类意图（中风险，自动执行）───────────────────────────────────

registerIntent({
    action: 'add_firewall_rule',
    description: '添加防火墙过滤规则',
    riskLevel: 'medium',
    requiresApproval: false,
    paramSchema: {
        chain: { required: true, description: 'forward / input / output' },
        action: { required: true, description: 'accept / drop / reject' },
        srcAddress: { required: false, description: '源地址' },
        dstAddress: { required: false, description: '目标地址' },
        protocol: { required: false, description: '协议' },
        dstPort: { required: false, description: '目标端口' },
        comment: { required: false, description: '备注' },
    },
    category: ['firewall_ops'],
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = { chain: p.chain, action: p.action };
        if (p.srcAddress) data['src-address'] = p.srcAddress;
        if (p.dstAddress) data['dst-address'] = p.dstAddress;
        if (p.protocol) data['protocol'] = p.protocol;
        if (p.dstPort) data['dst-port'] = p.dstPort;
        // 生成唯一可预测的 comment，确保验证阶段可精确匹配
        // 格式：brain-op-<shortId>（若 LLM 提供了 comment 则追加到后面）
        const opId = uuidv4().slice(0, 8);
        const baseComment = p.comment ? `${p.comment as string} [brain-op-${opId}]` : `brain-op-${opId}`;
        data['comment'] = baseComment;
        // 将最终 comment 写回 params，供 VERIFICATION_DIRECTIVE_TEMPLATES 精确匹配
        p._verifyComment = baseComment;
        return client.add('/ip/firewall/filter', data);
    },
});

registerIntent({
    action: 'add_static_route',
    description: '添加静态路由',
    riskLevel: 'medium',
    requiresApproval: false,
    paramSchema: {
        dstAddress: { required: true, description: '目标网段 (如 10.0.0.0/24)' },
        gateway: { required: true, description: '网关地址' },
        comment: { required: false, description: '备注' },
    },
    category: ['routing'],
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = { 'dst-address': p.dstAddress, gateway: p.gateway };
        if (p.comment) data['comment'] = p.comment;
        return client.add('/ip/route', data);
    },
});

registerIntent({
    action: 'modify_queue',
    description: '修改队列 / 限速规则',
    riskLevel: 'medium',
    requiresApproval: false,
    paramSchema: {
        target: { required: true, description: '队列规则 ID (.id)' },
        maxLimit: { required: false, description: '最大速率' },
        comment: { required: false, description: '备注' },
    },
    category: ['system_config'],
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = {};
        if (p.maxLimit) data['max-limit'] = p.maxLimit;
        if (p.comment) data['comment'] = p.comment;
        return client.set('/queue/simple', p.target as string, data);
    },
});

registerIntent({
    action: 'add_address_list_entry',
    description: '添加地址列表条目（用于防火墙策略）',
    riskLevel: 'medium',
    requiresApproval: false,
    paramSchema: {
        list: { required: true, description: '列表名称' },
        address: { required: true, description: 'IP 地址或网段' },
        comment: { required: false, description: '备注' },
        timeout: { required: false, description: '超时时间 (如 1d, 1h)' },
    },
    category: ['firewall_ops'],
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = { list: p.list, address: p.address };
        if (p.comment) data['comment'] = p.comment;
        if (p.timeout) data['timeout'] = p.timeout;
        return client.add('/ip/firewall/address-list', data);
    },
});

registerIntent({
    action: 'set_dns_server',
    description: '设置 DNS 服务器地址',
    riskLevel: 'medium',
    requiresApproval: false,
    paramSchema: {
        servers: { required: true, description: 'DNS 服务器地址 (逗号分隔)' },
    },
    category: ['system_config'],
    resolver: async (p) => getClient(p).executeRaw('/ip/dns/set', [`=servers=${p.servers}`]),
});

// ─── 运维类意图（高风险，需审批）─────────────────────────────────────

registerIntent({
    action: 'disable_interface',
    description: '禁用网络接口（断开连接）',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '接口 ID (.id)' },
    },
    category: ['system_config'],
    resolver: async (p) => getClient(p).disable('/interface', p.target as string),
});

registerIntent({
    action: 'enable_interface',
    description: '启用网络接口',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '接口 ID (.id)' },
    },
    category: ['system_config'],
    resolver: async (p) => getClient(p).enable('/interface', p.target as string),
});

registerIntent({
    action: 'remove_firewall_rule',
    description: '删除防火墙规则',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    category: ['firewall_ops'],
    resolver: async (p) => getClient(p).remove('/ip/firewall/filter', p.target as string),
});

registerIntent({
    action: 'remove_nat_rule',
    description: '删除 NAT 规则',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    category: ['firewall_ops'],
    resolver: async (p) => getClient(p).remove('/ip/firewall/nat', p.target as string),
});

registerIntent({
    action: 'disable_firewall_rule',
    description: '禁用防火墙规则',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    category: ['firewall_ops'],
    resolver: async (p) => getClient(p).disable('/ip/firewall/filter', p.target as string),
});

registerIntent({
    action: 'remove_route',
    description: '删除路由',
    riskLevel: 'high',
    requiresApproval: true,
    paramSchema: {
        target: { required: true, description: '路由 ID (.id)' },
    },
    category: ['routing'],
    resolver: async (p) => getClient(p).remove('/ip/route', p.target as string),
});

// ─── 危险类意图（critical, 强制审批）─────────────────────────────────

registerIntent({
    action: 'system_reboot',
    description: '重启设备',
    riskLevel: 'critical',
    requiresApproval: true,
    paramSchema: {},
    category: ['system_danger'],
    resolver: async (p) => getClient(p).execute('/system/reboot'),
});

registerIntent({
    action: 'system_shutdown',
    description: '关闭设备',
    riskLevel: 'critical',
    requiresApproval: true,
    paramSchema: {},
    category: ['system_danger'],
    resolver: async (p) => getClient(p).execute('/system/shutdown'),
});

// ─── 配置类意图（中风险，自动执行）— 补充 ────────────────────────────

registerIntent({
    action: 'modify_firewall_rule',
    description: '修改已有防火墙过滤规则的属性',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
        action: { required: false, description: 'accept / drop / reject' },
        srcAddress: { required: false, description: '源地址' },
        dstAddress: { required: false, description: '目标地址' },
        protocol: { required: false, description: '协议' },
        dstPort: { required: false, description: '目标端口' },
        comment: { required: false, description: '备注' },
    },
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = {};
        if (p.action) data['action'] = p.action;
        if (p.srcAddress) data['src-address'] = p.srcAddress;
        if (p.dstAddress) data['dst-address'] = p.dstAddress;
        if (p.protocol) data['protocol'] = p.protocol;
        if (p.dstPort) data['dst-port'] = p.dstPort;
        if (p.comment) data['comment'] = p.comment;
        return client.set('/ip/firewall/filter', p.target as string, data);
    },
});

registerIntent({
    action: 'modify_nat_rule',
    description: '修改已有 NAT 规则的属性',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
        toAddresses: { required: false, description: '目标地址（DNAT）' },
        toPorts: { required: false, description: '目标端口（DNAT）' },
        comment: { required: false, description: '备注' },
    },
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = {};
        if (p.toAddresses) data['to-addresses'] = p.toAddresses;
        if (p.toPorts) data['to-ports'] = p.toPorts;
        if (p.comment) data['comment'] = p.comment;
        return client.set('/ip/firewall/nat', p.target as string, data);
    },
});

registerIntent({
    action: 'add_nat_rule',
    description: '添加 NAT 规则（MASQUERADE / DNAT / SNAT）',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['firewall_ops'],
    paramSchema: {
        chain: { required: true, description: 'srcnat / dstnat' },
        action: { required: true, description: 'masquerade / dst-nat / src-nat' },
        srcAddress: { required: false, description: '源地址' },
        dstAddress: { required: false, description: '目标地址' },
        protocol: { required: false, description: '协议' },
        dstPort: { required: false, description: '目标端口' },
        toAddresses: { required: false, description: '转换目标地址' },
        toPorts: { required: false, description: '转换目标端口' },
        comment: { required: false, description: '备注' },
    },
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = { chain: p.chain, action: p.action };
        if (p.srcAddress) data['src-address'] = p.srcAddress;
        if (p.dstAddress) data['dst-address'] = p.dstAddress;
        if (p.protocol) data['protocol'] = p.protocol;
        if (p.dstPort) data['dst-port'] = p.dstPort;
        if (p.toAddresses) data['to-addresses'] = p.toAddresses;
        if (p.toPorts) data['to-ports'] = p.toPorts;
        const opId = uuidv4().slice(0, 8);
        const baseComment = p.comment ? `${p.comment as string} [brain-op-${opId}]` : `brain-op-${opId}`;
        data['comment'] = baseComment;
        p._verifyComment = baseComment;
        return client.add('/ip/firewall/nat', data);
    },
});

registerIntent({
    action: 'add_dhcp_lease',
    description: '添加静态 DHCP 绑定（MAC 绑定固定 IP）',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['dhcp_dns'],
    paramSchema: {
        address: { required: true, description: '绑定的 IP 地址' },
        macAddress: { required: true, description: 'MAC 地址' },
        comment: { required: false, description: '备注（如主机名）' },
    },
    resolver: async (p) => {
        const client = getClient(p);
        const data: Record<string, unknown> = {
            address: p.address,
            'mac-address': p.macAddress,
        };
        if (p.comment) data['comment'] = p.comment;
        return client.add('/ip/dhcp-server/lease', data);
    },
});

registerIntent({
    action: 'remove_dhcp_lease',
    description: '删除 DHCP 租约或静态绑定',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['dhcp_dns'],
    paramSchema: {
        target: { required: true, description: '租约 ID (.id)' },
    },
    resolver: async (p) => getClient(p).remove('/ip/dhcp-server/lease', p.target as string),
});

registerIntent({
    action: 'set_interface_comment',
    description: '修改接口备注信息',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        target: { required: true, description: '接口 ID (.id)' },
        comment: { required: true, description: '新备注内容' },
    },
    resolver: async (p) =>
        getClient(p).set('/interface', p.target as string, { comment: p.comment }),
});

registerIntent({
    action: 'set_ntp_server',
    description: '设置 NTP 服务器地址',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        primaryNtp: { required: true, description: '主 NTP 服务器地址' },
        secondaryNtp: { required: false, description: '备用 NTP 服务器地址' },
    },
    resolver: async (p) => {
        const args = [`=primary-ntp=${p.primaryNtp}`];
        if (p.secondaryNtp) args.push(`=secondary-ntp=${p.secondaryNtp}`);
        return getClient(p).executeRaw('/system/ntp/client/set', args);
    },
});

registerIntent({
    action: 'add_queue',
    description: '添加简单队列限速规则',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        name: { required: true, description: '队列名称' },
        target: { required: true, description: '目标 IP 或网段' },
        maxLimit: { required: true, description: '最大速率（如 10M/10M，上传/下载）' },
        comment: { required: false, description: '备注' },
    },
    resolver: async (p) => {
        const data: Record<string, unknown> = {
            name: p.name,
            target: p.target,
            'max-limit': p.maxLimit,
        };
        if (p.comment) data['comment'] = p.comment;
        return getClient(p).add('/queue/simple', data);
    },
});

registerIntent({
    action: 'remove_queue',
    description: '删除队列限速规则',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        target: { required: true, description: '队列 ID (.id)' },
    },
    resolver: async (p) => getClient(p).remove('/queue/simple', p.target as string),
});

registerIntent({
    action: 'add_ip_address',
    description: '为接口添加 IP 地址',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        address: { required: true, description: 'IP 地址及掩码（如 192.168.1.1/24）' },
        interface: { required: true, description: '接口名称' },
        comment: { required: false, description: '备注' },
    },
    resolver: async (p) => {
        const data: Record<string, unknown> = {
            address: p.address,
            interface: p.interface,
        };
        if (p.comment) data['comment'] = p.comment;
        return getClient(p).add('/ip/address', data);
    },
});

registerIntent({
    action: 'remove_ip_address',
    description: '删除接口上的 IP 地址',
    riskLevel: 'medium',
    requiresApproval: false,
    category: ['system_config'],
    paramSchema: {
        target: { required: true, description: 'IP 地址条目 ID (.id)' },
    },
    resolver: async (p) => getClient(p).remove('/ip/address', p.target as string),
});

// ─── 运维类意图（高风险，需审批）— 补充 ──────────────────────────────

registerIntent({
    action: 'enable_firewall_rule',
    description: '启用防火墙规则',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    resolver: async (p) => getClient(p).enable('/ip/firewall/filter', p.target as string),
});

registerIntent({
    action: 'disable_nat_rule',
    description: '禁用 NAT 规则',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    resolver: async (p) => getClient(p).disable('/ip/firewall/nat', p.target as string),
});

registerIntent({
    action: 'enable_nat_rule',
    description: '启用 NAT 规则',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '规则 ID (.id)' },
    },
    resolver: async (p) => getClient(p).enable('/ip/firewall/nat', p.target as string),
});

registerIntent({
    action: 'flush_dns_cache',
    description: '清空 DNS 缓存（影响所有客户端域名解析）',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['dhcp_dns'],
    paramSchema: {},
    resolver: async (p) => getClient(p).executeRaw('/ip/dns/cache/flush', []),
});

registerIntent({
    action: 'flush_arp_table',
    description: '清空 ARP 表（短暂影响网络连通性）',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['system_config'],
    paramSchema: {},
    resolver: async (p) => getClient(p).executeRaw('/ip/arp/flush', []),
});

registerIntent({
    action: 'disconnect_ppp',
    description: '断开指定 PPP/PPPoE 连接',
    riskLevel: 'high',
    requiresApproval: true,
    category: ['system_config'],
    paramSchema: {
        target: { required: true, description: 'PPP 活跃连接 ID (.id)' },
    },
    resolver: async (p) => getClient(p).remove('/ppp/active', p.target as string),
});

// ─── 危险类意图（critical, 强制审批）— 补充 ──────────────────────────

registerIntent({
    action: 'system_reset_config',
    description: '重置设备配置为出厂默认（不可逆，会断开所有连接）',
    riskLevel: 'critical',
    requiresApproval: true,
    category: ['system_danger'],
    paramSchema: {
        noDefaults: { required: false, description: '是否不加载默认配置 (true/false)' },
    },
    resolver: async (p) => {
        const args = p.noDefaults ? ['=no-defaults=yes'] : [];
        return getClient(p).executeRaw('/system/reset-configuration', args);
    },
});

registerIntent({
    action: 'system_backup',
    description: '备份设备配置到文件',
    riskLevel: 'critical',
    requiresApproval: true,
    category: ['system_danger'],
    paramSchema: {
        name: { required: false, description: '备份文件名（不含扩展名）' },
    },
    resolver: async (p) => {
        const args = p.name ? [`=name=${p.name}`] : [];
        return getClient(p).executeRaw('/system/backup/save', args);
    },
});

registerIntent({
    action: 'system_update',
    description: '检查并安装 RouterOS 系统升级',
    riskLevel: 'critical',
    requiresApproval: true,
    category: ['system_danger'],
    paramSchema: {},
    resolver: async (p) => getClient(p).executeRaw('/system/package/update/install', []),
});

registerIntent({
    action: 'remove_address_list_entry',
    description: '删除防火墙地址列表条目（影响防火墙策略）',
    riskLevel: 'critical',
    requiresApproval: true,
    category: ['firewall_ops'],
    paramSchema: {
        target: { required: true, description: '条目 ID (.id)' },
    },
    resolver: async (p) => getClient(p).remove('/ip/firewall/address-list', p.target as string),
});

// ─── MCP Server 专用意图（供外部 MCP 客户端调用）─────────────────────

registerIntent({
    action: 'export_config',
    description: '导出 RouterOS 设备完整配置',
    riskLevel: 'low',
    requiresApproval: false,
    paramSchema: {
        deviceId: { required: false, description: '目标设备 ID' },
    },
    category: ['network_query'],
    resolver: async (p) => getClient(p).execute('/export'),
});

registerIntent({
    action: 'execute_command',
    description: '在 RouterOS 设备上执行任意命令（极高风险，需审批）',
    riskLevel: 'critical',
    requiresApproval: true,
    paramSchema: {
        deviceId: { required: true, description: '目标设备 ID' },
        command: { required: true, description: 'RouterOS 命令' },
    },
    category: ['system_danger'],
    resolver: async (p) => {
        const client = getClient(p);
        const cmd = p.command as string;
        // 将命令字符串拆分为路径和参数
        const parts = cmd.trim().split(/\s+/);
        const path = parts[0];
        const args = parts.slice(1);
        return client.executeRaw(path, args);
    },
});

// ====================================================================
// Intent 查询 & 执行 API
// ====================================================================

/** 获取所有已注册的合法意图 */
export function getRegisteredIntents(): RegisteredIntent[] {
    return Array.from(INTENT_REGISTRY.values());
}

/** 获取意图的简要列表（可嵌入 Prompt） */
export function getIntentSummaryForPrompt(): string {
    const lines: string[] = [];
    for (const intent of INTENT_REGISTRY.values()) {
        const params = Object.entries(intent.paramSchema)
            .map(([k, v]) => `${k}${v.required ? '*' : ''}`)
            .join(', ');
        const approval = intent.requiresApproval ? '⚠️需审批' : '✅自动';
        lines.push(`  - ${intent.action} [${intent.riskLevel}/${approval}]: ${intent.description}${params ? ` (参数: ${params})` : ''}`);
    }
    return lines.join('\n');
}

/** 按类别过滤意图（需求 1.3） */
export function getIntentsByCategory(categories: IntentCategory[]): RegisteredIntent[] {
    return Array.from(INTENT_REGISTRY.values()).filter(
        intent => intent.category.some(c => categories.includes(c))
    );
}

/** 列出所有意图类别元数据（需求 1.4） */
export function listIntentCategories(): IntentCategoryMeta[] {
    return INTENT_CATEGORY_META;
}

/** 按类别过滤后生成 Prompt 摘要（需求 1.5） */
export function getIntentSummaryForPromptFiltered(categories: IntentCategory[]): string {
    const intents = getIntentsByCategory(categories);
    const lines: string[] = [];
    for (const intent of intents) {
        const params = Object.entries(intent.paramSchema)
            .map(([k, v]) => `${k}${v.required ? '*' : ''}`)
            .join(', ');
        const approval = intent.requiresApproval ? '⚠️需审批' : '✅自动';
        lines.push(`  - ${intent.action} [${intent.riskLevel}/${approval}]: ${intent.description}${params ? ` (参数: ${params})` : ''}`);
    }
    return lines.join('\n');
}

export interface PendingIntent {
    id: string;
    action: string;
    params: IntentParams;
    riskLevel: IntentRiskLevel;
    timestamp: number;
    resolver: () => Promise<unknown>;
    // Callback to resolve the original pending promise if we want synchronous blocking (but we won't block)
}

const PENDING_INTENTS_MAP: Map<string, PendingIntent> = new Map();

/**
 * 并发锁：防止两个管理员同时批准同一个高危意图导致操作被执行两次
 * 使用 Set 实现轻量级互斥，Node.js 单线程保证 has/add 的原子性
 */
const grantingLocks = new Set<string>();

/** P0-2 FIX: Pending intent TTL——超过10分钟未审批自动 reject */
const PENDING_INTENT_TTL_MS = 10 * 60 * 1000; // 10 分钟
const _ttlCleanupTimer = setInterval(async () => {
    const now = Date.now();
    for (const [id, intent] of PENDING_INTENTS_MAP.entries()) {
        if (now - intent.timestamp > PENDING_INTENT_TTL_MS) {
            logger.warn(`[IntentRegistry] Pending intent ${id} (${intent.action}) expired after TTL. Auto-rejecting.`);

            // 🟡 FIX 1.6: TTL 过期时通知操作员和大脑
            try {
                const { notificationService } = await import('../notificationService');
                const channels = await notificationService.getChannels();
                const enabledIds = channels.filter(c => c.enabled).map(c => c.id);
                if (enabledIds.length > 0) {
                    await notificationService.send(enabledIds, {
                        type: 'alert',
                        title: '⏰ 高危意图审批超时',
                        body: `意图 "${intent.action}" (ID: ${id}) 超过 ${PENDING_INTENT_TTL_MS / 60000} 分钟未审批，已自动拒绝。\n风险等级: ${intent.riskLevel}`,
                    });
                }
            } catch (notifyErr) {
                logger.warn(`[IntentRegistry] Failed to send TTL expiry notification for ${id}:`, notifyErr);
            }

            // 通知大脑该意图已过期（通过 autonomousBrainService.pushNote 机制）
            try {
                const { autonomousBrainService } = await import('./autonomousBrainService');
                autonomousBrainService.pushNote(`⏰ Pending intent "${intent.action}" (${id}) expired after ${PENDING_INTENT_TTL_MS / 60000}min TTL. Auto-rejected.`, 'intentRegistry:ttl-expiry');
            } catch { /* brain may not be initialized */ }

            // BUG FIX: delete 移到最后，确保通知和 pushNote 使用 intent 对象完成后再删除
            PENDING_INTENTS_MAP.delete(id);
        }
    }
}, 60000); // 每分钟检查一次
// .unref() 确保此定时器不会阻止 Node.js 进程正常退出（测试环境友好）
_ttlCleanupTimer.unref();

/** Levenshtein 编辑距离 — 用于意图名模糊匹配 */
function levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
        let prev = i - 1;
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const tmp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = tmp;
        }
    }
    return dp[n];
}

/** 查找并验证意图（支持模糊纠正） */
export function resolveIntent(action: string): RegisteredIntent | null {
    // 精确匹配 — 快速路径
    const exact = INTENT_REGISTRY.get(action);
    if (exact) return exact;

    // 模糊匹配：计算与所有已注册意图的编辑距离
    // 阈值 ≤ 2 且唯一最近匹配时自动纠正（类似 git/npm 的 "did you mean?"）
    const MAX_DISTANCE = 2;
    const candidates: { intent: RegisteredIntent; distance: number }[] = [];
    for (const intent of INTENT_REGISTRY.values()) {
        const dist = levenshtein(action, intent.action);
        if (dist <= MAX_DISTANCE) {
            candidates.push({ intent, distance: dist });
        }
    }

    if (candidates.length === 1) {
        // 唯一近似匹配 → 自动纠正
        const match = candidates[0];
        logger.warn(`[IntentRegistry] Fuzzy auto-correct: "${action}" → "${match.intent.action}" (edit distance: ${match.distance})`);
        return match.intent;
    }

    if (candidates.length > 1) {
        // 多个近似匹配 → 按距离排序，取最近的；如果最近的唯一则纠正，否则返回 null（让错误信息带建议）
        candidates.sort((a, b) => a.distance - b.distance);
        if (candidates[0].distance < candidates[1].distance) {
            const match = candidates[0];
            logger.warn(`[IntentRegistry] Fuzzy auto-correct (best of ${candidates.length}): "${action}" → "${match.intent.action}" (edit distance: ${match.distance})`);
            return match.intent;
        }
        // 距离相同的多个候选 → 不自动纠正，记录建议
        logger.warn(`[IntentRegistry] Ambiguous fuzzy match for "${action}": ${candidates.map(c => c.intent.action).join(', ')}`);
    }

    return null;
}

/** 校验 Intent 参数是否满足 schema */
export function validateIntentParams(intent: RegisteredIntent, params: IntentParams): { valid: boolean; error?: string } {
    for (const [paramName, schema] of Object.entries(intent.paramSchema)) {
        if (schema.required && (params[paramName] === undefined || params[paramName] === null || params[paramName] === '')) {
            return { valid: false, error: `缺少必填参数: ${paramName} (${schema.description})` };
        }
    }
    return { valid: true };
}

/** 执行意图 */
export async function executeIntent(action: string, params: IntentParams): Promise<IntentResult> {
    const intent = resolveIntent(action);

    if (!intent) {
        // 构建 "did you mean?" 建议（编辑距离 ≤ 3 的候选，比自动纠正阈值宽松一档）
        const suggestions: string[] = [];
        for (const registered of INTENT_REGISTRY.values()) {
            if (levenshtein(action, registered.action) <= 3) {
                suggestions.push(registered.action);
            }
        }
        const hint = suggestions.length > 0
            ? ` 你是否想使用: ${suggestions.join(', ')}？`
            : '';

        logger.warn(`[IntentRegistry] REJECTED unknown intent: "${action}". This is not in the whitelist.${hint}`);
        return {
            success: false,
            action,
            riskLevel: 'critical',
            status: 'rejected',
            errorCode: 'UNKNOWN_INTENT',
            error: `未注册的意图 "${action}" 被白名单拒绝。只有预定义的合法操作才允许执行。${hint}`,
        };
    }

    // 参数校验
    const validation = validateIntentParams(intent, params);
    if (!validation.valid) {
        return {
            success: false,
            action,
            riskLevel: intent.riskLevel,
            status: 'rejected',
            errorCode: 'PARAM_VALIDATION',
            error: validation.error,
        };
    }

    // ── 设备路由：两条清晰路径，系统强制，不依赖 LLM 行为 ──────────────────
    //
    // 路径 A — 有 deviceId：强制走 DevicePool，tenantId 必须有，失败绝不降级
    // 路径 B — 无 deviceId：
    //   - DeviceManager 有受管设备 → 系统层面拒绝（防止 LLM 漏传 deviceId 时静默操作错设备）
    //   - DeviceManager 无受管设备 → 走全局 routerosClient（真正的单设备模式）
    //
    // 注意：params._client 由 Brain tick 在单设备模式下注入，多设备路径不使用它
    if (!params._client) {
        if (params.deviceId && params.deviceId.trim() !== '') {
            // ── 路径 A：有 deviceId，强制走 DevicePool ────────────────────────
            // deviceId 是全局唯一的，直接从 DB 查真实 tenantId，不依赖 LLM 传的值
            try {
                const { DevicePool } = await import('../../device/devicePool');
                const { DeviceManager } = await import('../../device/deviceManager');
                const pool = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
                const deviceManager = await serviceRegistry.getAsync<InstanceType<typeof DeviceManager>>(SERVICE_NAMES.DEVICE_MANAGER);

                // 直接按主键查询，O(1)，不做全表扫描
                const deviceRecord = await deviceManager.findDeviceByIdAcrossTenants(params.deviceId!);
                if (!deviceRecord) {
                    // 🔴 FIX: 不只是拒绝，还要告诉 LLM 有效设备清单 + 模糊匹配建议
                    // 帮助 LLM 自我纠正，而不是让它盲目重试
                    let hint = '';
                    try {
                        const allDevices = await deviceManager.getDevices('*', undefined, { allowCrossTenant: true });
                        if (allDevices.length > 0) {
                            // 模糊匹配：LLM 可能把 name/host 当 deviceId 用了
                            const inputLower = (params.deviceId || '').toLowerCase();
                            const fuzzyMatch = allDevices.find((d: any) =>
                                (d.name && d.name.toLowerCase().includes(inputLower)) ||
                                (d.host && d.host.toLowerCase().includes(inputLower)) ||
                                inputLower.includes((d.name || '').toLowerCase())
                            );
                            const deviceList = allDevices.map((d: any) =>
                                `  - name: "${d.name}", host: "${d.host}", status: "${d.status}"`
                            ).join('\n');
                            hint = fuzzyMatch
                                ? ` 你是否想操作 "${fuzzyMatch.name}" ("${fuzzyMatch.host}")？\n有效设备列表:\n${deviceList}`
                                : ` 有效设备列表:\n${deviceList}`;
                        }
                    } catch { /* 查询失败不阻断主流程 */ }
                    const errorMsg = `设备 "${params.deviceId}" 在数据库中不存在。${hint}`;
                    logger.error(`[IntentRegistry] [ROUTE_A] ${errorMsg}`);
                    return {
                        success: false,
                        action,
                        riskLevel: intent.riskLevel,
                        status: 'rejected',
                        errorCode: 'PARAM_VALIDATION',
                        error: `[PARAM_VALIDATION] ${errorMsg}`,
                    };
                }
                const resolvedTenantId: string = deviceRecord.tenant_id || 'default';
                logger.debug(`[IntentRegistry] [ROUTE_A] Resolved tenantId="${resolvedTenantId}" from DB for deviceId="${params.deviceId}"`);

                const deviceClient = await pool.getConnection(resolvedTenantId, params.deviceId);
                params._client = deviceClient;
                logger.debug(`[IntentRegistry] [ROUTE_A] Resolved client for deviceId="${params.deviceId}", tenantId="${resolvedTenantId}"`);
            } catch (err) {
                const rawMsg = err instanceof Error ? err.message : String(err);
                const errorCode = classifyIntentError(rawMsg);
                const finalCode: IntentErrorCode = errorCode === 'FORBIDDEN' ? 'FORBIDDEN' : 'DEVICE_UNREACHABLE';
                logger.error(`[IntentRegistry] [ROUTE_A] Cannot get client for deviceId="${params.deviceId}": ${rawMsg} [${finalCode}]. 操作已中止，不会降级到默认设备。`);
                return {
                    success: false,
                    action,
                    riskLevel: intent.riskLevel,
                    status: 'rejected',
                    errorCode: finalCode,
                    error: `[${finalCode}] 无法获取设备 "${params.originalDeviceId || params.deviceId}" 的客户端连接: ${rawMsg}`,
                };
            }
        } else {
            // ── 路径 B：无 deviceId，检查是否有受管设备 ──────────────────────
            let hasManagedDevices = false;
            let deviceManager: any = null;
            try {
                // 与 autonomousBrainService gatherContext 保持一致：
                // Brain 现在展示所有设备（含 offline），hasAvailableDevices 也检查所有设备
                // 只要 DB 中有设备记录，就要求 deviceId，消除 TOCTOU 竞态
                const { DeviceManager } = await import('../../device/deviceManager');
                deviceManager = await serviceRegistry.getAsync<InstanceType<typeof DeviceManager>>(SERVICE_NAMES.DEVICE_MANAGER);
                hasManagedDevices = await deviceManager.hasAvailableDevices();
            } catch {
                // DeviceManager 不可用 → 视为无受管设备，走单设备模式
                hasManagedDevices = false;
            }

            if (hasManagedDevices) {
                // 🔴 FIX: ROUTE_B 分支 — 系统层面处理 LLM 未传 deviceId 的情况
                // 单台设备：自动注入（LLM 没得选，系统帮它选唯一的那台）
                // 多台设备：拒绝并列出设备清单，要求 LLM 明确指定（防止系统替 LLM 做错误选择）
                try {
                    const allDevices = await deviceManager.getDevices('*', undefined, { allowCrossTenant: true });

                    if (allDevices.length === 1) {
                        // ── 单台受管设备：自动注入，不依赖 LLM ──
                        const targetDevice = allDevices[0];
                        logger.info(`[IntentRegistry] [ROUTE_B] Single managed device — auto-injecting deviceId="${targetDevice.id}" (${targetDevice.name}, status=${targetDevice.status})`);
                        params.deviceId = targetDevice.id;
                        const { DevicePool } = await import('../../device/devicePool');
                        const pool = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
                        const resolvedTenantId = targetDevice.tenant_id || 'default';
                        const deviceClient = await pool.getConnection(resolvedTenantId, targetDevice.id);
                        params._client = deviceClient;
                    } else if (allDevices.length > 1) {
                        // ── 多台受管设备：拒绝，要求 LLM 指定 deviceId ──
                        const deviceList = allDevices.map((d: any) =>
                            `  - deviceName="${d.name}" (IP: ${d.host}, status: ${d.status})`
                        ).join('\n');
                        const errorMsg = `系统中存在 ${allDevices.length} 台受管设备，但 execute_intent 调用未提供 deviceName 或 ip。请从以下设备中选择目标并指定 deviceName:\n${deviceList}`;
                        logger.warn(`[IntentRegistry] [ROUTE_B] Multiple devices (${allDevices.length}), no deviceId provided. Rejecting.`);
                        return {
                            success: false,
                            action,
                            riskLevel: intent.riskLevel,
                            status: 'rejected',
                            errorCode: 'PARAM_VALIDATION',
                            error: `[PARAM_VALIDATION] ${errorMsg}`,
                        };
                    }
                    if (allDevices.length === 0) {
                        // 竞态：hasAvailableDevices() 返回 true 但 getDevices() 返回空（设备在两次调用之间被删除）
                        logger.warn(
                            `[IntentRegistry] [ROUTE_B] Race condition: hasAvailableDevices() was true, but getDevices() returned empty. ` +
                            `Device may have been deleted between calls. Falling through to single-device mode.`
                        );
                    }
                } catch (autoInjectErr) {
                    const rawMsg = autoInjectErr instanceof Error ? autoInjectErr.message : String(autoInjectErr);
                    logger.error(`[IntentRegistry] [ROUTE_B] Device routing failed: ${rawMsg}. Rejecting.`);
                    return {
                        success: false,
                        action,
                        riskLevel: intent.riskLevel,
                        status: 'rejected',
                        errorCode: 'DEVICE_UNREACHABLE',
                        error: `[DEVICE_UNREACHABLE] 设备路由失败: ${rawMsg}`,
                    };
                }
            } else {
                // 真正的单设备模式：DB 中无任何设备记录，使用全局 routerosClient
                logger.debug(`[IntentRegistry] [ROUTE_B] Single-device mode: no devices in database, using global routerosClient.`);
            }
        }
    }

    // 高危操作需审批 — 不自动执行，推入 Air-Lock 队列
    if (intent.requiresApproval) {
        const id = uuidv4();

        PENDING_INTENTS_MAP.set(id, {
            id,
            action: intent.action,
            params,
            riskLevel: intent.riskLevel,
            timestamp: Date.now(),
            resolver: () => intent.resolver(params)
        });

        logger.warn(`[IntentRegistry] Intent "${action}" requires human approval (risk: ${intent.riskLevel}). Pended with ID: ${id}`);
        return {
            success: false,
            action,
            riskLevel: intent.riskLevel,
            status: 'pending_approval',
            errorCode: 'REQUIRES_APPROVAL',
            approvalId: id,
            error: `[REQUIRES_APPROVAL] Intent "${action}" has been suspended in Air-Lock. Pending ID: ${id}. It will execute immediately once the human commander grants it.`,
        };
    }

    // 🔴 FIX 3: 连接预检 — 在调用 resolver 之前验证客户端连接状态
    // 避免深入 resolver 内部才发现断开，提供清晰的结构化错误
    const client = getClient(params);
    const preflight = preflightConnectivityCheck(client);
    if (!preflight.ok) {
        logger.warn(`[IntentRegistry] Pre-flight connectivity check FAILED for intent "${action}": ${preflight.errorMsg}`);
        return {
            success: false,
            action,
            riskLevel: intent.riskLevel,
            status: 'rejected',
            errorCode: preflight.errorCode,
            error: preflight.errorMsg,
        };
    }

    // 安全执行
    try {
        logger.info(`[IntentRegistry] Executing intent: "${action}" with params: ${JSON.stringify({ ...params, _client: undefined })}`);
        const output = await intent.resolver(params);
        // 任务 5.4：medium+ 风险意图执行成功后注入 verification_directive
        const verificationDirective = (intent.riskLevel === 'medium' || intent.riskLevel === 'high' || intent.riskLevel === 'critical')
            ? VERIFICATION_DIRECTIVE_TEMPLATES[action]?.(params)
            : undefined;
        return {
            success: true,
            action,
            riskLevel: intent.riskLevel,
            status: 'executed',
            output,
            ...(verificationDirective ? { verification_directive: verificationDirective } : {}),
        };
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const errorCode = classifyIntentError(errMsg);
        logger.error(`[IntentRegistry] Intent "${action}" failed [${errorCode}]: ${errMsg}`);
        return {
            success: false,
            action,
            riskLevel: intent.riskLevel,
            status: 'executed',
            errorCode,
            error: `[${errorCode}] ${errMsg}`,
        };
    }
}

// ====================================================================
// Air-Lock Pending APIs
// ====================================================================

export function getPendingIntents(): Omit<PendingIntent, 'resolver'>[] {
    return Array.from(PENDING_INTENTS_MAP.values()).map(p => ({
        id: p.id,
        action: p.action,
        params: p.params,
        riskLevel: p.riskLevel,
        timestamp: p.timestamp
    })).sort((a, b) => b.timestamp - a.timestamp); // latest first
}

export async function grantPendingIntent(id: string): Promise<unknown> {
    const pending = PENDING_INTENTS_MAP.get(id);
    if (!pending) throw new Error("Pending intent not found or already processed.");

    // 🔴 FIX: 并发竞态防护 — 防止两个管理员同时批准同一意图导致高危操作执行两次
    // Node.js 单线程保证 has/add 的原子性（不存在 TOCTOU 问题）
    if (grantingLocks.has(id)) {
        throw new Error(`[CONCURRENT_GRANT] 意图 ${id} (${pending.action}) 正在被另一个请求处理中，请勿重复批准。`);
    }
    grantingLocks.add(id);

    try {
        logger.info(`[IntentRegistry] User explicitly GRANTED pending intent ${id} (${pending.action})`);

        // 🔴 FIX 1.1: 审批后重新获取设备连接，防止闭包中的 _client 已被空闲清理断开
        if (pending.params.deviceId) {
            // deviceId 全局唯一，直接从 DB 查真实 tenantId，不依赖 pending.params.tenantId
            try {
                const { DevicePool } = await import('../../device/devicePool');
                const { DeviceManager } = await import('../../device/deviceManager');
                const pool = await serviceRegistry.getAsync<InstanceType<typeof DevicePool>>(SERVICE_NAMES.DEVICE_POOL);
                const deviceManager = await serviceRegistry.getAsync<InstanceType<typeof DeviceManager>>(SERVICE_NAMES.DEVICE_MANAGER);

                // 直接按主键查询，O(1)，不做全表扫描
                const deviceRecord = await deviceManager.findDeviceByIdAcrossTenants(pending.params.deviceId!);
                if (!deviceRecord) {
                    const errorMsg = `设备 "${pending.params.deviceId}" 在审批期间已被删除，操作无法执行。`;
                    logger.error(`[IntentRegistry] [grantPendingIntent] ${errorMsg}`);
                    throw new Error(`[NOT_FOUND] ${errorMsg}`);
                }
                const resolvedTenantId: string = deviceRecord.tenant_id || 'default';

                const freshClient = await pool.getConnection(resolvedTenantId, pending.params.deviceId);
                pending.params._client = freshClient;
                logger.debug(`[IntentRegistry] Refreshed device client for granted intent ${id} (device: ${pending.params.deviceId}, tenant: ${resolvedTenantId})`);
            } catch (err) {
                const errorMsg = `无法刷新设备 "${pending.params.deviceId}" 的客户端连接: ${err instanceof Error ? err.message : String(err)}`;
                logger.error(`[IntentRegistry] ${errorMsg}`);

                // 🔴 FIX 1.2: 记录审计日志（连接刷新失败）
                try {
                    const { auditLogger } = await import('../auditLogger');
                    await auditLogger.log({
                        action: 'intent_execution' as any,
                        actor: 'user',
                        details: {
                            trigger: 'grant_pending_intent',
                            error: errorMsg,
                            metadata: {
                                intentId: id,
                                intentAction: pending.action,
                                riskLevel: pending.riskLevel,
                                phase: 'client_refresh',
                            },
                        },
                    });
                } catch { /* audit failure is non-critical */ }

                throw new Error(`[DEVICE_UNREACHABLE] ${errorMsg}`);
            }
        }

        // 🔴 FIX 1.2: 审计日志 — 记录高危操作的审批执行
        let result: unknown;
        let executionError: Error | null = null;
        try {
            result = await pending.resolver();
        } catch (err) {
            executionError = err instanceof Error ? err : new Error(String(err));
        }

        // 无论成功失败都记录审计日志
        try {
            const { auditLogger } = await import('../auditLogger');
            await auditLogger.log({
                action: 'intent_execution' as any,
                actor: 'user',
                details: {
                    trigger: 'grant_pending_intent',
                    result: executionError ? 'failed' : 'success',
                    error: executionError?.message,
                    metadata: {
                        intentId: id,
                        intentAction: pending.action,
                        riskLevel: pending.riskLevel,
                        params: { ...pending.params, _client: undefined },
                        approvedAt: Date.now(),
                    },
                },
            });
        } catch (auditErr) {
            logger.error(`[IntentRegistry] Failed to write audit log for granted intent ${id}:`, auditErr);
        }

        if (executionError) {
            // 🔴 FIX v2: 区分瞬时错误和永久性错误
            // 瞬时错误（网络抖动、设备重启）：保留意图在队列中，操作员可重试
            // 永久性错误（参数校验失败、业务逻辑错误）：从队列删除，避免操作员反复尝试注定失败的任务
            const errorCode = classifyIntentError(executionError.message);
            const isTransient = ['DEVICE_DISCONNECTED', 'DEVICE_UNREACHABLE', 'TIMEOUT', 'CONNECTION_REFUSED'].includes(errorCode);

            if (isTransient) {
                logger.warn(`[IntentRegistry] Granted intent ${id} (${pending.action}) execution failed with transient error [${errorCode}]. Intent retained in queue for retry. Error: ${executionError.message}`);
                // 🔴 FIX (Gemini audit): 刷新时间戳，防止因瞬时错误重试导致的 TTL 过期清理（中危修复）
                pending.timestamp = Date.now(); 
                // 🔴 FIX: 瞬时错误不向上抛出，而是返回特定状态告知 API 控制器
                return {
                    success: false, // 业务执行还是没成功
                    status: 'pending_approval', // 保持为 pending，以便在 UI 上继续显示
                    action: pending.action,
                    riskLevel: pending.riskLevel,
                    error: `操作暂时失败（${errorCode}），意图已保留在队列中，请稍后重试或等待系统恢复。`,
                    errorCode
                };
            } else {
                logger.error(`[IntentRegistry] Granted intent ${id} (${pending.action}) execution failed with permanent error [${errorCode}]. Removing from queue. Error: ${executionError.message}`);
                PENDING_INTENTS_MAP.delete(id);
                throw executionError; // 只有永久性错误才向上抛出导致 API 500
            }
        }

        // 🔴 BUG FIX: resolver 成功执行后才从队列删除，防止临时错误导致意图永久丢失
        PENDING_INTENTS_MAP.delete(id);

        // ─── 审批后验证（统一使用 VERIFICATION_DIRECTIVE_TEMPLATES）────────
        // ReAct 循环因 success=false(pending_approval) 不会触发验证，
        // 所以在 grantPendingIntent 执行成功后，独立触发验证并将结果推送给大脑。
        // 使用与 executeIntent 相同的 VERIFICATION_DIRECTIVE_TEMPLATES，保持单一验证模型。
        void (async () => {
            logger.info(`[IntentRegistry] Post-approval verification task started: action=${pending.action}, id=${id}`);
            try {
                const directiveTemplate = VERIFICATION_DIRECTIVE_TEMPLATES[pending.action];
                if (!directiveTemplate) {
                    logger.debug(`[IntentRegistry] No verification template for action "${pending.action}", skipping post-approval verification.`);
                    return;
                }

                const directive = directiveTemplate(pending.params);

                // 轮询验证：最多等待 directive.timeout_ms，每 500ms 查询一次
                const pollTimeout = directive.timeout_ms;
                const pollInterval = 500;
                const startTime = Date.now();
                let verified = false;
                let verifyOutput: unknown;

                while (Date.now() - startTime < pollTimeout) {
                    try {
                        const verifyResult = await executeIntent(directive.verify_action, {
                            ...directive.verify_params,
                            _client: pending.params._client,
                        } as IntentParams);
                        verifyOutput = verifyResult.output;
                        verified = verifyResult.success;
                        if (verified) break;
                    } catch (pollErr) {
                        // executeIntent 抛出异常（如连接断开）→ 立即中断轮询，避免无效重试
                        logger.warn(`[IntentRegistry] Post-approval verification poll aborted: ${pollErr instanceof Error ? pollErr.message : String(pollErr)}`);
                        break;
                    }
                    await new Promise((r) => setTimeout(r, pollInterval));
                }

                logger.info(
                    `[IntentRegistry] Post-approval verification completed: action=${pending.action}, id=${id}, verified=${verified}, expected="${directive.expected_condition}"`,
                );

                // 将验证结果推送给大脑（非阻塞，失败不影响主流程）
                try {
                    const { autonomousBrainService } = await import('./autonomousBrainService');
                    const noteContent = verified
                        ? `✅ 审批操作已验证生效：${pending.action} — 期望条件：${directive.expected_condition}`
                        : `⚠️ 审批操作验证未确认：${pending.action} — 期望条件：${directive.expected_condition}，请人工确认设备状态。验证查询结果：${JSON.stringify(verifyOutput)}`;
                    autonomousBrainService.pushNote(noteContent, 'intentRegistry:post-approval');

                    // 🔴 FIX (Gemini audit): 如果验证未确认，通过通知系统也提醒人类管理员（中危修复）
                    if (!verified) {
                        const { notificationService: ns } = await import('../notificationService');
                        const channels = await ns.getChannels();
                        const enabledIds = channels.filter(c => c.enabled).map(c => c.id);
                        if (enabledIds.length > 0) {
                            await ns.send(enabledIds, {
                                type: 'alert',
                                title: '⚠️ 批后验证未能确认状态',
                                body: `已批准的操作 "${pending.action}" 在设备 "${pending.params.originalDeviceId || 'N/A'}" 上执行后，自动验证无法确认状态生效。请人工检查确认。期望: ${directive.expected_condition}`,
                            });
                        }
                    }
                } catch (pushErr) {
                    logger.warn(`[IntentRegistry] Failed to push post-approval verification results:`, pushErr);
                }
            } catch (verifyErr) {
                logger.error(`[IntentRegistry] Post-approval verification error for ${pending.action} (${id}):`, verifyErr);
                try {
                    const { autonomousBrainService } = await import('./autonomousBrainService');
                    autonomousBrainService.pushNote(
                        `🚨 审批后验证流程异常：意图 "${pending.action}" (${id}) 的验证过程执行失败，请人工确认操作是否生效。错误: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`,
                        'intentRegistry:verification-process-failure',
                    );
                } catch { /* pushNote 失败不阻断 */ }
            }
        })();
        // ─────────────────────────────────────────────────────────────────

        return result;
    } finally {
        // 无论成功、失败还是抛出异常，都必须释放锁
        grantingLocks.delete(id);
    }
}

export function rejectPendingIntent(id: string): void {
    if (!PENDING_INTENTS_MAP.has(id)) throw new Error("Pending intent not found.");
    logger.info(`[IntentRegistry] User REJECTED pending intent ${id}`);
    PENDING_INTENTS_MAP.delete(id);
}

// ====================================================================
// 清理函数
// ====================================================================

/**
 * 清理 IntentRegistry 模块级资源（TTL 定时器）
 * 在应用优雅停机时调用，防止定时器句柄泄漏
 */
export function cleanupIntentRegistry(): void {
    clearInterval(_ttlCleanupTimer);
}
