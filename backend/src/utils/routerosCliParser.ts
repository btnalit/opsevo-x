/**
 * RouterOS CLI 到 API 格式转换工具
 * 
 * 共享工具函数，供 scriptExecutorService.ts 和 alertEngine.ts 共同使用
 * 消除代码重复，统一修复引号参数、where 子句、特殊字符等边界情况
 */

/** CLI 修饰符，在 API 中忽略 */
const CLI_MODIFIERS = ['detail', 'brief', 'terse', 'value-list', 'without-paging'];

/**
 * 解析带引号的参数值，去除外层引号
 * 例如: key="value with spaces" → { key: 'key', value: 'value with spaces' }
 *       key='value' → { key: 'key', value: 'value' }
 *       key=simple → { key: 'key', value: 'simple' }
 */
function parseKeyValue(part: string): { key: string; value: string } | null {
  // 使用第一个 = 作为分隔符，后续 = 保留在 value 中
  const eqIndex = part.indexOf('=');
  if (eqIndex < 0) return null;

  const key = part.substring(0, eqIndex);
  let value = part.substring(eqIndex + 1);

  // 去除外层引号（单引号或双引号）
  if ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

/**
 * 将 CLI 格式命令转换为 RouterOS API 格式
 * 
 * 转换规则：
 * - /ip address print → /ip/address/print
 * - /interface print detail → /interface/print (忽略 detail, brief 等 CLI 修饰符)
 * - /ip address add address=192.168.1.1/24 → /ip/address/add + params
 * - /ip address print where interface=ether1 → /ip/address/print + query params
 * - 支持带引号的参数值：comment="New LAN Segment"
 * - 支持 where 子句的 and/or 复合条件
 * - 正确处理参数值中的特殊字符（/、空格、=）
 */
export function convertToApiFormat(command: string): { apiCommand: string; params: string[] } {
  const trimmed = command.trim();

  // 使用正则表达式分割，保留带引号的字符串
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

  const pathParts: string[] = [];
  const params: string[] = [];
  const positionalArgs: string[] = [];

  let inWhere = false;
  let foundFirstParam = false;

  for (const part of parts) {
    // where 子句处理
    if (part.toLowerCase() === 'where') {
      inWhere = true;
      continue;
    }

    if (inWhere) {
      // and 关键词：RouterOS API 中多个 ?key=value 隐式为 AND，直接跳过
      if (part.toLowerCase() === 'and') {
        continue;
      }
      // or 关键词：RouterOS API 需要 ?#| 运算符来表示 OR 条件
      if (part.toLowerCase() === 'or') {
        params.push('?#|');
        continue;
      }
      // where 条件转换为查询参数
      if (part.includes('=')) {
        const kv = parseKeyValue(part);
        if (kv) {
          params.push(`?${kv.key}=${kv.value}`);
        }
      }
      continue;
    }

    // 忽略 CLI 修饰符
    if (CLI_MODIFIERS.includes(part.toLowerCase())) {
      continue;
    }

    // 参数（包含 =）- 一旦遇到参数，后面的都是参数
    if (part.includes('=')) {
      foundFirstParam = true;
      const kv = parseKeyValue(part);
      if (kv) {
        params.push(`=${kv.key}=${kv.value}`);
      }
    }
    // 收集所有可能是路径和位置参数的独立词缀
    else if (!foundFirstParam) {
      pathParts.push(part);
    }
  }

  // 核心重构：RouterOS 命令格式必然是 “路径” + “动词” + “（可能有）未命名的附加参数”
  // 倒序寻找 API 命令动作的“动词”位置，确保含有 "//" 的 URL 不会被意外拆碎
  const VERBS = new Set([
    'print', 'add', 'set', 'remove', 'enable', 'disable', 'export', 'save',
    'run', 'install', 'ping', 'mac-ping', 'traceroute', 'fetch', 'bandwidth-test',
    'reboot', 'shutdown', 'upgrade', 'update', 'monitor'
  ]);

  let verbIndex = -1;
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    // 提取独立分段的最后一个词眼作为判断依据
    const subParts = part.split('/').filter(w => w.length > 0);
    const lastSubPart = subParts[subParts.length - 1];

    if (VERBS.has(lastSubPart?.toLowerCase())) {
      verbIndex = i;
      break; // 找到第一个动词就视作命令本体边界
    }
  }

  let finalPathParts: string[] = [];
  if (verbIndex !== -1) {
    // 从头到包含动词的 part，都是 API 核心命令
    finalPathParts = pathParts.slice(0, verbIndex + 1);
    // 动词之后的内容，如果存在，必然是被落下的位置参数
    const extraPositionals = pathParts.slice(verbIndex + 1);
    positionalArgs.push(...extraPositionals);
  } else {
    // 无法识别到动作（可能是不完整语句或特例），全当做命令路径
    finalPathParts = pathParts;
  }

  // 组合 API 命令路径
  let apiCommand = '';
  // 安全地用 '/' 拼接，并且去掉多余的斜杠
  for (const part of finalPathParts) {
    if (part.startsWith('/')) {
      apiCommand += part;
    } else {
      apiCommand += '/' + part;
    }
  }
  apiCommand = apiCommand.replace(/\/+/g, '/');

  // 处理在解析过程中发现的无名位置参数
  if (positionalArgs.length > 0) {
    const firstPositional = positionalArgs[0];
    // 去除外层引号
    let cleanPositional = firstPositional;
    if ((cleanPositional.startsWith('"') && cleanPositional.endsWith('"')) ||
      (cleanPositional.startsWith("'") && cleanPositional.endsWith("'"))) {
      cleanPositional = cleanPositional.slice(1, -1);
    }

    // 自动判定是否为无外壳的布尔参数 (Disabled / Enabled 互转)
    const lowerPositional = cleanPositional.toLowerCase();
    if (lowerPositional === 'disabled') {
      params.push('=disabled=yes');
    } else if (lowerPositional === 'enabled') {
      params.push('=disabled=no');
    } else if (lowerPositional === 'yes' || lowerPositional === 'no') {
      // Ignore stand-alone yes/no as we wouldn't know the key reliably
    } else {
      // 常见命令的无名位置参数映射
      const POSITIONAL_PARAM_MAP: Record<string, string> = {
        '/ping': 'address',
        '/tool/ping': 'address',
        '/tool/mac-ping': 'mac-address',
        '/tool/traceroute': 'address',
        '/tool/fetch': 'url',
        '/tool/bandwidth-test': 'address',
        '/system/script/run': 'number',
        '/system/package/install': 'package-path',
        '/export': 'file',
        '/system/backup/save': 'name',
      };

      const paramName = POSITIONAL_PARAM_MAP[apiCommand] || 'numbers'; // 默认回退为 numbers
      params.unshift(`=${paramName}=${cleanPositional}`); // 放到最前面
    }

    // 处理后续附带的多余无名参数 (例如 boolean 和 positional param 的混合)
    if (positionalArgs.length > 1) {
      for (let i = 1; i < positionalArgs.length; i++) {
        const extra = positionalArgs[i].toLowerCase();
        if (extra === 'disabled') params.push('=disabled=yes');
        if (extra === 'enabled') params.push('=disabled=no');
      }
    }
  }

  return { apiCommand, params };
}

/**
 * 检测命令是否为完整 CLI 格式（包含路径和参数）
 * 例如: "/ip/address/add address=192.168.1.1/24 interface=ether1"
 */
export function isFullCliCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.startsWith('/') && trimmed.includes(' ') && trimmed.includes('=');
}
