/**
 * 地址验证工具函数
 * 支持 IPv4、IPv6 和主机名验证
 */

/**
 * 验证 IPv4 地址
 */
export function isValidIPv4(address: string): boolean {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipv4Regex.test(address)) return false;
  const octets = address.split('.').map(Number);
  return octets.every(o => o >= 0 && o <= 255);
}

/**
 * 验证 IPv6 地址
 * 支持标准格式、压缩格式、方括号格式
 */
export function isValidIPv6(address: string): boolean {
  // 移除方括号
  const cleanAddress = address.replace(/^\[|\]$/g, '');
  
  // 完整的 IPv6 正则表达式
  // 支持: 完整格式、压缩格式(::)、混合格式
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
  
  return ipv6Regex.test(cleanAddress);
}

/**
 * 验证主机名
 */
export function isValidHostname(hostname: string): boolean {
  // 主机名规则：字母数字开头和结尾，中间可以有字母数字、连字符和点
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]*[a-zA-Z0-9])?$/;
  return hostnameRegex.test(hostname) && hostname.length <= 253;
}

/**
 * 验证地址（IPv4、IPv6 或主机名）
 */
export function isValidAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }
  return isValidIPv4(address) || isValidIPv6(address) || isValidHostname(address);
}

/**
 * Element Plus 表单验证器
 */
export function validateAddress(
  _rule: unknown,
  value: string,
  callback: (error?: Error) => void
): void {
  if (!value) {
    callback(new Error('请输入地址'));
    return;
  }
  
  if (!isValidAddress(value)) {
    callback(new Error('请输入有效的 IPv4、IPv6 地址或主机名'));
    return;
  }
  
  callback();
}
