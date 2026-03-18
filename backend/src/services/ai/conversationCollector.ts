/**
 * ConversationCollector - 对话收藏和转换服务
 *
 * 管理消息收藏和知识转换流程，包括：
 * - 收藏/取消收藏消息
 * - 获取收藏的问答对
 * - 转换对话为知识条目
 * - 自动生成标签建议
 * - 导出收藏消息为 Markdown
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.9, 13.10, 13.11, 14.1, 14.3, 14.4, 14.6
 */

import { v4 as uuidv4 } from 'uuid';
import {
  IConversationCollector,
  ChatMessage,
  CollectedQAPair,
  SessionCollectionSummary,
  ConvertToKnowledgeRequest,
  RAGCitation,
} from '../../types/ai';
import { ChatSessionService, chatSessionService } from './chatSessionService';
import { KnowledgeBase, knowledgeBase, KnowledgeEntry } from '../ai-ops/rag/knowledgeBase';
import type { VectorStoreClient } from '../ai-ops/rag/vectorStoreClient';
import { logger } from '../../utils/logger';

/**
 * 设备命令关键词
 */
const DEVICE_COMMAND_KEYWORDS = [
  'interface', 'ip', 'firewall', 'nat', 'route', 'routing', 'bridge',
  'vlan', 'dhcp', 'dns', 'vpn', 'ipsec', 'l2tp', 'pptp', 'pppoe',
  'queue', 'bandwidth', 'traffic', 'mangle', 'filter', 'address-list',
  'wireless', 'wlan', 'capsman', 'hotspot', 'user-manager',
  'snmp', 'netwatch', 'scheduler', 'script', 'tool', 'system',
  'certificate', 'radius', 'user', 'group', 'log', 'export', 'import',
  'backup', 'restore', 'upgrade', 'package', 'license',
  'ether', 'sfp', 'combo', 'bonding', 'vrrp', 'ospf', 'bgp', 'rip',
  'mpls', 'ldp', 'te', 'vpls', 'container', 'docker',
];

/**
 * 网络术语关键词
 */
const NETWORK_TERMS = [
  'tcp', 'udp', 'icmp', 'http', 'https', 'ftp', 'ssh', 'telnet',
  'dns', 'dhcp', 'arp', 'mac', 'vlan', 'trunk', 'access',
  'gateway', 'subnet', 'netmask', 'cidr', 'broadcast',
  'wan', 'lan', 'dmz', 'nat', 'pat', 'snat', 'dnat', 'masquerade',
  'qos', 'bandwidth', 'latency', 'jitter', 'packet', 'frame',
  'switch', 'router', 'firewall', 'proxy', 'load-balancer',
  'ipv4', 'ipv6', 'dual-stack', 'tunnel', 'gre', 'eoip',
  'ssl', 'tls', 'certificate', 'encryption', 'authentication',
  'port', 'socket', 'connection', 'session', 'flow',
];


/**
 * ConversationCollector 实现类
 *
 * 提供对话收藏和知识转换功能
 */
export class ConversationCollector implements IConversationCollector {
  private chatSessionService: ChatSessionService;
  private knowledgeBase: KnowledgeBase;
  private vectorClient: VectorStoreClient | null = null;

  constructor(
    sessionService?: ChatSessionService,
    kb?: KnowledgeBase
  ) {
    this.chatSessionService = sessionService || chatSessionService;
    this.knowledgeBase = kb || knowledgeBase;
    logger.info('ConversationCollector created');
  }

  /**
   * 注入 VectorStoreClient，用于知识转化时同步向量化存入 prompt_knowledge
   * Requirements: J4.11
   */
  setVectorClient(client: VectorStoreClient): void {
    this.vectorClient = client;
    logger.info('ConversationCollector: VectorStoreClient injected for prompt_knowledge sync');
  }

  /**
   * 收藏消息（标记问答对）
   * Requirements: 13.1, 13.2, 14.1
   *
   * @param sessionId 会话 ID
   * @param messageId 消息 ID（助手回复的消息 ID）
   */
  async collectMessage(sessionId: string, messageId: string): Promise<void> {
    const session = await this.chatSessionService.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 查找消息
    const messageIndex = session.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      throw new Error(`消息不存在: ${messageId}`);
    }

    const message = session.messages[messageIndex];
    
    // 只能收藏助手的回复
    if (message.role !== 'assistant') {
      throw new Error('只能收藏助手的回复消息');
    }

    // 标记为已收藏
    message.collected = true;
    message.collectedAt = new Date();

    // 更新会话中的消息
    session.messages[messageIndex] = message;

    // 更新收藏计数
    const collectedCount = session.messages.filter(m => m.collected).length;
    
    // 保存会话
    await this.updateSessionMessages(sessionId, session.messages, collectedCount);

    logger.info(`Collected message: ${messageId} in session: ${sessionId}`);
  }

  /**
   * 取消收藏
   * Requirements: 14.2
   *
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   */
  async uncollectMessage(sessionId: string, messageId: string): Promise<void> {
    const session = await this.chatSessionService.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 查找消息
    const messageIndex = session.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      throw new Error(`消息不存在: ${messageId}`);
    }

    const message = session.messages[messageIndex];

    // 取消收藏
    message.collected = false;
    message.collectedAt = undefined;

    // 更新会话中的消息
    session.messages[messageIndex] = message;

    // 更新收藏计数
    const collectedCount = session.messages.filter(m => m.collected).length;

    // 保存会话
    await this.updateSessionMessages(sessionId, session.messages, collectedCount);

    logger.info(`Uncollected message: ${messageId} in session: ${sessionId}`);
  }

  /**
   * 获取会话中的收藏消息
   * Requirements: 13.4
   *
   * @param sessionId 会话 ID
   * @returns 收藏的问答对列表
   */
  async getCollectedMessages(sessionId: string): Promise<CollectedQAPair[]> {
    const session = await this.chatSessionService.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const collectedPairs: CollectedQAPair[] = [];

    // 遍历消息，找到收藏的助手回复及其对应的用户问题
    for (let i = 0; i < session.messages.length; i++) {
      const message = session.messages[i];
      
      if (message.role === 'assistant' && message.collected) {
        // 查找前一条用户消息作为问题
        let questionMessage: ChatMessage | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (session.messages[j].role === 'user') {
            questionMessage = session.messages[j];
            break;
          }
        }

        if (questionMessage) {
          collectedPairs.push({
            id: uuidv4(),
            sessionId,
            question: {
              messageId: questionMessage.id || `msg_${i - 1}`,
              content: questionMessage.content,
              timestamp: questionMessage.timestamp || new Date(),
            },
            answer: {
              messageId: message.id || `msg_${i}`,
              content: message.content,
              timestamp: message.timestamp || new Date(),
              citations: message.citations,
            },
            collectedAt: message.collectedAt || new Date(),
            converted: false,
          });
        }
      }
    }

    return collectedPairs;
  }

  /**
   * 获取所有有收藏消息的会话
   * Requirements: 14.3, 14.4
   *
   * @returns 会话收藏摘要列表
   */
  async getSessionsWithCollections(): Promise<SessionCollectionSummary[]> {
    const allSessions = await this.chatSessionService.getAll();
    const summaries: SessionCollectionSummary[] = [];

    for (const session of allSessions) {
      const collectedMessages = session.messages.filter(m => m.collected);
      
      if (collectedMessages.length > 0) {
        // 找到最后收藏时间
        const lastCollectedAt = collectedMessages.reduce((latest, msg) => {
          const collectedAt = msg.collectedAt ? new Date(msg.collectedAt) : new Date(0);
          return collectedAt > latest ? collectedAt : latest;
        }, new Date(0));

        summaries.push({
          sessionId: session.id,
          sessionTitle: session.title,
          collectedCount: collectedMessages.length,
          unconvertedCount: collectedMessages.length,
          lastCollectedAt,
        });
      }
    }

    // 按最后收藏时间倒序排列
    summaries.sort((a, b) => b.lastCollectedAt.getTime() - a.lastCollectedAt.getTime());

    return summaries;
  }

  /**
   * 更新会话消息（内部方法）
   */
  private async updateSessionMessages(
    sessionId: string,
    messages: ChatMessage[],
    collectedCount: number
  ): Promise<void> {
    const session = await this.chatSessionService.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 清除现有消息并重新添加
    await this.chatSessionService.clearMessages(sessionId);
    
    // 批量添加消息
    if (messages.length > 0) {
      await this.chatSessionService.addMessages(sessionId, messages);
    }

    logger.debug(`Updated session ${sessionId} with ${collectedCount} collected messages`);
  }


  /**
   * 转换收藏消息为知识条目
   * Requirements: 13.5, 13.6, 13.7, 13.10
   *
   * @param request 转换请求
   * @returns 创建的知识条目
   */
  async convertToKnowledge(request: ConvertToKnowledgeRequest): Promise<KnowledgeEntry> {
    const session = await this.chatSessionService.getById(request.sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${request.sessionId}`);
    }

    // 查找问题和回答消息
    const questionMessage = session.messages.find(m => m.id === request.questionMessageId);
    const answerMessage = session.messages.find(m => m.id === request.answerMessageId);

    if (!questionMessage) {
      throw new Error(`问题消息不存在: ${request.questionMessageId}`);
    }
    if (!answerMessage) {
      throw new Error(`回答消息不存在: ${request.answerMessageId}`);
    }

    // 自动生成标题（问题前50字符）
    const autoTitle = this.generateTitle(questionMessage.content);
    const title = request.title || autoTitle;

    // 组合问答为知识内容
    const autoContent = this.buildKnowledgeContent(
      questionMessage.content,
      answerMessage.content,
      answerMessage.citations
    );
    const content = request.content || autoContent;

    // 自动生成标签
    const autoTags = await this.suggestTags(questionMessage.content + ' ' + answerMessage.content);
    const tags = request.tags && request.tags.length > 0 ? request.tags : autoTags;

    // 确保知识库已初始化
    if (!this.knowledgeBase.isInitialized()) {
      await this.knowledgeBase.initialize();
    }

    // 创建知识条目
    const entry = await this.knowledgeBase.add({
      type: 'manual',
      title,
      content,
      metadata: {
        source: 'conversation_collector',
        timestamp: Date.now(),
        category: request.category || 'conversation',
        tags: ['from_conversation', ...tags],
        usageCount: 0,
        feedbackScore: 0,
        feedbackCount: 0,
        createdFromConversation: true,
        sourceSessionId: request.sessionId,
        sourceMessageIds: [request.questionMessageId, request.answerMessageId],
      },
    });

    logger.info(`Converted conversation to knowledge: ${entry.id}`, {
      sessionId: request.sessionId,
      questionMessageId: request.questionMessageId,
      answerMessageId: request.answerMessageId,
    });

    // 同步向量化存入 prompt_knowledge 集合 (J4.11)
    if (this.vectorClient) {
      try {
        await this.vectorClient.upsert('prompt_knowledge', [{
          id: entry.id,
          content,
          metadata: {
            category: 'experience',
            tags: ['from_conversation', ...tags],
            source: 'conversation',
            sourceSessionId: request.sessionId,
            timestamp: Date.now(),
          },
        }]);
        logger.info(`Synced knowledge to prompt_knowledge via Python Core: ${entry.id}`);
      } catch (err) {
        logger.warn('Failed to sync knowledge to prompt_knowledge via Python Core (non-fatal)', {
          entryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return entry;
  }

  /**
   * 批量转换收藏消息为知识条目
   * Requirements: 13.11
   *
   * @param requests 转换请求数组
   * @returns 创建的知识条目数组
   */
  async batchConvertToKnowledge(requests: ConvertToKnowledgeRequest[]): Promise<KnowledgeEntry[]> {
    const results: KnowledgeEntry[] = [];
    const errors: Array<{ request: ConvertToKnowledgeRequest; error: string }> = [];

    for (const request of requests) {
      try {
        const entry = await this.convertToKnowledge(request);
        results.push(entry);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ request, error: errorMessage });
        logger.error(`Failed to convert conversation to knowledge`, {
          sessionId: request.sessionId,
          error: errorMessage,
        });
      }
    }

    if (errors.length > 0) {
      logger.warn(`Batch conversion completed with ${errors.length} errors`, {
        total: requests.length,
        success: results.length,
        failed: errors.length,
      });
    }

    return results;
  }

  /**
   * 自动生成标签建议
   * Requirements: 13.9
   *
   * @param content 内容文本
   * @returns 建议的标签数组
   */
  async suggestTags(content: string): Promise<string[]> {
    const tags: Set<string> = new Set();
    const lowerContent = content.toLowerCase();

    // 检测设备命令关键词
    for (const keyword of DEVICE_COMMAND_KEYWORDS) {
      if (lowerContent.includes(keyword)) {
        tags.add(`device-${keyword}`);
      }
    }

    // 检测网络术语
    for (const term of NETWORK_TERMS) {
      if (lowerContent.includes(term)) {
        tags.add(term);
      }
    }

    // 检测代码块中的设备命令
    const codeBlockRegex = /```(?:routeros|rsc)?\s*([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(content)) !== null) {
      const codeContent = match[1].toLowerCase();
      
      // 检测常见的设备命令前缀
      const commandPrefixes = ['/ip', '/interface', '/system', '/routing', '/tool', '/queue', '/firewall'];
      for (const prefix of commandPrefixes) {
        if (codeContent.includes(prefix)) {
          const tag = prefix.replace('/', '').replace(' ', '-');
          tags.add(tag);
        }
      }
    }

    // 限制标签数量
    const tagArray = Array.from(tags).slice(0, 10);

    return tagArray;
  }

  /**
   * 导出收藏消息为 Markdown
   * Requirements: 14.6
   *
   * @param sessionId 会话 ID
   * @returns Markdown 格式的收藏内容
   */
  async exportAsMarkdown(sessionId: string): Promise<string> {
    const session = await this.chatSessionService.getById(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const collectedPairs = await this.getCollectedMessages(sessionId);
    
    if (collectedPairs.length === 0) {
      return `# ${session.title}\n\n*没有收藏的消息*`;
    }

    const lines: string[] = [];

    // 标题
    lines.push(`# ${session.title} - 收藏的问答`);
    lines.push('');
    lines.push(`**导出时间**: ${new Date().toLocaleString()}`);
    lines.push(`**收藏数量**: ${collectedPairs.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // 问答对
    for (let i = 0; i < collectedPairs.length; i++) {
      const pair = collectedPairs[i];
      
      lines.push(`## ${i + 1}. ${this.generateTitle(pair.question.content)}`);
      lines.push('');
      lines.push(`**收藏时间**: ${pair.collectedAt.toLocaleString()}`);
      lines.push('');
      
      // 问题
      lines.push('### 问题');
      lines.push('');
      lines.push(pair.question.content);
      lines.push('');
      
      // 回答
      lines.push('### 回答');
      lines.push('');
      lines.push(pair.answer.content);
      lines.push('');

      // 引用信息
      if (pair.answer.citations && pair.answer.citations.length > 0) {
        lines.push('### 知识引用');
        lines.push('');
        for (const citation of pair.answer.citations) {
          lines.push(`- **${citation.title}** (相关度: ${(citation.score * 100).toFixed(1)}%)`);
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 生成标题（问题前50字符）
   * Requirements: 13.6
   */
  private generateTitle(question: string): string {
    const cleaned = question.trim().replace(/\n/g, ' ');
    if (cleaned.length <= 50) {
      return cleaned;
    }
    return cleaned.substring(0, 50) + '...';
  }

  /**
   * 构建知识内容
   * Requirements: 13.7
   */
  private buildKnowledgeContent(
    question: string,
    answer: string,
    citations?: RAGCitation[]
  ): string {
    let content = `## 问题\n\n${question}\n\n## 解答\n\n${answer}`;

    if (citations && citations.length > 0) {
      content += '\n\n## 参考来源\n\n';
      for (const citation of citations) {
        content += `- **${citation.title}** (相关度: ${(citation.score * 100).toFixed(1)}%)\n`;
        content += `  ${citation.content.substring(0, 200)}${citation.content.length > 200 ? '...' : ''}\n\n`;
      }
    }

    return content;
  }
}

/**
 * 默认 ConversationCollector 单例实例
 */
export const conversationCollector = new ConversationCollector();

export default conversationCollector;
