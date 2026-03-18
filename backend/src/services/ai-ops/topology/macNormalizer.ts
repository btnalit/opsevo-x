/**
 * MAC 地址归一化器
 *
 * 统一为小写冒号分隔格式 aa:bb:cc:dd:ee:ff
 * 支持输入格式：AA-BB-CC-DD-EE-FF, AABB.CCDD.EEFF, AA:BB:CC:DD:EE:FF 等
 * 幂等性：对同一物理地址的任意合法格式输入产生相同输出
 *
 * Property 1: MAC 地址归一化幂等性
 * Requirements: 3.2, 3.12
 */

/**
 * 归一化 MAC 地址为 aa:bb:cc:dd:ee:ff 格式
 * 如果输入不是合法 MAC 地址，返回原始字符串（小写）
 */
export function normalizeMac(mac: string): string {
  if (!mac || typeof mac !== 'string') return mac;

  // 移除所有分隔符（冒号、连字符、点号、空格），得到纯十六进制字符串
  const hex = mac.replace(/[:\-.\s]/g, '').toLowerCase();

  // 验证：必须是 12 个十六进制字符
  if (!/^[0-9a-f]{12}$/.test(hex)) {
    return mac.toLowerCase();
  }

  // 每 2 个字符插入冒号
  return `${hex[0]}${hex[1]}:${hex[2]}${hex[3]}:${hex[4]}${hex[5]}:${hex[6]}${hex[7]}:${hex[8]}${hex[9]}:${hex[10]}${hex[11]}`;
}
