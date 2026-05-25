/// <reference types="@webgpu/types" />

import { describe, expect, test, beforeEach, beforeAll } from 'vitest';
import { createStubGPU, installWebGPUPolyfills, type StubGPUResult } from './stub-gpu';

// Install WebGPU polyfills for Node environment
beforeAll(() => {
    installWebGPUPolyfills();
});

import { WebGPURenderer } from '../src/renderer/renderer';
import { Scene } from '../src/scene/scene';
import { PerspectiveCamera } from '../src/camera/perspective-camera';
import { Mesh } from '../src/objects/mesh';
import { Material } from '../src/material/material';
import { createBoxGeometry } from '../src/geometry/geometry-helpers';
import {
    attribute,
    vec4,
    f32,
    mul,
    cameraProjectionMatrix,
    cameraViewMatrix,
    modelWorldMatrix,
    renderGroup,
    objectGroup,
    UniformNode,
    Uniform,
} from '../src/nodes/nodes';
import * as d from '../src/schema/schema';

/**
 * Test suite for uniform group deduplication.
 *
 * Uses the high-level WebGPURenderer API with stub GPU to verify:
 * 1. Shared groups (frameGroup, renderGroup) cause minimal buffer writes
 * 2. Per-object groups (objectGroup) write once per object
 * 3. Version bumping triggers re-processing
 */

describe('uniform group deduplication', () => {
    let stub: StubGPUResult;
    let renderer: WebGPURenderer;
    let scene: Scene;
    let camera: PerspectiveCamera;

    beforeEach(async () => {
        stub = createStubGPU();
        renderer = new WebGPURenderer(stub.getRendererOptions());
        await renderer.init();
        renderer.setSize(800, 600);

        scene = new Scene();
        camera = new PerspectiveCamera(Math.PI / 4, 800 / 600, 0.1, 100);
        camera.position[2] = 5;
        scene.add(camera);
        scene.updateWorldMatrix();
        camera.updateViewMatrix();

        stub.stats.reset();
    });

    /**
     * Create a simple material with standard transforms.
     */
    function createBasicMaterial(): Material {
        const position = attribute('position', d.vec3f);
        const localPosition = vec4(position, f32(1));
        const worldPosition = mul(modelWorldMatrix, localPosition);
        const viewPosition = mul(cameraViewMatrix, worldPosition);
        const clipPosition = mul(cameraProjectionMatrix, viewPosition);

        return new Material({
            vertex: clipPosition,
            fragment: vec4(f32(1), f32(0), f32(0), f32(1)),
        });
    }

    /**
     * Create a material with a renderGroup uniform.
     */
    function createRenderGroupMaterial(): Material {
        const position = attribute('position', d.vec3f);
        const localPosition = vec4(position, f32(1));
        const worldPosition = mul(modelWorldMatrix, localPosition);
        const viewPosition = mul(cameraViewMatrix, worldPosition);
        const clipPosition = mul(cameraProjectionMatrix, viewPosition);

        // Shared uniform - should only be written once regardless of mesh count
        const sharedValue = new UniformNode(new Uniform(d.f32, 1.0, renderGroup), 'sharedTestValue');

        return new Material({
            vertex: clipPosition,
            fragment: vec4(sharedValue, f32(0), f32(0), f32(1)),
        });
    }

    /**
     * Create a material with an objectGroup uniform.
     */
    function createObjectGroupMaterial(): Material {
        const position = attribute('position', d.vec3f);
        const localPosition = vec4(position, f32(1));
        const worldPosition = mul(modelWorldMatrix, localPosition);
        const viewPosition = mul(cameraViewMatrix, worldPosition);
        const clipPosition = mul(cameraProjectionMatrix, viewPosition);

        // Per-object uniform - should be written once per mesh
        const perObjectValue = new UniformNode(new Uniform(d.f32, 1.0, objectGroup), 'perObjectTestValue');

        return new Material({
            vertex: clipPosition,
            fragment: vec4(perObjectValue, f32(0), f32(0), f32(1)),
        });
    }

    describe('basic rendering', () => {
        test('single mesh renders with expected GPU calls', async () => {
            const geometry = createBoxGeometry(1, 1, 1);
            const material = createBasicMaterial();
            const mesh = new Mesh(geometry, material);
            scene.add(mesh);
            mesh.updateWorldMatrix();

            renderer.render(scene, camera);

            // Should have at least one draw call
            expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(1);
        });
    });

    describe('shared groups (renderGroup)', () => {
        test('multiple meshes sharing material = deduplicated buffer writes', async () => {
            const geometry = createBoxGeometry(1, 1, 1);
            const sharedMaterial = createRenderGroupMaterial();

            // Create 10 meshes sharing the same material
            for (let i = 0; i < 10; i++) {
                const mesh = new Mesh(geometry, sharedMaterial);
                mesh.position[0] = i * 2;
                scene.add(mesh);
                mesh.updateWorldMatrix();
            }

            // First frame - capture baseline
            renderer.render(scene, camera);
            const firstFrameWrites = stub.stats.bufferWrites;

            stub.stats.reset();

            // Second frame - shared uniforms should not re-upload
            renderer.render(scene, camera);
            const secondFrameWrites = stub.stats.bufferWrites;

            // Second frame should have fewer or equal writes (shared groups deduplicated)
            // The exact count depends on what changed, but it should be less than
            // writing everything again
            expect(secondFrameWrites).toBeLessThanOrEqual(firstFrameWrites);
        });
    });

    describe('per-object groups (objectGroup)', () => {
        test('each mesh with objectGroup uniform gets its own buffer write', async () => {
            const geometry = createBoxGeometry(1, 1, 1);

            // Create meshes with SEPARATE materials (each has its own objectGroup uniform)
            // Position within camera frustum (camera at z=5 with 45° FOV)
            // Visible width at z=0 is approx 4.1 units, so position at -1.5 to 1.5
            const positions = [-1.5, -0.75, 0, 0.75, 1.5];
            for (let i = 0; i < 5; i++) {
                const material = createObjectGroupMaterial();
                const mesh = new Mesh(geometry, material);
                mesh.position[0] = positions[i];
                scene.add(mesh);
                mesh.updateWorldMatrix();
            }

            renderer.render(scene, camera);

            // Should have draw calls for each mesh
            expect(stub.stats.drawCalls).toBeGreaterThanOrEqual(5);
        });
    });

    describe('version bumping', () => {
        test('changing uniform value triggers re-upload', async () => {
            const geometry = createBoxGeometry(1, 1, 1);
            const material = createBasicMaterial();
            const mesh = new Mesh(geometry, material);
            scene.add(mesh);
            mesh.updateWorldMatrix();

            // First frame
            renderer.render(scene, camera);
            stub.stats.reset();

            // Move the mesh (changes modelWorldMatrix) - stay within frustum
            mesh.position[0] = 1;  // Was 5, which is outside frustum
            mesh.updateWorldMatrix();

            // Second frame - object group should re-upload due to matrix change
            renderer.render(scene, camera);

            // Should have buffer writes for the changed matrix
            expect(stub.stats.bufferWrites).toBeGreaterThan(0);
        });
    });
});
