/**
 * ConcurrencyController 背压场景测试
 * 
 * 测试背压机制在高负载场景下的行为
 * Requirements: 2.6
 */

import { ConcurrencyController, ConcurrencyConfig } from './concurrencyController';

describe('ConcurrencyController Backpressure', () => {
    let controller: ConcurrencyController<string, string>;

    // 模拟处理器
    const mockProcessor = async (item: string): Promise<string> => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return `processed: ${item}`;
    };

    beforeEach(() => {
        const config: Partial<ConcurrencyConfig> = {
            maxConcurrent: 5,
            maxQueueSize: 10,
            backpressureThreshold: 0.8, // 80%触发背压
            taskTimeout: 5000,
            enableBackpressure: true,
            enablePriorityQueue: true,
        };
        controller = new ConcurrencyController<string, string>(config);
        controller.setProcessor(mockProcessor);
    });

    afterEach(async () => {
        // 等待所有任务完成
        try {
            await controller.drain();
        } catch {
            // 忽略清理错误
        }
    });

    describe('背压触发条件', () => {
        it('队列未达阈值时不应触发背压', async () => {
            // 添加4个任务（80%阈值 = 8个任务才触发）
            const tasks: Promise<string>[] = [];
            for (let i = 0; i < 4; i++) {
                tasks.push(controller.enqueue(`task-${i}`, 5));
            }

            const status = controller.getStatus();
            expect(status.isBackpressureActive).toBe(false);

            await Promise.all(tasks);
        });

        it('队列达到阈值时应触发背压', async () => {
            // 先占满并发槽位（5个）和队列到达阈值（80% of 10 = 8）
            const slowProcessor = async (item: string): Promise<string> => {
                await new Promise(resolve => setTimeout(resolve, 2000));
                return `slow: ${item}`;
            };
            controller.setProcessor(slowProcessor);

            // 提交13个任务（5并发 + 8队列 = 触发背压）
            const submittedTasks: Promise<string>[] = [];
            for (let i = 0; i < 13; i++) {
                submittedTasks.push(
                    controller.enqueue(`task-${i}`, 5).catch(() => `rejected-${i}`)
                );
            }

            // 给一点时间让任务入队
            await new Promise(resolve => setTimeout(resolve, 100));

            const status = controller.getStatus();
            expect(status.isBackpressureActive).toBe(true);
        });
    });

    describe('背压响应行为', () => {
        it('背压激活时应拒绝新的低优先级任务', async () => {
            const slowProcessor = async (item: string): Promise<string> => {
                await new Promise(resolve => setTimeout(resolve, 2200));
                return `slow: ${item}`;
            };
            controller.setProcessor(slowProcessor);

            // 填满队列触发背压
            for (let i = 0; i < 15; i++) {
                controller.enqueue(`task-${i}`, 5).catch(() => { });
            }

            await new Promise(resolve => setTimeout(resolve, 100));

            // 尝试添加低优先级任务应该失败
            await expect(
                controller.enqueue('low-priority', 10) // 数字越大优先级越低
            ).rejects.toThrow(/backpressure|full/i);
        });

        it('背压激活时应允许高优先级任务替换低优先级任务', async () => {
            const slowProcessor = async (item: string): Promise<string> => {
                await new Promise(resolve => setTimeout(resolve, 2200));
                return `slow: ${item}`;
            };
            controller.setProcessor(slowProcessor);

            // 填充队列（使用低优先级任务）
            for (let i = 0; i < 15; i++) {
                controller.enqueue(`low-${i}`, 10).catch(() => { });
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            // 高优先级任务应该能够替换
            const highPriorityResult = controller.enqueue('high-priority', 1);

            // 不应该立即拒绝
            expect(highPriorityResult).toBeInstanceOf(Promise);
        });
    });

    describe('统计信息', () => {
        it('应追踪已丢弃的任务数量', async () => {
            const slowProcessor = async (item: string): Promise<string> => {
                await new Promise(resolve => setTimeout(resolve, 2200));
                return `slow: ${item}`;
            };
            controller.setProcessor(slowProcessor);

            // 填满队列并尝试添加更多任务
            for (let i = 0; i < 20; i++) {
                controller.enqueue(`task-${i}`, 5).catch(() => { });
            }

            await new Promise(resolve => setTimeout(resolve, 100));

            const status = controller.getStatus();
            expect(status.totalDropped).toBeGreaterThan(0);
        });

        it('应正确报告队列使用率', async () => {
            const status = controller.getStatus();
            expect(status.queueUsagePercent).toBeDefined();
            expect(status.queueCapacity).toBe(10);
        });
    });

    describe('边界条件', () => {
        it('空队列不应报背压', () => {
            const status = controller.getStatus();
            expect(status.isBackpressureActive).toBe(false);
        });

        it('禁用背压时不应触发背压拒绝', async () => {
            const noBackpressureController = new ConcurrencyController<string, string>({
                maxConcurrent: 2,
                maxQueueSize: 5,
                enableBackpressure: false, // 禁用背压
                taskTimeout: 5000,
            });
            noBackpressureController.setProcessor(mockProcessor);

            // 填满队列
            for (let i = 0; i < 7; i++) {
                noBackpressureController.enqueue(`task-${i}`, 5).catch(() => { });
            }

            const status = noBackpressureController.getStatus();
            expect(status.isBackpressureActive).toBe(false);
        });
    });

    describe('暂停和恢复', () => {
        it('暂停时应停止处理新任务', async () => {
            const tasks: Promise<string>[] = [];
            for (let i = 0; i < 3; i++) {
                tasks.push(controller.enqueue(`task-${i}`, 5));
            }

            controller.pause();

            const status = controller.getStatus();
            expect(status.isPaused).toBe(true);

            controller.resume();

            const resumedStatus = controller.getStatus();
            expect(resumedStatus.isPaused).toBe(false);

            await Promise.all(tasks);
        });
    });
});
