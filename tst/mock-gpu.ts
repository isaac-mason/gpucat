/**
 * Mock GPU system for unit testing.
 *
 * Provides mock implementations of GPU resources with tracking for verifying
 * behavior in tests. Unlike stub-gpu (which provides minimal WebGPU API stubs),
 * this focuses on mocking gpucat's internal GPU interactions.
 */

import { vi } from 'vitest';

/**
 * Tracks disposal calls for testing lifecycle management.
 */
export type DisposalTracker = {
    /** Number of times _onDispose was called */
    disposeCount: number;
    /** Reset the tracker */
    reset(): void;
};

/**
 * Create a disposal tracker that can be attached to GpuBuffer._onDispose.
 */
export function createDisposalTracker(): DisposalTracker {
    const tracker: DisposalTracker = {
        disposeCount: 0,
        reset() {
            this.disposeCount = 0;
        },
    };
    return tracker;
}

/**
 * Create a mock _onDispose callback that tracks calls.
 */
export function createMockOnDispose(tracker: DisposalTracker): () => void {
    return vi.fn(() => {
        tracker.disposeCount++;
    });
}

/**
 * Attach a disposal tracker to a GpuBuffer.
 * Returns the tracker for assertions.
 */
export function trackDisposal<T extends { _onDispose: (() => void) | null }>(
    buffer: T
): DisposalTracker {
    const tracker = createDisposalTracker();
    buffer._onDispose = createMockOnDispose(tracker);
    return tracker;
}
