/**
 * SkillAwarePromptBuilder 单元测试
 * 
 * 测试 buildToolDescriptions 方法
 */

import { SkillAwarePromptBuilder } from './skillAwarePromptBuilder';
import { AgentTool } from '../rag/mastraAgent';

describe('SkillAwarePromptBuilder', () => {
  let promptBuilder: SkillAwarePromptBuilder;

  beforeEach(() => {
    promptBuilder = new SkillAwarePromptBuilder();
  });

  describe('buildToolDescriptions', () => {
    it('should return default message for empty tool list', () => {
      const result = promptBuilder.buildToolDescriptions([]);
      expect(result).toBe('当前没有可用工具。');
    });

    it('should format single tool correctly', () => {
      const tools: AgentTool[] = [
        {
          name: 'device_query',
          description: '查询设备配置和状态',
          parameters: {
            command: {
              type: 'string',
              description: 'RouterOS API 路径',
              required: true,
            },
            proplist: {
              type: 'string',
              description: '返回字段列表',
              required: false,
            },
          },
          execute: async () => ({}),
        },
      ];

      const result = promptBuilder.buildToolDescriptions(tools);

      expect(result).toContain('- device_query: 查询设备配置和状态');
      expect(result).toContain('参数:');
      expect(result).toContain('- command (string, 必需): RouterOS API 路径');
      expect(result).toContain('- proplist (string): 返回字段列表');
    });

    it('should format multiple tools correctly', () => {
      const tools: AgentTool[] = [
        {
          name: 'device_query',
          description: '查询设备配置和状态',
          parameters: {
            command: {
              type: 'string',
              description: 'RouterOS API 路径',
              required: true,
            },
          },
          execute: async () => ({}),
        },
        {
          name: 'knowledge_search',
          description: '搜索知识库',
          parameters: {
            query: {
              type: 'string',
              description: '搜索关键词',
              required: true,
            },
            limit: {
              type: 'number',
              description: '返回结果数量',
              required: false,
            },
          },
          execute: async () => ({}),
        },
      ];

      const result = promptBuilder.buildToolDescriptions(tools);

      // 验证两个工具都被格式化
      expect(result).toContain('- device_query: 查询设备配置和状态');
      expect(result).toContain('- knowledge_search: 搜索知识库');
      
      // 验证参数格式
      expect(result).toContain('- command (string, 必需): RouterOS API 路径');
      expect(result).toContain('- query (string, 必需): 搜索关键词');
      expect(result).toContain('- limit (number): 返回结果数量');
      
      // 验证工具之间有空行分隔
      expect(result).toContain('\n\n');
    });

    it('should mark required parameters correctly', () => {
      const tools: AgentTool[] = [
        {
          name: 'test_tool',
          description: '测试工具',
          parameters: {
            required_param: {
              type: 'string',
              description: '必需参数',
              required: true,
            },
            optional_param: {
              type: 'string',
              description: '可选参数',
              required: false,
            },
            default_param: {
              type: 'string',
              description: '默认参数（未指定 required）',
            },
          },
          execute: async () => ({}),
        },
      ];

      const result = promptBuilder.buildToolDescriptions(tools);

      expect(result).toContain('- required_param (string, 必需): 必需参数');
      expect(result).toContain('- optional_param (string): 可选参数');
      expect(result).toContain('- default_param (string): 默认参数');
      // 确保可选参数没有 "必需" 标记
      expect(result).not.toContain('optional_param (string, 必需)');
    });

    it('should handle tool with no parameters', () => {
      const tools: AgentTool[] = [
        {
          name: 'simple_tool',
          description: '简单工具',
          parameters: {},
          execute: async () => ({}),
        },
      ];

      const result = promptBuilder.buildToolDescriptions(tools);

      expect(result).toContain('- simple_tool: 简单工具');
      expect(result).toContain('参数:');
    });

    it('should handle various parameter types', () => {
      const tools: AgentTool[] = [
        {
          name: 'multi_type_tool',
          description: '多类型参数工具',
          parameters: {
            str_param: {
              type: 'string',
              description: '字符串参数',
              required: true,
            },
            num_param: {
              type: 'number',
              description: '数字参数',
              required: false,
            },
            bool_param: {
              type: 'boolean',
              description: '布尔参数',
              required: false,
            },
            obj_param: {
              type: 'object',
              description: '对象参数',
              required: false,
            },
          },
          execute: async () => ({}),
        },
      ];

      const result = promptBuilder.buildToolDescriptions(tools);

      expect(result).toContain('- str_param (string, 必需): 字符串参数');
      expect(result).toContain('- num_param (number): 数字参数');
      expect(result).toContain('- bool_param (boolean): 布尔参数');
      expect(result).toContain('- obj_param (object): 对象参数');
    });
  });
});


/**
 * SARC 提示词构建测试
 * 验证提示词包含工具描述
 */
describe('SARC Prompt Building Integration', () => {
  let promptBuilder: SkillAwarePromptBuilder;

  beforeEach(() => {
    promptBuilder = new SkillAwarePromptBuilder();
  });

  it('should include tool descriptions in skill-enhanced prompt workflow', () => {
    // 模拟过滤后的工具列表
    const filteredTools: AgentTool[] = [
      {
        name: 'device_query',
        description: '查询设备配置和状态',
        parameters: {
          command: {
            type: 'string',
            description: 'RouterOS API 路径',
            required: true,
          },
        },
        execute: async () => ({}),
      },
      {
        name: 'knowledge_search',
        description: '搜索知识库',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            required: true,
          },
        },
        execute: async () => ({}),
      },
    ];

    // 构建工具描述
    const toolDescriptions = promptBuilder.buildToolDescriptions(filteredTools);

    // 验证工具描述包含所有过滤后的工具
    expect(toolDescriptions).toContain('device_query');
    expect(toolDescriptions).toContain('knowledge_search');
    expect(toolDescriptions).toContain('command (string, 必需)');
    expect(toolDescriptions).toContain('query (string, 必需)');
  });

  it('should match tool descriptions with filtered tool list', () => {
    // 模拟 Skill 允许的工具（过滤后）
    const allowedTools = ['device_query', 'monitor_metrics'];
    
    const allTools: AgentTool[] = [
      {
        name: 'device_query',
        description: '查询设备',
        parameters: { cmd: { type: 'string', description: '命令', required: true } },
        execute: async () => ({}),
      },
      {
        name: 'knowledge_search',
        description: '搜索知识',
        parameters: { q: { type: 'string', description: '查询', required: true } },
        execute: async () => ({}),
      },
      {
        name: 'monitor_metrics',
        description: '监控指标',
        parameters: { type: { type: 'string', description: '类型', required: true } },
        execute: async () => ({}),
      },
    ];

    // 模拟工具过滤
    const filteredTools = allTools.filter(t => allowedTools.includes(t.name));
    
    // 构建工具描述
    const toolDescriptions = promptBuilder.buildToolDescriptions(filteredTools);

    // 验证只包含过滤后的工具
    expect(toolDescriptions).toContain('device_query');
    expect(toolDescriptions).toContain('monitor_metrics');
    expect(toolDescriptions).not.toContain('knowledge_search');
  });
});

/**
 * RALC generateThought 占位符替换测试
 * 验证 {{tools}} 占位符被正确替换
 */
describe('RALC Placeholder Replacement', () => {
  it('should replace {{tools}} placeholder in prompt override', () => {
    // 模拟 promptOverride 模板
    const promptOverride = `
## 可用工具

{{tools}}

## 用户请求

{{message}}

## 之前的步骤

{{steps}}
`;

    // 模拟工具列表
    const tools: AgentTool[] = [
      {
        name: 'device_query',
        description: '查询设备',
        parameters: {
          command: { type: 'string', description: 'API 路径', required: true },
        },
        execute: async () => ({}),
      },
    ];

    // 构建工具描述
    const toolDescriptions = tools.map(tool => {
      const params = Object.entries(tool.parameters)
        .map(([name, info]) => `    - ${name} (${info.type}${info.required ? ', 必需' : ''}): ${info.description}`)
        .join('\n');
      return `- ${tool.name}: ${tool.description}\n  参数:\n${params}`;
    }).join('\n\n');

    // 模拟替换逻辑
    const message = '查询接口状态';
    const stepsText = '无';
    
    const result = promptOverride
      .replace('{{message}}', message)
      .replace('{{tools}}', toolDescriptions)
      .replace('{{steps}}', stepsText);

    // 验证替换结果
    expect(result).toContain('- device_query: 查询设备');
    expect(result).toContain('- command (string, 必需): API 路径');
    expect(result).toContain('查询接口状态');
    expect(result).not.toContain('{{tools}}');
    expect(result).not.toContain('{{message}}');
    expect(result).not.toContain('{{steps}}');
  });

  it('should handle prompt override without {{tools}} placeholder safely', () => {
    // 模拟不包含 {{tools}} 的 promptOverride
    const promptOverride = `
## 用户请求

{{message}}

## 之前的步骤

{{steps}}
`;

    const toolDescriptions = '- some_tool: 描述';
    const message = '测试消息';
    const stepsText = '无';

    // 替换逻辑（即使没有 {{tools}} 也不会报错）
    const result = promptOverride
      .replace('{{message}}', message)
      .replace('{{tools}}', toolDescriptions)
      .replace('{{steps}}', stepsText);

    // 验证不会报错，且其他占位符正常替换
    expect(result).toContain('测试消息');
    expect(result).not.toContain('{{message}}');
    expect(result).not.toContain('{{steps}}');
    // {{tools}} 不存在，所以工具描述不会出现
    expect(result).not.toContain('some_tool');
  });

  it('should maintain correct replacement order', () => {
    // 测试替换顺序：message → tools → steps
    const promptOverride = '{{message}} | {{tools}} | {{steps}}';
    
    const result = promptOverride
      .replace('{{message}}', 'MSG')
      .replace('{{tools}}', 'TOOLS')
      .replace('{{steps}}', 'STEPS');

    expect(result).toBe('MSG | TOOLS | STEPS');
  });
});
