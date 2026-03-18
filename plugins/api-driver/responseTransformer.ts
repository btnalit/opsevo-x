/**
 * ResponseTransformer — 响应数据转换
 *
 * 支持 JMESPath 表达式和简单映射转换。
 *
 * Requirements: A2.9
 */

/**
 * 使用点分路径从对象中提取值
 * 简化版 JMESPath，支持 "a.b.c" 和 "a[0].b" 格式
 */
export function extractByPath(data: unknown, path: string): unknown {
  if (!path || data == null) return data;

  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current: any = data;

  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }

  return current;
}

/**
 * 转换响应数据
 *
 * @param data 原始响应数据
 * @param transform JMESPath 风格的提取路径，或 null 表示不转换
 */
export function transformResponse(data: unknown, transform?: string): unknown {
  if (!transform) return data;
  return extractByPath(data, transform);
}
