
import { RemediationPlan, RemediationStep } from '../../types/ai-ops';
import { logger } from '../../utils/logger';
import { createPromptComposerAdapter } from './prompt';
import { AIAnalyzer } from './aiAnalyzer';
import { serviceRegistry } from '../serviceRegistry';
import { SERVICE_NAMES } from '../bootstrap';
import { deviceDriverManager } from '../device/deviceDriverManager';
import type { CapabilityManifest } from '../../types/device-driver';

/**
 * ScriptSynthesizer
 *
 * Responsible for synthesizing a cohesive device script from a sequence of
 * successful ReAct remediation steps.
 *
 * Device-agnostic design: generates scripts based on the target device type
 * by querying the device's CapabilityManifest. Actual command syntax is
 * determined by the device driver, not hardcoded here.
 *
 * Requirements: A7.29
 */
export class ScriptSynthesizer {
    private aiAnalyzer: AIAnalyzer | null = null;

    async initialize(): Promise<void> {
        logger.info('ScriptSynthesizer initialized');
    }

    private async getAIAnalyzer(): Promise<AIAnalyzer> {
        if (!this.aiAnalyzer) {
            this.aiAnalyzer = await serviceRegistry.get<AIAnalyzer>(SERVICE_NAMES.AI_ANALYZER);
        }
        return this.aiAnalyzer;
    }

    /**
     * Resolve the target device type and vendor info from the plan's deviceId.
     * Returns a description string for the AI prompt.
     */
    private getDeviceContext(plan: RemediationPlan): { vendor: string; deviceType: string; scriptHint: string } {
        const defaultContext = {
            vendor: 'generic',
            deviceType: 'network device',
            scriptHint: 'Use standard CLI syntax appropriate for the device type.',
        };

        if (!plan.deviceId) {
            return defaultContext;
        }

        const manifest: CapabilityManifest | null = deviceDriverManager.getDriver(plan.deviceId)
            ?.getCapabilityManifest() ?? null;

        if (!manifest) {
            return defaultContext;
        }

        return {
            vendor: manifest.vendor || 'generic',
            deviceType: manifest.model || manifest.vendor || 'network device',
            scriptHint: `Generate script in ${manifest.vendor} CLI syntax${manifest.firmwareVersion ? ` (firmware ${manifest.firmwareVersion})` : ''}.`,
        };
    }

    /**
     * Synthesize a device script from a remediation plan
     *
     * The script format is determined dynamically based on the target device type
     * via CapabilityManifest. No vendor-specific syntax is hardcoded.
     *
     * @param plan The successful remediation plan
     * @returns The synthesized script content
     */
    async synthesizeScript(plan: RemediationPlan): Promise<string> {
        try {
            logger.info(`Synthesizing script for plan ${plan.id}`);

            // Filter only steps that have commands and were successful
            const stepsToSynthesize = plan.steps.filter(step => step.command && step.command.trim().length > 0);

            if (stepsToSynthesize.length === 0) {
                logger.warn('No commands found in plan to synthesize');
                return '';
            }

            // Resolve target device context for script generation
            const deviceCtx = this.getDeviceContext(plan);

            const stepDescriptions = stepsToSynthesize.map(step =>
                `- Step ${step.order}: ${step.description}\n  Operation: \`${step.command}\``
            ).join('\n');

            const prompt = `
You are an expert network device script developer.
Target device type: ${deviceCtx.deviceType} (vendor: ${deviceCtx.vendor})
${deviceCtx.scriptHint}

Your task is to convert a sequence of separate operation intents into a single, cohesive, robust device script.

Input Steps:
${stepDescriptions}

Requirements:
1. Combine the steps into a single script block using the correct syntax for the target device.
2. Add comments explaining each section.
3. Use variables where appropriate to avoid repetition (e.g., interface names).
4. Add basic error handling if possible (e.g., check if interface exists before disabling).
5. Ensure the script is idempotent if possible.
6. Return ONLY the script content in valid device CLI syntax. Do not include Markdown code blocks. Just the raw code.
      `;

            const { getAdapterPool, apiConfigService, cryptoService } = await import('../ai');

            const defaultConfig = await apiConfigService.getDefault();
            if (!defaultConfig) {
                throw new Error('No default AI provider configured');
            }

            const pool = getAdapterPool();
            const apiKey = cryptoService.decrypt(defaultConfig.apiKey);
            const adapterKey = {
                provider: defaultConfig.provider,
                endpoint: defaultConfig.endpoint
            };

            const adapter = pool.getAdapter(adapterKey, apiKey);

            const response = await adapter.chat({
                provider: defaultConfig.provider,
                model: defaultConfig.model,
                messages: [
                    { role: 'system', content: `You are a network device script assistant for ${deviceCtx.vendor} ${deviceCtx.deviceType} devices.` },
                    { role: 'user', content: prompt }
                ],
                stream: false
            });

            let script = response.content.trim();

            // Clean up markdown code blocks if the LLM ignored instructions
            script = script.replace(/^```\w*\s*/, '').replace(/```$/, '');

            return script.trim();

        } catch (error) {
            logger.error('Failed to synthesize script:', error);
            throw error;
        }
    }
}

export const scriptSynthesizer = new ScriptSynthesizer();
