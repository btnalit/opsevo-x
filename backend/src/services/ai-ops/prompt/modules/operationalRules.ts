/**
 * OperationalRules 模块 - 运维操作规则
 *
 * 注入从系统反思中学习到的操作规则（约束、最佳实践、修正），
 * 指导 AI 在生成方案时遵守这些规则。
 *
 * @see Requirements Phase 2 - Inject learned rules into execution engine
 */

import { PromptModule } from '../types';

export const operationalRules: PromptModule = {
    name: 'OperationalRules',
    tokenBudget: 300,
    dependencies: [],
    templateName: '[模块化] OperationalRules - 运维规则',
    render(): string {
        return `{{operationalRules}}`;
    },
};
