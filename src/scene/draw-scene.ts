import type { Object3D } from '../core/object3d';
import type { Bin, BinDesc, Pass } from '../renderer/core/frame';
import { collectRenderList, type RenderItem } from '../renderer/core/render-list';
import type { Renderer } from '../renderer/core/renderer';
import { isRenderTarget } from '../renderer/core/target';
import type { View } from '../renderer/core/view';

// Opaque draws group by pipeline then material, nearest first within one, so the costliest state changes least and
// nearer surfaces hide what is behind them early. Transparent draws go farthest first, as blending needs. A mesh's
// `renderOrder` ranks above both.
const OPAQUE: BinDesc = { key: ['sortKey', 'pipeline', 'material', { depthNear: 8 }], label: 'opaque' };
const TRANSPARENT: BinDesc = { key: ['sortKey', 'depthFar'], label: 'transparent' };

/** Frustum culled, opaque before transparent, each in its own bin, drawn through the public `pass.bin`. */
export function drawScene(renderer: Renderer, pass: Pass, scene: Object3D, camera: View): void {
    // The scene tab's input, reported here so a pass recorded by hand correctly has no tree.
    if (renderer.inspector !== null) {
        const target = pass.desc.target;
        const colorFormat = isRenderTarget(target) ? (target.textures[0]?.format ?? '') : target.colorFormat;
        renderer.inspector.beginRenderScene(pass.desc.label ?? 'render', scene, target.samples, colorFormat);
    }

    const list = collectRenderList(renderer._renderLists, scene, camera);
    drawItems(pass.bin(OPAQUE), list.opaque);
    drawItems(pass.bin(TRANSPARENT), list.transparent);
}

function drawItems(bin: Bin, items: readonly RenderItem[]): void {
    for (const item of items) {
        const mesh = item.mesh;
        if (mesh === null || item.material === null || item.geometry === null) continue;
        bin.draw(mesh, mesh.renderOrder === 0 ? undefined : { sortKey: mesh.renderOrder });
    }
}
