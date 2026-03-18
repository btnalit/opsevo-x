import { UnifiedAgentService, UnifiedChatRequest } from '../services/ai/unifiedAgentService';
import { ChatSessionService } from '../services/ai/chatSessionService';
import { APIConfigService } from '../services/ai/apiConfigService';
import { ContextBuilderService } from '../services/ai/contextBuilderService';

// Mock dependencies
jest.mock('../services/ai/chatSessionService');
jest.mock('../services/ai/apiConfigService');
jest.mock('../services/ai/contextBuilderService');

describe('UnifiedAgentService Chat Flow', () => {
    let service: UnifiedAgentService;
    let mockChatSessionService: jest.Mocked<ChatSessionService>;
    let mockApiConfigService: jest.Mocked<APIConfigService>;
    let mockContextBuilderService: jest.Mocked<ContextBuilderService>;

    beforeEach(async () => {
        // Clear all mocks
        jest.clearAllMocks();

        // Setup mock implementations
        mockChatSessionService = new ChatSessionService() as any;
        mockApiConfigService = new APIConfigService(undefined as any) as any;
        mockContextBuilderService = new ContextBuilderService() as any;
        const mockScriptExecutorService = {} as any;

        // Initialize service with mocked dependencies
        // Pass {} as ragDependencies to enable DI mode and avoid dynamic imports
        service = new UnifiedAgentService(
            mockChatSessionService,
            mockContextBuilderService,
            mockScriptExecutorService,
            mockApiConfigService,
            {} as any
        );

        // Initialize the service
        await service.initialize();

        // Setup default mocks
        mockChatSessionService.getById.mockResolvedValue({
            id: 'test-session',
            messages: [],
            config: {},
            mode: 'standard', // default mode
            provider: 'openai',
            model: 'gpt-4',
            title: 'Test Session',
            createdAt: new Date(),
            updatedAt: new Date(),
            collectedCount: 0
        } as any);

        mockApiConfigService.getById.mockResolvedValue({
            id: 'test-config',
            provider: 'openai',
            model: 'gpt-4',
            apiKey: 'test-key',
            name: 'test-config',
            isDefault: true,
            createdAt: new Date(),
            updatedAt: new Date()
        } as any);

        mockApiConfigService.getDecryptedApiKey.mockResolvedValue('test-key');

        // Mock internal methods that might depend on complex logic/DB
        // We want to test the *flow control* (standard vs knowledge-enhanced), not the actual DB/LLM calls.
        service['handleStandardChatStream'] = jest.fn().mockResolvedValue(undefined);
        service['handleKnowledgeEnhancedChatStream'] = jest.fn().mockResolvedValue(undefined);
    });

    it('should route to handleStandardChatStream when mode is standard', async () => {
        const request: UnifiedChatRequest = {
            message: 'test message',
            mode: 'standard',
            configId: 'test-config',
            sessionId: 'test-session',
            deviceId: 'test-device',
            tenantId: 'test-tenant'
        };

        const onChunk = jest.fn();

        await service.chatStream(request, onChunk);

        expect(service['handleStandardChatStream']).toHaveBeenCalledWith(
            expect.objectContaining(request),
            'test-session',
            onChunk
        );
        expect(service['handleKnowledgeEnhancedChatStream']).not.toHaveBeenCalled();
    });

    it('should route to handleKnowledgeEnhancedChatStream when mode is knowledge-enhanced', async () => {
        const request: UnifiedChatRequest = {
            message: 'test message',
            mode: 'knowledge-enhanced',
            configId: 'test-config',
            sessionId: 'test-session',
            deviceId: 'test-device',
            tenantId: 'test-tenant'
        };

        const onChunk = jest.fn();

        await service.chatStream(request, onChunk);

        expect(service['handleKnowledgeEnhancedChatStream']).toHaveBeenCalledWith(
            expect.objectContaining(request),
            'test-session',
            onChunk,
            expect.anything() // selectedSkill
        );
        expect(service['handleStandardChatStream']).not.toHaveBeenCalled();
    });

    it('should default to standard if mode is missing (fallback)', async () => {
        const request = {
            message: 'test message',
            // mode is undefined
            configId: 'test-config',
            sessionId: 'test-session',
            deviceId: 'test-device',
            tenantId: 'test-tenant'
        } as any as UnifiedChatRequest;

        const onChunk = jest.fn();

        await service.chatStream(request, onChunk);

        expect(service['handleStandardChatStream']).toHaveBeenCalled();
    });
});
