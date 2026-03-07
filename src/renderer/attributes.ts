/**
 * attributes.ts — High-level attribute management with deduplication.
 *
 * Aligned with Three.js Attributes class:
 * - Version-based change detection
 * - Per-frame deduplication (each attribute updated at most once per frame)
 * - Tracks update calls to prevent redundant GPU uploads
 *
 * This wraps the lower-level buffers.ts functions with deduplication logic.
 */

import type { BufferAttribute, IndexAttribute, IndirectStorageBufferAttribute } from '../core/attribute';
import type { StorageNode, WgslType } from '../nodes/nodes';
import * as buffers from './buffers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Attribute type for routing to correct buffer upload function.
 */
export type AttributeType = 'vertex' | 'index' | 'storage' | 'indirect';

/**
 * Per-attribute tracking data stored in the WeakMap.
 */
export type AttributeData = {
    /** The GPU buffer for this attribute. */
    buffer: GPUBuffer;
    /** The version of the attribute data when last uploaded. */
    version: number;
};

/**
 * Attributes state - manages attribute GPU buffers with deduplication.
 */
export type AttributesState = {
    /** Reference to the underlying buffer cache. */
    bufferCache: buffers.BufferCache;

    /** GPU device reference. */
    device: GPUDevice;

    /**
     * Tracks the last render call ID when each attribute was updated.
     * Prevents duplicate updates within the same frame.
     */
    attributeCall: WeakMap<BufferAttribute | IndexAttribute | IndirectStorageBufferAttribute, number>;

    /**
     * Current render call ID. Incremented at the start of each render call.
     * Used for deduplication.
     */
    currentCallId: number;

    /**
     * Per-attribute metadata (version tracking).
     * This duplicates some info from bufferCache but provides the Three.js aligned API.
     */
    data: WeakMap<BufferAttribute | IndexAttribute, AttributeData>;

    /**
     * Memory statistics tracking.
     */
    memory: {
        attributes: number;
        indexAttributes: number;
        storageAttributes: number;
        indirectAttributes: number;
    };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new Attributes state.
 *
 * @param bufferCache - The underlying buffer cache (from buffers.ts)
 */
export function createAttributesState(bufferCache: buffers.BufferCache): AttributesState {
    return {
        bufferCache,
        device: bufferCache.device,
        attributeCall: new WeakMap(),
        currentCallId: 0,
        data: new WeakMap(),
        memory: {
            attributes: 0,
            indexAttributes: 0,
            storageAttributes: 0,
            indirectAttributes: 0,
        },
    };
}

// ---------------------------------------------------------------------------
// Call ID Management
// ---------------------------------------------------------------------------

/**
 * Increment the call ID at the start of each render call.
 * This enables per-frame deduplication.
 */
export function incrementCallId(state: AttributesState): void {
    state.currentCallId++;
}

// ---------------------------------------------------------------------------
// Attribute Updates
// ---------------------------------------------------------------------------

/**
 * Update an attribute, uploading to GPU if needed.
 * Implements per-frame deduplication - each attribute is uploaded at most once per frame.
 *
 * Aligned with Three.js Attributes.update().
 *
 * @param state - The Attributes state
 * @param attribute - The attribute to update
 * @param type - The attribute type for routing
 */
export function updateAttribute(
    state: AttributesState,
    attribute: BufferAttribute,
    type: AttributeType,
): void {
    const callId = state.currentCallId;

    // Check if already updated this frame
    const lastCallId = state.attributeCall.get(attribute);
    if (lastCallId === callId) {
        return; // Already updated this frame
    }

    // Mark as updated for this frame
    state.attributeCall.set(attribute, callId);

    // Route to appropriate upload function
    switch (type) {
        case 'vertex':
            uploadVertexAttribute(state, attribute);
            break;
        case 'index':
            uploadIndexAttribute(state, attribute as unknown as IndexAttribute);
            break;
        case 'storage':
            // Storage attributes are handled separately through StorageNodes
            break;
        case 'indirect':
            uploadIndirectAttribute(state, attribute as unknown as IndirectStorageBufferAttribute);
            break;
    }
}

/**
 * Update a vertex attribute.
 */
function uploadVertexAttribute(state: AttributesState, attribute: BufferAttribute): void {
    const existingData = state.data.get(attribute);

    if (existingData === undefined) {
        // First time - upload and track
        const buffer = buffers.uploadVertex(state.bufferCache, attribute);
        state.data.set(attribute, { buffer, version: attribute.version });
        state.memory.attributes++;
    } else if (existingData.version < attribute.version) {
        // Version changed - re-upload
        buffers.uploadVertex(state.bufferCache, attribute);
        existingData.version = attribute.version;
    }
    // else: version unchanged, no upload needed
}

/**
 * Update an index attribute.
 */
function uploadIndexAttribute(state: AttributesState, attribute: IndexAttribute): void {
    const existingData = state.data.get(attribute);

    if (existingData === undefined) {
        // First time - upload and track
        const buffer = buffers.uploadIndex(state.bufferCache, attribute);
        state.data.set(attribute, { buffer, version: attribute.version });
        state.memory.indexAttributes++;
    } else if (existingData.version < attribute.version) {
        // Version changed - re-upload
        buffers.uploadIndex(state.bufferCache, attribute);
        existingData.version = attribute.version;
    }
}

/**
 * Update an indirect storage attribute.
 */
function uploadIndirectAttribute(state: AttributesState, attribute: IndirectStorageBufferAttribute): void {
    // Indirect attributes are uploaded through the buffer cache
    buffers.uploadIndirect(state.bufferCache, attribute);
    state.memory.indirectAttributes++;
}

// ---------------------------------------------------------------------------
// Storage Node Updates
// ---------------------------------------------------------------------------

/**
 * Update a storage node's buffer.
 * Storage nodes are keyed by the node itself, not by a BufferAttribute.
 *
 * @param state - The Attributes state
 * @param node - The storage node to update
 * @returns The GPU buffer
 */
export function updateStorageNode(
    state: AttributesState,
    node: StorageNode<WgslType>,
): GPUBuffer {
    return buffers.uploadStorage(state.bufferCache, node);
}

// ---------------------------------------------------------------------------
// Attribute Retrieval
// ---------------------------------------------------------------------------

/**
 * Get the GPU buffer for a vertex attribute.
 * Returns undefined if not uploaded yet.
 */
export function getVertexBuffer(
    state: AttributesState,
    attribute: BufferAttribute,
): GPUBuffer | undefined {
    return state.data.get(attribute)?.buffer;
}

/**
 * Get the GPU buffer for an index attribute.
 * Returns undefined if not uploaded yet.
 */
export function getIndexBuffer(
    state: AttributesState,
    attribute: IndexAttribute,
): GPUBuffer | undefined {
    return state.data.get(attribute)?.buffer;
}

/**
 * Get the GPU buffer for an indirect attribute.
 * Returns undefined if not uploaded yet.
 */
export function getIndirectBuffer(
    state: AttributesState,
    attribute: IndirectStorageBufferAttribute,
): GPUBuffer | undefined {
    return buffers.getIndirect(state.bufferCache, attribute);
}

// ---------------------------------------------------------------------------
// Attribute Deletion
// ---------------------------------------------------------------------------

/**
 * Delete an attribute from the cache.
 * Note: This doesn't destroy the GPU buffer - it just removes tracking.
 * GPU buffers are destroyed when the BufferAttribute is garbage collected (WeakMap).
 *
 * @param state - The Attributes state
 * @param attribute - The attribute to delete
 */
export function deleteAttribute(
    state: AttributesState,
    attribute: BufferAttribute | IndexAttribute,
): void {
    const data = state.data.get(attribute);
    if (data) {
        // Note: We don't destroy the buffer here because the WeakMap in bufferCache
        // will hold onto it. When the attribute is GC'd, both are released.
        state.data.delete(attribute);
    }
    state.attributeCall.delete(attribute);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * Get memory statistics.
 */
export function getAttributesStats(state: AttributesState): {
    attributes: number;
    indexAttributes: number;
    storageAttributes: number;
    indirectAttributes: number;
} {
    return { ...state.memory };
}
