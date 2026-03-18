/**
 * FileProcessor 文件处理服务
 * 支持多种格式的文件解析和知识条目生成
 *
 * Requirements: 7.1-7.6, 8.1-8.5, 9.1-9.6, 10.1-10.6, 11.1-11.7, 12.1-12.7
 * - 7.x: Markdown 文件解析
 * - 8.x: 纯文本文件解析
 * - 9.x: 设备配置文件解析（通过插件扩展）
 * - 10.x: JSON 文件解析
 * - 11.x: 文件处理流程
 * - 12.x: 文件上传界面支持
 */

import { KnowledgeBase, KnowledgeEntry, KnowledgeEntryType, knowledgeBase } from './knowledgeBase';
import { EmbeddingService, embeddingService } from './embeddingService';
import { logger } from '../../../utils/logger';
import { v4 as uuidv4 } from 'uuid';

// ==================== 类型定义 ====================

/**
 * 上传的文件
 */
export interface UploadedFile {
  filename: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * 文件类型信息
 */
export interface FileTypeInfo {
  extension: string;
  mimeTypes: string[];
  description: string;
  maxSize: number;
}

/**
 * 解析后的内容
 */
export interface ParsedContent {
  title: string;
  content: string;
  metadata: {
    category: string;
    tags: string[];
    originalFilename: string;
    fileType: string;
    [key: string]: unknown;  // 允许额外的元数据字段
  };
  chunks?: ContentChunk[];
  warnings?: string[];
}

/**
 * 内容分块
 */
export interface ContentChunk {
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * 处理后的文件结果
 */
export interface ProcessedFileResult {
  success: boolean;
  filename: string;
  entries: KnowledgeEntry[];
  warnings?: string[];
  error?: string;
}

/**
 * 文件解析器接口
 */
export interface FileParser {
  /**
   * 检查是否可以解析该文件
   */
  canParse(file: UploadedFile): boolean;

  /**
   * 解析文件内容
   */
  parse(file: UploadedFile): Promise<ParsedContent>;
}

/**
 * 知识条目 JSON 模式
 */
export interface KnowledgeEntrySchema {
  type?: KnowledgeEntryType;
  title: string;
  content: string;
  category?: string;
  tags?: string[];
}

// ==================== 常量定义 ====================

/**
 * 支持的文件类型
 */
export const SUPPORTED_FILE_TYPES: FileTypeInfo[] = [
  {
    extension: '.md',
    mimeTypes: ['text/markdown', 'text/x-markdown', 'text/plain'],
    description: 'Markdown 文档',
    maxSize: 10 * 1024 * 1024, // 10MB
  },
  {
    extension: '.txt',
    mimeTypes: ['text/plain'],
    description: '纯文本文件',
    maxSize: 5 * 1024 * 1024, // 5MB
  },
  {
    extension: '.yaml',
    mimeTypes: ['text/yaml', 'text/x-yaml', 'application/x-yaml'],
    description: '设备配置文件 (YAML)',
    maxSize: 5 * 1024 * 1024, // 5MB
  },
  {
    extension: '.yml',
    mimeTypes: ['text/yaml', 'text/x-yaml', 'application/x-yaml'],
    description: '设备配置文件 (YAML)',
    maxSize: 5 * 1024 * 1024, // 5MB
  },
  {
    extension: '.json',
    mimeTypes: ['application/json', 'text/json'],
    description: 'JSON 知识条目',
    maxSize: 10 * 1024 * 1024, // 10MB
  },
];

/**
 * 默认分块大小（字符数，约 1000 tokens）
 */
const DEFAULT_CHUNK_SIZE = 4000;

/**
 * 分块重叠大小
 */
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * 处理上下文（用于跟踪和回滚）
 */
export interface ProcessingContext {
  filename: string;
  startTime: number;
  createdEntryIds: string[];
  warnings: string[];
  currentStage: 'validation' | 'parsing' | 'embedding' | 'storage' | 'completed' | 'failed';
  error?: string;
}

/**
 * 回滚结果
 */
export interface RollbackResult {
  success: boolean;
  rolledBackIds: string[];
  failedIds: string[];
  error?: string;
}

// ==================== 标签生成算法 ====================

/**
 * 标签生成配置
 */
export interface TagGenerationConfig {
  maxTags: number;           // 最大标签数量
  minKeywordLength: number;  // 最小关键词长度
  includeFileType: boolean;  // 是否包含文件类型标签
}

const DEFAULT_TAG_CONFIG: TagGenerationConfig = {
  maxTags: 10,
  minKeywordLength: 3,
  includeFileType: true,
};

/**
 * 设备配置关键词映射（通用网络设备）
 */
const DEVICE_CONFIG_KEYWORDS: Record<string, string[]> = {
  firewall: ['firewall', 'filter', 'nat', 'acl', 'access-list', 'chain', 'action', 'drop', 'accept', 'reject', 'deny', 'permit'],
  routing: ['route', 'routing', 'bgp', 'ospf', 'rip', 'gateway', 'static-route', 'distance', 'metric'],
  interface: ['interface', 'bridge', 'vlan', 'bonding', 'ethernet', 'port-channel', 'loopback'],
  addressing: ['ip address', 'subnet', 'netmask', 'cidr', 'dhcp', 'pool'],
  system: ['hostname', 'ntp', 'syslog', 'snmp', 'aaa', 'user', 'logging', 'clock'],
  qos: ['qos', 'queue', 'bandwidth', 'priority', 'rate-limit', 'traffic-shaping'],
  vpn: ['vpn', 'ipsec', 'tunnel', 'peer', 'gre', 'wireguard', 'l2tp'],
  security: ['certificate', 'ssl', 'tls', 'encryption', 'password', 'secret', 'radius'],
};

/**
 * 网络术语关键词
 */
const NETWORK_KEYWORDS: Record<string, string[]> = {
  protocol: ['tcp', 'udp', 'icmp', 'http', 'https', 'ftp', 'ssh', 'telnet', 'snmp'],
  addressing: ['ip', 'ipv4', 'ipv6', 'mac', 'subnet', 'cidr', 'netmask'],
  services: ['dns', 'dhcp', 'ntp', 'radius', 'ldap', 'smtp', 'pop3', 'imap'],
  topology: ['lan', 'wan', 'vlan', 'vpn', 'dmz', 'gateway', 'router', 'switch'],
  security: ['firewall', 'acl', 'nat', 'port-forwarding', 'ipsec', 'ssl', 'tls'],
};

/**
 * 标签生成器类
 * Requirements: 7.5, 9.5
 */
export class TagGenerator {
  private config: TagGenerationConfig;

  constructor(config?: Partial<TagGenerationConfig>) {
    this.config = { ...DEFAULT_TAG_CONFIG, ...config };
  }

  /**
   * 从内容生成标签
   * Requirements: 7.5, 9.5
   * 
   * @param content 文本内容
   * @param fileType 文件类型
   * @param existingTags 已有标签
   * @returns 生成的标签数组
   */
  generateTags(content: string, fileType?: string, existingTags?: string[]): string[] {
    const tags = new Set<string>(existingTags || []);
    const lowerContent = content.toLowerCase();

    // 1. 添加文件类型标签
    if (this.config.includeFileType && fileType) {
      tags.add(fileType);
    }

    // 2. 检测设备配置相关标签
    this.detectDeviceConfigTags(lowerContent, tags);

    // 3. 检测网络术语标签
    this.detectNetworkTags(lowerContent, tags);

    // 4. 提取内容关键词
    this.extractKeywords(content, tags);

    // 5. 规范化和去重
    const normalizedTags = this.normalizeTags(Array.from(tags));

    // 6. 限制标签数量
    return normalizedTags.slice(0, this.config.maxTags);
  }

  /**
   * 检测设备配置相关标签（通用网络设备）
   */
  private detectDeviceConfigTags(content: string, tags: Set<string>): void {
    let hasDeviceConfig = false;

    for (const [category, keywords] of Object.entries(DEVICE_CONFIG_KEYWORDS)) {
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          tags.add(category);
          hasDeviceConfig = true;
          break;
        }
      }
    }

    if (hasDeviceConfig) {
      tags.add('device-config');
    }
  }

  /**
   * 检测网络术语标签
   */
  private detectNetworkTags(content: string, tags: Set<string>): void {
    let hasNetworking = false;

    for (const [category, keywords] of Object.entries(NETWORK_KEYWORDS)) {
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          hasNetworking = true;
          // 对于某些重要的关键词，直接添加为标签
          if (['firewall', 'vpn', 'dhcp', 'dns', 'nat', 'vlan'].includes(keyword)) {
            tags.add(keyword);
          }
          break;
        }
      }
    }

    // 如果检测到网络相关内容，添加 networking 标签
    if (hasNetworking) {
      tags.add('networking');
    }
  }

  /**
   * 提取内容关键词
   */
  private extractKeywords(content: string, tags: Set<string>): void {
    // 提取代码块中的语言标识
    const codeBlockRegex = /```(\w+)/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const lang = match[1].toLowerCase();
      if (lang.length >= this.config.minKeywordLength) {
        tags.add(lang);
      }
    }

    // 提取 Markdown 标题中的关键词
    const headingRegex = /^#+\s+(.+)$/gm;
    while ((match = headingRegex.exec(content)) !== null) {
      const heading = match[1].toLowerCase();
      // 提取标题中的重要词汇
      const words = heading.split(/\s+/).filter(w => 
        w.length >= this.config.minKeywordLength && 
        !this.isStopWord(w)
      );
      for (const word of words.slice(0, 3)) {
        tags.add(this.cleanWord(word));
      }
    }

    // 检测常见技术术语
    const techTerms = [
      'api', 'cli', 'gui', 'ssh', 'ssl', 'tls', 'http', 'https',
      'json', 'xml', 'yaml', 'csv', 'log', 'debug', 'error',
      'config', 'configuration', 'setup', 'install', 'deploy',
      'backup', 'restore', 'monitor', 'alert', 'notification',
    ];

    const lowerContent = content.toLowerCase();
    for (const term of techTerms) {
      if (lowerContent.includes(term)) {
        tags.add(term);
      }
    }
  }

  /**
   * 规范化标签
   */
  private normalizeTags(tags: string[]): string[] {
    return tags
      .map(tag => this.normalizeTag(tag))
      .filter(tag => tag.length >= 2)
      .filter((tag, index, self) => self.indexOf(tag) === index) // 去重
      .sort();
  }

  /**
   * 规范化单个标签
   */
  private normalizeTag(tag: string): string {
    return tag
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * 清理单词
   */
  private cleanWord(word: string): string {
    return word.replace(/[^a-z0-9]/g, '');
  }

  /**
   * 检查是否是停用词
   */
  private isStopWord(word: string): boolean {
    const stopWords = [
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
      'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
      '的', '是', '在', '和', '了', '有', '为', '与', '或', '及',
    ];
    return stopWords.includes(word.toLowerCase());
  }

  /**
   * 为设备配置生成专用标签（通用网络设备）
   */
  generateDeviceConfigTags(content: string, metadata?: Record<string, unknown>): string[] {
    const tags = new Set<string>(['device-config', 'configuration']);
    const lowerContent = content.toLowerCase();

    // 检测子系统
    for (const [subsystem, keywords] of Object.entries(DEVICE_CONFIG_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lowerContent.includes(keyword)) {
          tags.add(subsystem);
          break;
        }
      }
    }

    // 从元数据中提取标签
    if (metadata) {
      const subsystems = metadata.subsystems as string[] | undefined;
      if (subsystems) {
        for (const subsystem of subsystems) {
          tags.add(subsystem);
        }
      }

      const interfaces = metadata.interfaces as string[] | undefined;
      if (interfaces && interfaces.length > 0) {
        tags.add('interface');
      }

      const ipAddresses = metadata.ipAddresses as string[] | undefined;
      if (ipAddresses && ipAddresses.length > 0) {
        tags.add('ip');
      }
    }

    return this.normalizeTags(Array.from(tags)).slice(0, this.config.maxTags);
  }

  /**
   * 为 Markdown 文档生成专用标签
   * Requirements: 7.5
   */
  generateMarkdownTags(content: string): string[] {
    const tags = new Set<string>(['markdown', 'documentation']);

    // 检测代码块语言
    const codeBlockRegex = /```(\w+)/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      tags.add(match[1].toLowerCase());
    }

    // 检测设备配置和网络相关内容
    const lowerContent = content.toLowerCase();
    this.detectDeviceConfigTags(lowerContent, tags);
    this.detectNetworkTags(lowerContent, tags);

    return this.normalizeTags(Array.from(tags)).slice(0, this.config.maxTags);
  }

  /**
   * 合并多个标签数组
   */
  mergeTags(...tagArrays: string[][]): string[] {
    const merged = new Set<string>();
    for (const tags of tagArrays) {
      for (const tag of tags) {
        merged.add(tag);
      }
    }
    return this.normalizeTags(Array.from(merged)).slice(0, this.config.maxTags);
  }

  /**
   * 获取配置
   */
  getConfig(): TagGenerationConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TagGenerationConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// 导出单例标签生成器
export const tagGenerator = new TagGenerator();


// ==================== Markdown 解析器 ====================

/**
 * Markdown 文件解析器
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
export class MarkdownParser implements FileParser {
  canParse(file: UploadedFile): boolean {
    const ext = this.getExtension(file.filename);
    return ext === '.md' || ext === '.markdown';
  }

  async parse(file: UploadedFile): Promise<ParsedContent> {
    const content = file.buffer.toString('utf-8');
    const warnings: string[] = [];

    // 提取标题
    const title = this.extractTitle(content, file.filename);

    // 解析 Markdown 结构
    const { parsedContent, parseWarnings } = this.parseMarkdown(content);
    warnings.push(...parseWarnings);

    // 生成标签
    const tags = this.generateTags(content);

    // 分块处理
    const chunks = this.chunkContent(parsedContent);

    return {
      title,
      content: parsedContent,
      metadata: {
        category: 'documentation',
        tags,
        originalFilename: file.filename,
        fileType: 'markdown',
      },
      chunks,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 提取标题
   * Requirements: 7.4
   * 优先使用 Markdown 一级标题，否则使用文件名
   */
  private extractTitle(content: string, filename: string): string {
    // 尝试从 Markdown 一级标题提取（只匹配 # 开头的一级标题）
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      // 确保标题不是纯符号且有意义
      if (title.length > 2 && !/^[=\-_*#]+$/.test(title)) {
        return title.substring(0, 100);
      }
    }

    // 使用文件名作为标题
    return filename.replace(/\.(md|markdown)$/i, '');
  }

  /**
   * 解析 Markdown 内容
   * Requirements: 7.2, 7.3, 7.6
   */
  private parseMarkdown(content: string): { parsedContent: string; parseWarnings: string[] } {
    const warnings: string[] = [];
    let parsedContent = content;

    // 检查并修复常见的 Markdown 语法问题
    try {
      // 检查未闭合的代码块
      const codeBlockMatches = content.match(/```/g);
      if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
        warnings.push('检测到未闭合的代码块，已尝试修复');
        parsedContent += '\n```';
      }

      // 检查未闭合的行内代码
      const lines = parsedContent.split('\n');
      const fixedLines = lines.map((line, index) => {
        const backtickCount = (line.match(/`/g) || []).length;
        if (backtickCount % 2 !== 0 && !line.includes('```')) {
          warnings.push(`第 ${index + 1} 行存在未闭合的行内代码`);
          return line + '`';
        }
        return line;
      });
      parsedContent = fixedLines.join('\n');

    } catch (error) {
      warnings.push(`Markdown 解析警告: ${(error as Error).message}`);
    }

    return { parsedContent, parseWarnings: warnings };
  }

  /**
   * 生成标签
   * Requirements: 7.5
   */
  private generateTags(content: string): string[] {
    const tags: Set<string> = new Set(['markdown']);

    // 检测代码块语言
    const codeBlockRegex = /```(\w+)/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      tags.add(match[1].toLowerCase());
    }

    // 检测设备配置相关关键词
    const configKeywords = [
      'firewall', 'nat', 'acl', 'interface', 'bridge',
      'vlan', 'ip address', 'route', 'hostname',
    ];
    const lowerContent = content.toLowerCase();
    for (const keyword of configKeywords) {
      if (lowerContent.includes(keyword)) {
        tags.add('device-config');
        break;
      }
    }

    // 检测网络相关关键词
    const networkKeywords = ['tcp', 'udp', 'ip', 'dns', 'dhcp', 'vpn', 'vlan', 'subnet'];
    for (const keyword of networkKeywords) {
      if (lowerContent.includes(keyword)) {
        tags.add('networking');
        break;
      }
    }

    return Array.from(tags);
  }

  /**
   * 内容分块
   */
  private chunkContent(content: string): ContentChunk[] {
    if (content.length <= DEFAULT_CHUNK_SIZE) {
      return [{ content, metadata: { chunkIndex: 0 } }];
    }

    const chunks: ContentChunk[] = [];
    const sections = this.splitBySections(content);

    let currentChunk = '';
    let chunkIndex = 0;

    for (const section of sections) {
      if (currentChunk.length + section.length > DEFAULT_CHUNK_SIZE) {
        if (currentChunk.length > 0) {
          chunks.push({ content: currentChunk.trim(), metadata: { chunkIndex } });
          chunkIndex++;
          // 保留重叠部分
          currentChunk = currentChunk.slice(-DEFAULT_CHUNK_OVERLAP) + section;
        } else {
          // 单个 section 超过限制，强制分割
          const forcedChunks = this.forceChunk(section);
          for (const fc of forcedChunks) {
            chunks.push({ content: fc, metadata: { chunkIndex } });
            chunkIndex++;
          }
          currentChunk = '';
        }
      } else {
        currentChunk += section;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({ content: currentChunk.trim(), metadata: { chunkIndex } });
    }

    return chunks;
  }

  /**
   * 按章节分割
   */
  private splitBySections(content: string): string[] {
    // 按标题分割
    const sections = content.split(/(?=^#{1,6}\s)/m);
    return sections.filter(s => s.trim().length > 0);
  }

  /**
   * 强制分块
   */
  private forceChunk(text: string): string[] {
    const chunks: string[] = [];
    const step = DEFAULT_CHUNK_SIZE - DEFAULT_CHUNK_OVERLAP;
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, text.length);
      chunks.push(text.slice(start, end).trim());
      start += step;
    }

    return chunks;
  }

  private getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
  }
}


// ==================== 纯文本解析器 ====================

/**
 * 纯文本文件解析器
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */
export class TextParser implements FileParser {
  canParse(file: UploadedFile): boolean {
    const ext = this.getExtension(file.filename);
    return ext === '.txt';
  }

  async parse(file: UploadedFile): Promise<ParsedContent> {
    const content = file.buffer.toString('utf-8');

    // 检查空文件
    if (!content || content.trim().length === 0) {
      throw new Error('文件内容为空，无法处理');
    }

    // 提取标题
    const title = this.extractTitle(content, file.filename);

    // 生成标签
    const tags = this.generateTags(content);

    // 分块处理
    const chunks = this.chunkContent(content);

    return {
      title,
      content,
      metadata: {
        category: 'documentation',
        tags,
        originalFilename: file.filename,
        fileType: 'text',
      },
      chunks,
    };
  }

  /**
   * 提取标题
   * Requirements: 8.3
   * 直接使用文件名（去掉扩展名）作为标题
   */
  private extractTitle(_content: string, filename: string): string {
    // 直接使用文件名作为标题，去掉扩展名
    return filename.replace(/\.txt$/i, '');
  }

  /**
   * 生成标签
   */
  private generateTags(content: string): string[] {
    const tags: Set<string> = new Set(['text']);

    const lowerContent = content.toLowerCase();

    // 检测设备配置相关关键词
    const configKeywords = [
      'firewall', 'nat', 'acl', 'interface', 'bridge', 'vlan',
    ];
    for (const keyword of configKeywords) {
      if (lowerContent.includes(keyword)) {
        tags.add('device-config');
        break;
      }
    }

    // 检测网络相关关键词
    const networkKeywords = ['tcp', 'udp', 'ip', 'dns', 'dhcp', 'vpn', 'vlan', 'subnet'];
    for (const keyword of networkKeywords) {
      if (lowerContent.includes(keyword)) {
        tags.add('networking');
        break;
      }
    }

    return Array.from(tags);
  }

  /**
   * 内容分块
   * Requirements: 8.4
   */
  private chunkContent(content: string): ContentChunk[] {
    if (content.length <= DEFAULT_CHUNK_SIZE) {
      return [{ content, metadata: { chunkIndex: 0 } }];
    }

    const chunks: ContentChunk[] = [];
    const paragraphs = content.split(/\n\s*\n/);

    let currentChunk = '';
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const paragraphWithBreak = paragraph + '\n\n';

      if (currentChunk.length + paragraphWithBreak.length > DEFAULT_CHUNK_SIZE) {
        if (currentChunk.length > 0) {
          chunks.push({ content: currentChunk.trim(), metadata: { chunkIndex } });
          chunkIndex++;
          currentChunk = currentChunk.slice(-DEFAULT_CHUNK_OVERLAP) + paragraphWithBreak;
        } else {
          // 单个段落超过限制，强制分割
          const forcedChunks = this.forceChunk(paragraphWithBreak);
          for (const fc of forcedChunks) {
            chunks.push({ content: fc, metadata: { chunkIndex } });
            chunkIndex++;
          }
          currentChunk = '';
        }
      } else {
        currentChunk += paragraphWithBreak;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({ content: currentChunk.trim(), metadata: { chunkIndex } });
    }

    return chunks;
  }

  /**
   * 强制分块
   */
  private forceChunk(text: string): string[] {
    const chunks: string[] = [];
    const step = DEFAULT_CHUNK_SIZE - DEFAULT_CHUNK_OVERLAP;
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + DEFAULT_CHUNK_SIZE, text.length);
      chunks.push(text.slice(start, end).trim());
      start += step;
    }

    return chunks;
  }

  private getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
  }
}


// ==================== JSON 解析器 ====================

/**
 * JSON 文件解析器
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */
export class JSONParser implements FileParser {
  canParse(file: UploadedFile): boolean {
    const ext = this.getExtension(file.filename);
    return ext === '.json';
  }

  async parse(file: UploadedFile): Promise<ParsedContent> {
    const content = file.buffer.toString('utf-8');

    // 解析 JSON
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (error) {
      throw new Error(`JSON 解析失败: ${(error as Error).message}`);
    }

    // 判断是单条目还是批量导入
    if (Array.isArray(data)) {
      return this.parseBatch(data, file.filename);
    } else if (typeof data === 'object' && data !== null) {
      return this.parseSingle(data as Record<string, unknown>, file.filename);
    } else {
      throw new Error('JSON 格式无效：必须是对象或数组');
    }
  }

  /**
   * 解析单个知识条目
   * Requirements: 10.2, 10.4
   */
  private parseSingle(data: Record<string, unknown>, filename: string): ParsedContent {
    // 验证模式
    const validation = this.validateSchema(data);
    if (!validation.valid) {
      throw new Error(`JSON 模式验证失败: ${validation.errors.join(', ')}`);
    }

    const entry = data as unknown as KnowledgeEntrySchema;

    return {
      title: entry.title,
      content: entry.content,
      metadata: {
        category: entry.category || 'manual',
        tags: entry.tags || ['json-import'],
        originalFilename: filename,
        fileType: 'json',
      },
    };
  }

  /**
   * 解析批量知识条目
   * Requirements: 10.3, 10.6
   */
  private parseBatch(data: unknown[], filename: string): ParsedContent {
    const validEntries: KnowledgeEntrySchema[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      if (typeof item !== 'object' || item === null) {
        warnings.push(`条目 ${i + 1}: 不是有效的对象`);
        continue;
      }

      const validation = this.validateSchema(item as Record<string, unknown>);
      if (!validation.valid) {
        warnings.push(`条目 ${i + 1}: ${validation.errors.join(', ')}`);
        continue;
      }

      validEntries.push(item as unknown as KnowledgeEntrySchema);
    }

    if (validEntries.length === 0) {
      throw new Error('没有有效的知识条目可导入');
    }

    // 合并所有条目为一个内容
    const combinedContent = validEntries.map((entry, index) => {
      return `## ${index + 1}. ${entry.title}\n\n${entry.content}`;
    }).join('\n\n---\n\n');

    // 合并所有标签
    const allTags = new Set<string>(['json-import', 'batch']);
    for (const entry of validEntries) {
      if (entry.tags) {
        for (const tag of entry.tags) {
          allTags.add(tag);
        }
      }
    }

    return {
      title: `批量导入: ${validEntries.length} 个知识条目`,
      content: combinedContent,
      metadata: {
        category: 'batch-import',
        tags: Array.from(allTags),
        originalFilename: filename,
        fileType: 'json',
        batchCount: validEntries.length,
        batchEntries: validEntries,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 验证知识条目模式
   * Requirements: 10.4
   */
  private validateSchema(data: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // 必需字段
    if (!data.title || typeof data.title !== 'string') {
      errors.push('缺少必需字段 "title" 或类型不正确');
    }

    if (!data.content || typeof data.content !== 'string') {
      errors.push('缺少必需字段 "content" 或类型不正确');
    }

    // 可选字段类型检查
    if (data.type !== undefined) {
      const validTypes = ['alert', 'remediation', 'config', 'pattern', 'manual'];
      if (!validTypes.includes(data.type as string)) {
        errors.push(`"type" 必须是以下之一: ${validTypes.join(', ')}`);
      }
    }

    if (data.category !== undefined && typeof data.category !== 'string') {
      errors.push('"category" 必须是字符串');
    }

    if (data.tags !== undefined) {
      if (!Array.isArray(data.tags)) {
        errors.push('"tags" 必须是数组');
      } else if (!data.tags.every(t => typeof t === 'string')) {
        errors.push('"tags" 数组中的所有元素必须是字符串');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
  }
}


// ==================== FileProcessor 主服务 ====================

/**
 * FileProcessor 文件处理服务类
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
 */
export class FileProcessor {
  private parsers: FileParser[];
  private knowledgeBase: KnowledgeBase;
  private embeddingService: EmbeddingService;
  private initialized: boolean = false;

  constructor(
    kb?: KnowledgeBase,
    embeddingSvc?: EmbeddingService
  ) {
    this.knowledgeBase = kb || knowledgeBase;
    this.embeddingService = embeddingSvc || embeddingService;

    // 注册解析器
    this.parsers = [
      new MarkdownParser(),
      new TextParser(),
      new JSONParser(),
    ];

    logger.info('FileProcessor created');
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // 确保依赖服务已初始化
    if (!this.knowledgeBase.isInitialized()) {
      await this.knowledgeBase.initialize();
    }

    if (!this.embeddingService.isInitialized()) {
      await this.embeddingService.initialize();
    }

    this.initialized = true;
    logger.info('FileProcessor initialized');
  }

  /**
   * 获取支持的文件类型
   * Requirements: 11.1
   */
  getSupportedTypes(): FileTypeInfo[] {
    return [...SUPPORTED_FILE_TYPES];
  }

  /**
   * 验证文件
   * Requirements: 11.1
   * 
   * Validates:
   * - File type (extension must be supported)
   * - File size (must not exceed type-specific limit)
   * - File content (buffer must not be empty)
   * - Filename (must be valid)
   * 
   * @param file The uploaded file to validate
   * @returns Validation result with error message if invalid
   */
  validateFile(file: UploadedFile): { valid: boolean; error?: string; warnings?: string[] } {
    const warnings: string[] = [];

    // 检查文件名是否有效
    if (!file.filename || file.filename.trim().length === 0) {
      return {
        valid: false,
        error: '文件名不能为空',
      };
    }

    // 检查文件类型
    const ext = this.getExtension(file.filename);
    if (!ext) {
      return {
        valid: false,
        error: `文件缺少扩展名。支持的类型: ${SUPPORTED_FILE_TYPES.map(t => t.extension).join(', ')}`,
      };
    }

    const typeInfo = SUPPORTED_FILE_TYPES.find(t => t.extension === ext);

    if (!typeInfo) {
      return {
        valid: false,
        error: `不支持的文件类型: ${ext}。支持的类型: ${SUPPORTED_FILE_TYPES.map(t => t.extension).join(', ')}`,
      };
    }

    // 检查文件大小（不能为 0）
    if (file.size === 0 || !file.buffer || file.buffer.length === 0) {
      return {
        valid: false,
        error: '文件内容为空',
      };
    }

    // 检查文件大小（不能超过限制）
    if (file.size > typeInfo.maxSize) {
      const maxSizeMB = (typeInfo.maxSize / (1024 * 1024)).toFixed(1);
      const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
      return {
        valid: false,
        error: `文件大小超过限制: ${fileSizeMB}MB > ${maxSizeMB}MB`,
      };
    }

    // 检查 MIME 类型（宽松检查，只警告不拒绝）
    if (file.mimetype && !typeInfo.mimeTypes.includes(file.mimetype) && file.mimetype !== 'application/octet-stream') {
      warnings.push(`MIME 类型不匹配: ${file.mimetype}，预期: ${typeInfo.mimeTypes.join(' 或 ')}`);
      logger.warn(`MIME type mismatch: ${file.mimetype} for ${ext}`, { filename: file.filename });
    }

    return { 
      valid: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 批量验证文件
   * Requirements: 11.1
   * 
   * @param files The uploaded files to validate
   * @returns Array of validation results
   */
  validateFiles(files: UploadedFile[]): Array<{ filename: string; valid: boolean; error?: string; warnings?: string[] }> {
    return files.map(file => ({
      filename: file.filename,
      ...this.validateFile(file),
    }));
  }

  /**
   * 检查文件类型是否支持
   * Requirements: 11.1
   * 
   * @param filename The filename to check
   * @returns True if the file type is supported
   */
  isFileTypeSupported(filename: string): boolean {
    const ext = this.getExtension(filename);
    return SUPPORTED_FILE_TYPES.some(t => t.extension === ext);
  }

  /**
   * 获取文件类型信息
   * Requirements: 11.1
   * 
   * @param filename The filename to get type info for
   * @returns File type info or null if not supported
   */
  getFileTypeInfo(filename: string): FileTypeInfo | null {
    const ext = this.getExtension(filename);
    return SUPPORTED_FILE_TYPES.find(t => t.extension === ext) || null;
  }

  /**
   * 处理单个文件
   * Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7
   */
  async processFile(file: UploadedFile): Promise<ProcessedFileResult> {
    // 验证文件
    const validation = this.validateFile(file);
    if (!validation.valid) {
      return {
        success: false,
        filename: file.filename,
        entries: [],
        error: validation.error,
      };
    }

    // 查找合适的解析器
    const parser = this.parsers.find(p => p.canParse(file));
    if (!parser) {
      return {
        success: false,
        filename: file.filename,
        entries: [],
        error: `找不到适合的解析器: ${file.filename}`,
      };
    }

    const createdEntries: KnowledgeEntry[] = [];
    const warnings: string[] = [];

    try {
      // 解析文件
      const parsed = await parser.parse(file);
      if (parsed.warnings) {
        warnings.push(...parsed.warnings);
      }

      // 检查是否是 JSON 批量导入
      if (parsed.metadata.fileType === 'json' && parsed.metadata.batchEntries) {
        // 批量导入模式
        const batchEntries = parsed.metadata.batchEntries as KnowledgeEntrySchema[];
        for (const entryData of batchEntries) {
          try {
            const entry = await this.knowledgeBase.add({
              type: entryData.type || 'manual',
              title: entryData.title,
              content: entryData.content,
              metadata: {
                source: 'file_upload',
                timestamp: Date.now(),
                category: entryData.category || 'manual',
                tags: [...(entryData.tags || []), 'file-upload', 'json-import'],
                usageCount: 0,
                feedbackScore: 0,
                feedbackCount: 0,
                originalData: {
                  filename: file.filename,
                  fileType: 'json',
                },
              },
            });
            createdEntries.push(entry);
          } catch (error) {
            warnings.push(`创建条目 "${entryData.title}" 失败: ${(error as Error).message}`);
          }
        }
      } else {
        // 单条目模式
        const entry = await this.knowledgeBase.add({
          type: 'manual',
          title: parsed.title,
          content: parsed.content,
          metadata: {
            source: 'file_upload',
            timestamp: Date.now(),
            category: parsed.metadata.category,
            tags: [...parsed.metadata.tags, 'file-upload'],
            usageCount: 0,
            feedbackScore: 0,
            feedbackCount: 0,
            originalData: {
              filename: parsed.metadata.originalFilename,
              fileType: parsed.metadata.fileType,
            },
          },
        });
        createdEntries.push(entry);
      }

      return {
        success: true,
        filename: file.filename,
        entries: createdEntries,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      // 回滚已创建的条目
      for (const entry of createdEntries) {
        try {
          await this.knowledgeBase.delete(entry.id);
        } catch (rollbackError) {
          logger.error(`Failed to rollback entry ${entry.id}`, { error: rollbackError });
        }
      }

      return {
        success: false,
        filename: file.filename,
        entries: [],
        error: (error as Error).message,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  }

  /**
   * 批量处理文件
   * Requirements: 12.7
   */
  async processFiles(files: UploadedFile[]): Promise<ProcessedFileResult[]> {
    const results: ProcessedFileResult[] = [];

    for (const file of files) {
      const result = await this.processFile(file);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0);

    logger.info(`Batch processed ${files.length} files: ${successCount} success, ${totalEntries} entries created`);

    return results;
  }

  /**
   * 获取文件扩展名
   */
  private getExtension(filename: string): string {
    const lastDot = filename.lastIndexOf('.');
    return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
  }

  /**
   * 检查是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ==================== 处理失败回滚机制 ====================

  /**
   * 创建处理上下文
   * Requirements: 11.7
   * 
   * @param filename 文件名
   * @returns 处理上下文
   */
  createProcessingContext(filename: string): ProcessingContext {
    return {
      filename,
      startTime: Date.now(),
      createdEntryIds: [],
      warnings: [],
      currentStage: 'validation',
    };
  }

  /**
   * 跟踪已创建的条目
   * Requirements: 11.7
   * 
   * @param context 处理上下文
   * @param entryId 条目 ID
   */
  trackCreatedEntry(context: ProcessingContext, entryId: string): void {
    context.createdEntryIds.push(entryId);
    logger.debug(`Tracked created entry: ${entryId}`, { filename: context.filename });
  }

  /**
   * 回滚已创建的条目
   * Requirements: 11.7
   * 
   * @param context 处理上下文
   * @returns 回滚结果
   */
  async rollback(context: ProcessingContext): Promise<RollbackResult> {
    const rolledBackIds: string[] = [];
    const failedIds: string[] = [];

    logger.info(`Starting rollback for ${context.filename}`, { 
      entryCount: context.createdEntryIds.length,
      stage: context.currentStage,
    });

    for (const entryId of context.createdEntryIds) {
      try {
        await this.knowledgeBase.delete(entryId);
        rolledBackIds.push(entryId);
        logger.debug(`Rolled back entry: ${entryId}`);
      } catch (error) {
        failedIds.push(entryId);
        logger.error(`Failed to rollback entry ${entryId}`, { error });
      }
    }

    const success = failedIds.length === 0;
    
    logger.info(`Rollback completed for ${context.filename}`, {
      success,
      rolledBack: rolledBackIds.length,
      failed: failedIds.length,
    });

    return {
      success,
      rolledBackIds,
      failedIds,
      error: failedIds.length > 0 
        ? `无法回滚 ${failedIds.length} 个条目: ${failedIds.join(', ')}`
        : undefined,
    };
  }

  /**
   * 带回滚的文件处理
   * Requirements: 11.7
   * 
   * 这是一个增强版的 processFile，提供更详细的处理上下文和回滚能力
   * 
   * @param file 上传的文件
   * @returns 处理结果和上下文
   */
  async processFileWithContext(file: UploadedFile): Promise<{
    result: ProcessedFileResult;
    context: ProcessingContext;
  }> {
    const context = this.createProcessingContext(file.filename);

    try {
      // 阶段 1: 验证
      context.currentStage = 'validation';
      const validation = this.validateFile(file);
      if (!validation.valid) {
        context.currentStage = 'failed';
        context.error = validation.error;
        return {
          result: {
            success: false,
            filename: file.filename,
            entries: [],
            error: validation.error,
          },
          context,
        };
      }
      if (validation.warnings) {
        context.warnings.push(...validation.warnings);
      }

      // 阶段 2: 解析
      context.currentStage = 'parsing';
      const parser = this.parsers.find(p => p.canParse(file));
      if (!parser) {
        context.currentStage = 'failed';
        context.error = `找不到适合的解析器: ${file.filename}`;
        return {
          result: {
            success: false,
            filename: file.filename,
            entries: [],
            error: context.error,
          },
          context,
        };
      }

      const parsed = await parser.parse(file);
      if (parsed.warnings) {
        context.warnings.push(...parsed.warnings);
      }

      // 阶段 3: 存储（包含嵌入生成）
      context.currentStage = 'storage';
      const createdEntries: KnowledgeEntry[] = [];

      if (parsed.metadata.fileType === 'json' && parsed.metadata.batchEntries) {
        // 批量导入模式
        const batchEntries = parsed.metadata.batchEntries as KnowledgeEntrySchema[];
        for (const entryData of batchEntries) {
          try {
            const entry = await this.knowledgeBase.add({
              type: entryData.type || 'manual',
              title: entryData.title,
              content: entryData.content,
              metadata: {
                source: 'file_upload',
                timestamp: Date.now(),
                category: entryData.category || 'manual',
                tags: [...(entryData.tags || []), 'file-upload', 'json-import'],
                usageCount: 0,
                feedbackScore: 0,
                feedbackCount: 0,
                originalData: {
                  filename: file.filename,
                  fileType: 'json',
                },
              },
            });
            createdEntries.push(entry);
            this.trackCreatedEntry(context, entry.id);
          } catch (error) {
            context.warnings.push(`创建条目 "${entryData.title}" 失败: ${(error as Error).message}`);
          }
        }
      } else {
        // 单条目模式
        const entry = await this.knowledgeBase.add({
          type: 'manual',
          title: parsed.title,
          content: parsed.content,
          metadata: {
            source: 'file_upload',
            timestamp: Date.now(),
            category: parsed.metadata.category,
            tags: [...parsed.metadata.tags, 'file-upload'],
            usageCount: 0,
            feedbackScore: 0,
            feedbackCount: 0,
            originalData: {
              filename: parsed.metadata.originalFilename,
              fileType: parsed.metadata.fileType,
            },
          },
        });
        createdEntries.push(entry);
        this.trackCreatedEntry(context, entry.id);
      }

      // 阶段 4: 完成
      context.currentStage = 'completed';

      return {
        result: {
          success: true,
          filename: file.filename,
          entries: createdEntries,
          warnings: context.warnings.length > 0 ? context.warnings : undefined,
        },
        context,
      };
    } catch (error) {
      // 处理失败，执行回滚
      context.currentStage = 'failed';
      context.error = (error as Error).message;

      logger.error(`File processing failed at stage ${context.currentStage}`, {
        filename: file.filename,
        error: context.error,
        createdEntries: context.createdEntryIds.length,
      });

      // 执行回滚
      const rollbackResult = await this.rollback(context);

      return {
        result: {
          success: false,
          filename: file.filename,
          entries: [],
          error: context.error,
          warnings: [
            ...context.warnings,
            ...(rollbackResult.success 
              ? [`已回滚 ${rollbackResult.rolledBackIds.length} 个条目`]
              : [`回滚部分失败: ${rollbackResult.error}`]),
          ],
        },
        context,
      };
    }
  }

  /**
   * 批量处理文件（带回滚）
   * Requirements: 11.7, 12.7
   * 
   * @param files 上传的文件数组
   * @param stopOnError 是否在遇到错误时停止处理
   * @returns 处理结果数组
   */
  async processFilesWithRollback(
    files: UploadedFile[],
    stopOnError: boolean = false
  ): Promise<{
    results: ProcessedFileResult[];
    contexts: ProcessingContext[];
    allSuccess: boolean;
  }> {
    const results: ProcessedFileResult[] = [];
    const contexts: ProcessingContext[] = [];
    let allSuccess = true;

    for (const file of files) {
      const { result, context } = await this.processFileWithContext(file);
      results.push(result);
      contexts.push(context);

      if (!result.success) {
        allSuccess = false;
        if (stopOnError) {
          logger.info(`Stopping batch processing due to error in ${file.filename}`);
          break;
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + r.entries.length, 0);

    logger.info(`Batch processed ${results.length}/${files.length} files: ${successCount} success, ${totalEntries} entries created`);

    return {
      results,
      contexts,
      allSuccess,
    };
  }

  /**
   * 回滚所有处理上下文
   * Requirements: 11.7
   * 
   * @param contexts 处理上下文数组
   * @returns 回滚结果数组
   */
  async rollbackAll(contexts: ProcessingContext[]): Promise<RollbackResult[]> {
    const results: RollbackResult[] = [];

    for (const context of contexts) {
      if (context.createdEntryIds.length > 0) {
        const result = await this.rollback(context);
        results.push(result);
      }
    }

    const totalRolledBack = results.reduce((sum, r) => sum + r.rolledBackIds.length, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failedIds.length, 0);

    logger.info(`Rolled back all contexts`, {
      contextCount: contexts.length,
      totalRolledBack,
      totalFailed,
    });

    return results;
  }

  // ==================== 嵌入向量生成集成 ====================

  /**
   * 为解析后的内容生成嵌入向量
   * Requirements: 11.4
   * 
   * @param content 要嵌入的文本内容
   * @returns 嵌入向量
   */
  async generateEmbedding(content: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const result = await this.embeddingService.embed(content);
      return result.vector;
    } catch (error) {
      logger.error('Failed to generate embedding', { error, contentLength: content.length });
      throw new Error(`嵌入向量生成失败: ${(error as Error).message}`);
    }
  }

  /**
   * 批量生成嵌入向量
   * Requirements: 11.4
   * 
   * @param contents 要嵌入的文本内容数组
   * @returns 嵌入向量数组
   */
  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (contents.length === 0) {
      return [];
    }

    try {
      const results = await this.embeddingService.embedBatch(contents);
      return results.map(r => r.vector);
    } catch (error) {
      logger.error('Failed to generate batch embeddings', { error, count: contents.length });
      throw new Error(`批量嵌入向量生成失败: ${(error as Error).message}`);
    }
  }

  /**
   * 为解析后的内容分块生成嵌入向量
   * Requirements: 11.4
   * 
   * @param chunks 内容分块数组
   * @returns 带有嵌入向量的分块数组
   */
  async generateChunkEmbeddings(chunks: ContentChunk[]): Promise<Array<ContentChunk & { vector: number[] }>> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (chunks.length === 0) {
      return [];
    }

    const contents = chunks.map(c => c.content);
    
    try {
      const vectors = await this.generateEmbeddings(contents);
      
      return chunks.map((chunk, index) => ({
        ...chunk,
        vector: vectors[index],
      }));
    } catch (error) {
      logger.error('Failed to generate chunk embeddings', { error, chunkCount: chunks.length });
      throw new Error(`分块嵌入向量生成失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取嵌入服务配置
   * Requirements: 11.4
   */
  getEmbeddingConfig(): { provider: string; model: string; dimensions: number } {
    const config = this.embeddingService.getConfig();
    return {
      provider: config.provider,
      model: config.model || 'unknown',
      dimensions: this.embeddingService.getDimensions(),
    };
  }

  /**
   * 检查嵌入服务是否可用
   * Requirements: 11.4
   */
  isEmbeddingServiceAvailable(): boolean {
    return this.embeddingService.isInitialized();
  }
}

// 导出单例实例
export const fileProcessor = new FileProcessor();

