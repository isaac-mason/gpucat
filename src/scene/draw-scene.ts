import type { Object3D } from '../core/object3d';
import type { Pass } from '../renderer/core/frame';
import { collectRenderList, type RenderItem } from '../renderer/core/render-list';
import type { Renderer } from '../renderer/core/renderer';
import { isRenderTarget } from '../renderer/core/target';
import type { View } from '../renderer/core/view';

/** Frustum culled, in render order, opaque before transparent, drawn through the public `pass.draw`. */
export function drawScene(renderer: Renderer, pass: Pass, scene: Object3D, camera: View): void {
    // The scene tab's input, reported here so a pass recorded by hand correctly has no tree.
    if (renderer.inspector !== null) {
        const target = pass.desc.target;
        const colorFormat = isRenderTarget(target) ? (target.textures[0]?.format ?? '') : target.colorFormat;
        renderer.inspector.beginRenderScene(pass.desc.label ?? 'render', scene, target.samples, colorFormat);
    }

    const list = collectRenderList(renderer._renderLists, scene, camera);
    drawItems(pass, list.opaque);
    drawItems(pass, list.transparent);
}

function drawItems(pass: Pass, items: readonly RenderItem[]): void {
    for (const item of items) {
        if (item.mesh === null || item.material === null || item.geometry === null) continue;
        pass.draw(item.mesh);
    }
}
