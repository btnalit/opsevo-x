/**
 * Prompt 模块化系统入口
 *
 * 提供 PromptComposerAdapter 的工厂方法，包含初始化失败时的回退机制。
 * 当模块化 Prompt 系统初始化失败时，回退到使用原始单体模板的适配器。
 *
 * @see Requirements 6.4 - PromptComposer 初始化失败时回退到原始单体模板
 */

import { PromptComposer } from './promptComposer';
import { PromptComposerAdapter, TemplateServiceLike } from './promptComposerAdapter';
import type { VectorStoreClient } from '../rag/vectorStoreClient';
import type { DeviceDriverManager } from '../../device/deviceDriverManager';
import { basePersona } from './modules/basePersona';
import { reActFormat } from './modules/reActFormat';
import { apiSafety } from './modules/apiSafety';
import { batchProtocol } from './modules/batchProtocol';
import { knowledgeGuide } from './modules/knowledgeGuide';
import { deviceInfo } from './modules/deviceInfo';
import { parallelFormat } from './modules/parallelFormat';
import { logger } from '../../../utils/logger';

/**
 * 创建 PromptComposerAdapter 实例
 *
 * 工厂方法，尝试使用所有模块初始化 PromptComposer 和适配器。
 * 如果初始化失败，回退到使用空模块列表的 PromptComposer，
 * 此时各 build 方法内部的 try/catch 会进一步回退到原始模板。
 *
 * @param templateService - 可选的模板服务，用于自定义模板优先逻辑
 * @param options - 可选的依赖注入选项（vectorClient, deviceDriverManager）
 * @returns PromptComposerAdapter 实例
 *
 * @see Requirements 6.4 - 初始化失败时回退到原始单体模板
 * @see Requirements F1.3 - 向量检索 Top-K Prompt 片段
 * @see Requirements F1.4 - 注入设备 CapabilityManifest
 */
export function createPromptComposerAdapter(
  templateService?: TemplateServiceLike,
  options?: {
    vectorClient?: VectorStoreClient;
    deviceDriverManager?: DeviceDriverManager;
  }
): PromptComposerAdapter {
  try {
    // 尝试使用所有模块创建 PromptComposer
    const allModules = [
      basePersona,
      deviceInfo,
      reActFormat,
      apiSafety,
      batchProtocol,
      knowledgeGuide,
      parallelFormat,
    ];

    // 验证所有模块可以正常 render（提前检测问题）
    for (const mod of allModules) {
      mod.render();
    }

    const composer = new PromptComposer(allModules);
    return new PromptComposerAdapter(composer, templateService, options);
  } catch (error) {
    logger.error('PromptComposer initialization failed, creating adapter with fallback support', { error });

    // 回退：创建一个空模块列表的 PromptComposer
    // 各 build 方法内部的 try/catch 会回退到原始模板
    const fallbackComposer = new PromptComposer([]);
    return new PromptComposerAdapter(fallbackComposer, templateService, options);
  }
}

// 导出核心类型和类
export { PromptComposerAdapter } from './promptComposerAdapter';
export type { TemplateServiceLike } from './promptComposerAdapter';
export { PromptComposer } from './promptComposer';
export type { PromptModule, DynamicContext, ComposeOptions } from './types';

// Prompt 知识库种子数据加载器 (F1.1, F1.2)
export { seedPromptKnowledge } from './promptKnowledgeSeeder';
export type { PromptCategory, PromptKnowledgeSeedEntry, SeedStats } from './promptKnowledgeSeeder';
