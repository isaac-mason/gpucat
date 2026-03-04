/**
 * Tests for src/nodes/pass-node.ts
 *
 * Covers:
 *  1. pass() factory creates a PassNode with correct scene/camera refs
 *  2. PassNode has stable passId, unique across instances
 *  3. getTextureNode() returns a Node<'vec4f'>
 *  4. getViewZNode() returns a Node<'f32'> with depthTex + sampler deps
 *  5. getLinearDepthNode() returns a Node<'f32'> with depthTex + sampler deps
 *  6. collectPassNodes — finds PassNode reachable via getTextureNode()
 *  7. collectPassNodes — finds PassNode nested inside a binop chain
 *  8. collectPassNodes — deduplicates — same PassNode referenced twice
 *  9. collectPassNodes — returns empty array for a graph with no PassNodes
 * 10. RenderPipeline.outputNode defaults to null
 * 11. PassColorTextureNode kind is 'raw' and type is 'vec4f'
 * 12. _getResourceNodes returns colorTexNode, samplerNode, depthTexNode
 */

import { describe, expect, test } from 'vitest';
import { pass, PassNode, collectPassNodes, PassColorTextureNode } from '../src/nodes/pass-node.js';
import { RenderPipeline } from '../src/renderer/render-pipeline.js';
import { Scene } from '../src/scene/scene.js';
import { PerspectiveCamera } from '../src/scene/camera.js';
import { vec4f } from '../src/nodes/nodes.js';
import type { Node, WgslType } from '../src/nodes/nodes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSceneCamera() {
    const scene = new Scene();
    const camera = new PerspectiveCamera(Math.PI / 4, 1, 0.1, 100);
    return { scene, camera };
}

// ---------------------------------------------------------------------------
// 1. pass() factory
// ---------------------------------------------------------------------------

describe('pass() factory', () => {
    test('returns a PassNode', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        expect(p).toBeInstanceOf(PassNode);
    });

    test('PassNode holds correct scene and camera refs', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        expect(p.scene).toBe(scene);
        expect(p.camera).toBe(camera);
    });

    test('PassNode has kind "raw" and type "vec4f"', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        expect(p.kind).toBe('raw');
        expect(p.type).toBe('vec4f');
    });
});

// ---------------------------------------------------------------------------
// 2. Unique passId
// ---------------------------------------------------------------------------

describe('passId uniqueness', () => {
    test('two PassNodes have different passIds', () => {
        const { scene, camera } = makeSceneCamera();
        const a = pass(scene, camera);
        const b = pass(scene, camera);
        expect(a.passId).not.toBe(b.passId);
    });

    test('passId is a non-empty string', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        expect(typeof p.passId).toBe('string');
        expect(p.passId.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// 3. getTextureNode()
// ---------------------------------------------------------------------------

describe('getTextureNode()', () => {
    test('returns a Node<"vec4f">', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const n = p.getTextureNode();
        expect(n.type).toBe('vec4f');
    });

    test('returns a PassColorTextureNode', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const n = p.getTextureNode();
        expect(n).toBeInstanceOf(PassColorTextureNode);
    });

    test('PassColorTextureNode.passNode points back to the PassNode', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const n = p.getTextureNode() as PassColorTextureNode;
        expect(n.passNode).toBe(p);
    });

    test('returns same instance on repeated calls (stable)', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        expect(p.getTextureNode()).toBe(p.getTextureNode());
    });
});

// ---------------------------------------------------------------------------
// 4. getViewZNode()
// ---------------------------------------------------------------------------

describe('getViewZNode()', () => {
    test('returns a Node<"f32">', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getViewZNode();
        expect(n.type).toBe('f32');
    });

    test('has kind "raw"', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getViewZNode();
        expect(n.kind).toBe('raw');
    });

    test('embeds camera near/far literals in wgsl', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getViewZNode() as { wgsl: string };
        expect(n.wgsl).toContain('0.1');
        expect(n.wgsl).toContain('100');
    });

    test('has two deps (depthTexNode, samplerNode)', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getViewZNode() as { deps: Node<WgslType>[] };
        expect(n.deps).toHaveLength(2);
        expect(n.deps[0].kind).toBe('texture');
        expect(n.deps[1].kind).toBe('sampler');
    });
});

// ---------------------------------------------------------------------------
// 5. getLinearDepthNode()
// ---------------------------------------------------------------------------

describe('getLinearDepthNode()', () => {
    test('returns a Node<"f32">', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getLinearDepthNode();
        expect(n.type).toBe('f32');
    });

    test('has two deps (depthTexNode, samplerNode)', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getLinearDepthNode() as { deps: Node<WgslType>[] };
        expect(n.deps).toHaveLength(2);
        expect(n.deps[0].kind).toBe('texture');
        expect(n.deps[1].kind).toBe('sampler');
    });
});

// ---------------------------------------------------------------------------
// 6. collectPassNodes — direct
// ---------------------------------------------------------------------------

describe('collectPassNodes — direct', () => {
    test('finds a PassNode reachable via getTextureNode()', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const root = p.getTextureNode();
        const found = collectPassNodes(root);
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(p);
    });

    test('finds a PassNode when root IS the PassNode', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const found = collectPassNodes(p);
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(p);
    });
});

// ---------------------------------------------------------------------------
// 7. collectPassNodes — nested in binop chain
// ---------------------------------------------------------------------------

describe('collectPassNodes — nested', () => {
    test('finds PassNode nested inside add()', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const tex = p.getTextureNode();
        // tex.add(tex) — a BinopNode wrapping two refs to the same PassColorTextureNode
        const root = tex.add(tex);
        const found = collectPassNodes(root);
        expect(found).toHaveLength(1);
        expect(found[0]).toBe(p);
    });

    test('finds two distinct PassNodes in a combined graph', () => {
        const { scene, camera } = makeSceneCamera();
        const p1 = pass(scene, camera);
        const p2 = pass(scene, camera);
        const root = p1.getTextureNode().add(p2.getTextureNode());
        const found = collectPassNodes(root);
        expect(found).toHaveLength(2);
        expect(found).toContain(p1);
        expect(found).toContain(p2);
    });
});

// ---------------------------------------------------------------------------
// 8. collectPassNodes — deduplication
// ---------------------------------------------------------------------------

describe('collectPassNodes — deduplication', () => {
    test('same PassNode referenced twice is returned once', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const tex = p.getTextureNode();
        const root = tex.add(tex);
        const found = collectPassNodes(root);
        expect(found).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// 9. collectPassNodes — no PassNodes
// ---------------------------------------------------------------------------

describe('collectPassNodes — no pass nodes', () => {
    test('returns empty array for a plain constant node', () => {
        const root = vec4f(1, 0, 0, 1);
        const found = collectPassNodes(root);
        expect(found).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// 10. RenderPipeline.outputNode defaults to null
// ---------------------------------------------------------------------------

describe('RenderPipeline', () => {
    test('outputNode is null by default', () => {
        const pipeline = new RenderPipeline();
        expect(pipeline.outputNode).toBeNull();
    });

    test('outputNode can be set to a PassColorTextureNode', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const pipeline = new RenderPipeline();
        pipeline.outputNode = p.getTextureNode();
        expect(pipeline.outputNode).toBe(p.getTextureNode());
    });
});

// ---------------------------------------------------------------------------
// 11. PassColorTextureNode kind + type
// ---------------------------------------------------------------------------

describe('PassColorTextureNode', () => {
    test('kind is "raw"', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getTextureNode();
        expect(n.kind).toBe('raw');
    });

    test('type is "vec4f"', () => {
        const { scene, camera } = makeSceneCamera();
        const n = pass(scene, camera).getTextureNode();
        expect(n.type).toBe('vec4f');
    });
});

// ---------------------------------------------------------------------------
// 12. _getResourceNodes
// ---------------------------------------------------------------------------

describe('_getResourceNodes()', () => {
    test('returns colorTexNode with kind "texture"', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const { colorTexNode } = p._getResourceNodes();
        expect(colorTexNode.kind).toBe('texture');
    });

    test('returns samplerNode with kind "sampler"', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const { samplerNode } = p._getResourceNodes();
        expect(samplerNode.kind).toBe('sampler');
    });

    test('returns depthTexNode with kind "texture"', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const { depthTexNode } = p._getResourceNodes();
        expect(depthTexNode.kind).toBe('texture');
    });

    test('colorTexNode textureId contains passId', () => {
        const { scene, camera } = makeSceneCamera();
        const p = pass(scene, camera);
        const { colorTexNode } = p._getResourceNodes();
        expect(colorTexNode.textureId).toContain(p.passId);
    });
});
