/**
 * UUID Mock for Jest
 * 提供 uuid 模块的 CommonJS 兼容实现
 */

let counter = 0;

export function v4(): string {
  counter++;
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const random = Math.random().toString(16).substring(2, 10);
  const count = counter.toString(16).padStart(4, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-4${random.slice(0, 3)}-${count}-${random.slice(3, 15).padEnd(12, '0')}`;
}

export default { v4 };
