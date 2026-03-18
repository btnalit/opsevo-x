/**
 * 拓扑发现模块导出
 */

export { topologyDiscoveryService } from './topologyDiscoveryService';
export { normalizeMac } from './macNormalizer';
export { generateEdgeId, calculateEdgeConfidence } from './edgeUtils';
export { computeDiff, applyDiff, isDiffEmpty } from './diffEngine';
export { serializeGraph, deserializeGraph } from './graphSerializer';
export { Semaphore } from './semaphore';
export { SlidingWindow, DampeningTimer } from './dampeningEngine';
export { onEntitySeen, onEntityMissed, getConfirmThreshold, getStaleThreshold } from './stateMachine';
export { buildCandidateGraph } from './candidateGraphBuilder';
export { collectDeviceData, collectAllDevicesData } from './dataCollector';
export { toKnowledgeGraphFormat } from './kgbAdapter';
export * from './types';
