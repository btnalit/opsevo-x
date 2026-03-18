/**
 * Tests for PromptKnowledgeSeeder
 *
 * Validates that:
 * - Seed entries are loaded from the JSON file and upserted via VectorStoreClient
 * - Each entry has required metadata fields (category, deviceTypes, version, feedbackScore)
 * - RouterOS hardcoded references are stripped from seed data
 * - Duplicate entries are skipped (idempotent)
 *
 * @see Requirements F1.1, F1.2
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { seedPromptKnowledge, PromptKnowledgeSeedEntry } from './promptKnowledgeSeeder';
import { VectorStoreClient, VectorDocument } from '../rag/vectorStoreClient';

// ── Seed file validation ──────────────────────────────────────────────────

describe('prompt-knowledge.json seed file', () => {
  let entries: PromptKnowledgeSeedEntry[];

  beforeAll(async () => {
    const seedPath = path.resolve(
      __dirname,
      '../../../../data/ai-ops/knowledge-seed/prompt-knowledge.json',
    );
    const raw = await fs.readFile(seedPath, 'utf-8');
    const seedFile = JSON.parse(raw);
    entries = seedFile.entries;
  });

  it('should contain at least 7 entries (one per legacy template)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(7);
  });

  it('each entry should have required fields', () => {
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.text).toBeTruthy();
      expect(['system_prompt', 'operation_rule', 'experience', 'pattern']).toContain(entry.category);
      expect(Array.isArray(entry.deviceTypes)).toBe(true);
      expect(typeof entry.version).toBe('number');
      expect(entry.feedbackScore).toBeGreaterThanOrEqual(0);
      expect(entry.feedbackScore).toBeLessThanOrEqual(1);
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });

  it('no entry text should contain hardcoded RouterOS references', () => {
    const forbidden = ['MikroTik RouterOS', 'RouterOS API', 'RouterOS 7.x', 'node-routeros'];
    for (const entry of entries) {
      for (const term of forbidden) {
        expect(entry.text).not.toContain(term);
      }
    }
  });

  it('generalized entries should use {{device_type}} placeholder', () => {
    const deviceTypeEntries = entries.filter(e =>
      e.category === 'system_prompt' || e.text.includes('设备'),
    );
    for (const entry of deviceTypeEntries) {
      expect(entry.text).toContain('{{device_type}}');
    }
  });
});

// ── seedPromptKnowledge function ──────────────────────────────────────────

describe('seedPromptKnowledge', () => {
  let mockVectorClient: jest.Mocked<VectorStoreClient>;
  let upsertedDocs: Array<{ collection: string; docs: VectorDocument[] }>;

  beforeEach(() => {
    upsertedDocs = [];
    mockVectorClient = {
      search: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockImplementation(async (collection, docs) => {
        upsertedDocs.push({ collection, docs });
        return docs.map((d: VectorDocument) => d.id ?? 'generated-id');
      }),
      delete: jest.fn(),
      embed: jest.fn(),
      healthCheck: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<VectorStoreClient>;
  });

  it('should load all seed entries and upsert to prompt_knowledge collection', async () => {
    const stats = await seedPromptKnowledge(mockVectorClient);

    expect(stats.loaded).toBeGreaterThanOrEqual(7);
    expect(stats.skipped).toBe(0);
    expect(stats.failed).toBe(0);

    // All upserts should target prompt_knowledge collection
    for (const call of upsertedDocs) {
      expect(call.collection).toBe('prompt_knowledge');
    }
  });

  it('each upserted document should have correct metadata structure', async () => {
    await seedPromptKnowledge(mockVectorClient);

    for (const call of upsertedDocs) {
      for (const doc of call.docs) {
        expect(doc.id).toBeTruthy();
        expect(doc.content).toBeTruthy();
        expect(doc.metadata).toBeDefined();
        expect(doc.metadata!.category).toBeTruthy();
        expect(doc.metadata!.deviceTypes).toBeDefined();
        expect(typeof doc.metadata!.version).toBe('number');
        expect(typeof doc.metadata!.feedbackScore).toBe('number');
        expect(doc.metadata!.source).toBe('seed-data');
      }
    }
  });

  it('should skip entries that already exist (idempotent)', async () => {
    // First call: search returns empty → all loaded
    const stats1 = await seedPromptKnowledge(mockVectorClient);
    expect(stats1.loaded).toBeGreaterThanOrEqual(7);

    // Second call: search returns matching entries → all skipped
    mockVectorClient.search.mockImplementation(async (_col, query) => {
      const filterId = query.filter?.id as string | undefined;
      if (filterId) {
        return [{ id: filterId, text: 'existing', score: 1.0, metadata: { id: filterId } }];
      }
      return [];
    });

    const stats2 = await seedPromptKnowledge(mockVectorClient);
    expect(stats2.skipped).toBeGreaterThanOrEqual(7);
    expect(stats2.loaded).toBe(0);
  });

  it('should handle upsert failures gracefully', async () => {
    mockVectorClient.upsert.mockRejectedValue(new Error('Python Core unavailable'));

    const stats = await seedPromptKnowledge(mockVectorClient);
    expect(stats.failed).toBeGreaterThanOrEqual(7);
    expect(stats.loaded).toBe(0);
  });
});
