# RenderPipeline Alignment Plan

## Current Issues

### Issue A: Multiple Uniform Groups with Different Update Frequencies

**Problem**: We want to support multiple shared uniform groups (frameGroup, renderGroup) with different update frequencies, matching Three.js's `NodeUpdateType` pattern.

**Three.js pattern** (`NodeUpdateType`):
- `'none'` - never update automatically
- `'frame'` - update once per animation frame (time, deltaTime)
- `'render'` - update once per `render()` call (camera matrices, viewport)
- `'object'` - update for every object (model matrix, material uniforms)

**Current state**:
- `NodeFrame` already has `frameId`, `renderId`, and deduplication methods (`updateBeforeNode`, `updateNode`, `updateAfterNode`) that respect update types
- `frameGroup` and `renderGroup` in `core/uniform.ts` already have `updateType` set correctly
- **Problem**: Uniform binding deduplication uses `groupNode.version` instead of `frame.frameId`/`frame.renderId`

**Current deduplication code** (`bindings.ts:345-356`):
```ts
if (block.groupNode.shared) {
    const groupVersion = block.groupNode.version;
    if (binding.lastProcessedVersion === groupVersion) {
        return;
    }
    binding.lastProcessedVersion = groupVersion;
}
```

**Problem with this**:
- `frameGroup.version++` and `renderGroup.version++` are both called at the start of every `render()` call
- This means frameGroup uniforms get re-packed every render, not once per frame
- The binding should check `frame.frameId` for frameGroup and `frame.renderId` for renderGroup

### Issue B: Render Pipeline Format Mismatch Error

**Error**:
```
[WebGPU render validation error] Attachment state of [RenderPipeline (unlabeled)] is not compatible with [RenderPassEncoder (unlabeled)].
[RenderPassEncoder (unlabeled)] expects an attachment state of { colorTargets: [0={format:TextureFormat::BGRA8Unorm}], ...
[RenderPipeline (unlabeled)] has an attachment state of { colorTargets: [0={format:TextureFormat::RGBA8Unorm}], ...
```

**Root cause** (`renderer.ts:921`):
```ts
const colorFormat = renderTarget?.colorFormat ?? 'rgba8unorm';  // WRONG!
```

When rendering to the swapchain (no renderTarget), we use `'rgba8unorm'` as the colorFormat for pipeline creation, but the actual swapchain texture uses `this.format` which is `'bgra8unorm'` (from `navigator.gpu.getPreferredCanvasFormat()`).

**Fix**: Use `this.format` as the fallback, not `'rgba8unorm'`:
```ts
const colorFormat = renderTarget?.colorFormat ?? this.format;
```

### Issue C: Inspector Viewer Broken

**Problem**: The viewer tab had `renderQuad()` calls that are now commented out. The old `renderer.renderQuad()` method was removed during the refactor.

**Location**: `src/inspector/tabs/viewer.ts:212-214`
```ts
// Render the preview quad — NO updateBefore, no PassNode recursion.
// const encoder = renderer.device.createCommandEncoder();
// renderer.renderQuad(canvasData.material, encoder);
// renderer.device.queue.submit([encoder.finish()]);
```

**Three.js approach**: Three.js just calls `canvasData.quad.render(renderer)` with no special handling. It relies on `updateBeforeType: 'frame'` deduplication to prevent infinite recursion - PassNode only renders once per frame regardless of how many times `render()` is called.

**Solution**: Match Three.js exactly:
1. Add `quadMesh: QuadMesh` to `CanvasData` type  
2. Create the QuadMesh in `getCanvasDataByNode()` and cache it
3. Call `canvasData.quadMesh.render(renderer)` in `Viewer.update()`

---

## Fixes

### Fix A: Align Uniform Deduplication with NodeUpdateType

**Files to change**:

1. **`bind-group.ts`**: Replace `lastProcessedVersion` with `lastFrameId`/`lastRenderId`
   ```ts
   export type UniformBinding = {
       readonly kind: 'uniform';
       block: UniformGroupBlock;
       bufferKey: object | null;
       lastFrameId: number;   // was: lastProcessedVersion
       lastRenderId: number;  // new
       packedBuffer: Float32Array | null;
   };
   ```

2. **`bindings.ts`**: Update `updateUniformBinding()` to use frame IDs based on `updateType`
   ```ts
   if (block.groupNode.shared) {
       const updateType = block.groupNode.updateType;
       if (updateType === 'frame') {
           if (binding.lastFrameId === frame.frameId) return;
           binding.lastFrameId = frame.frameId;
       } else if (updateType === 'render') {
           if (binding.lastRenderId === frame.renderId) return;
           binding.lastRenderId = frame.renderId;
       }
       // 'object' and 'none' always process (or never, respectively)
   }
   ```

3. **`renderer.ts:899-900`**: Remove these lines - no longer needed:
   ```ts
   frameGroup.version++;
   renderGroup.version++;
   ```

4. **`core/uniform.ts`**: Remove `version` field from `UniformGroup` class (line ~29)

5. **`render-pipeline.ts`**: Bump `frameId` once per animation frame. Options:
   - Add public `updateFrame()` method to renderer that calls `this._nodes.nodeFrame.update()`
   - Or expose `nodeFrame` publicly: `get nodeFrame() { return this._nodes.nodeFrame; }`
   
   Then in RenderPipeline:
   ```ts
   render(): void {
       this.renderer.nodeFrame.update();  // bump frameId, update time
       this._update();
       this._quadMesh.render(this.renderer);
   }
   ```

### Fix B: Use Correct Color Format for Swapchain

**File**: `renderer.ts:921`

**Change**:
```ts
// Before:
const colorFormat = renderTarget?.colorFormat ?? 'rgba8unorm';

// After:
const colorFormat = renderTarget?.colorFormat ?? this.format;
```

### Fix C: Restore Inspector Viewer

**Approach**: Match Three.js exactly - no special flags needed. The `updateBeforeType: 'frame'` deduplication in NodeFrame prevents infinite recursion.

**Files to change**:

1. **`inspector/tabs/viewer.ts`**: Add `quadMesh` to CanvasData type
   ```ts
   export type CanvasData = {
       // ... existing fields ...
       quadMesh: QuadMesh;
   };
   ```

2. **`inspector/inspector.ts`**: Create QuadMesh in `getCanvasDataByNode()`
   ```ts
   const quadMesh = new QuadMesh(material);
   quadMesh.name = 'Viewer - ' + name;
   
   canvasData = {
       // ... existing fields ...
       quadMesh,
   };
   ```

3. **`inspector/tabs/viewer.ts:197-218`**: Replace commented code in `update()` with QuadMesh render:
   ```ts
   // Around line 209-215, replace the commented block:
   
   // Render the preview quad
   // Three.js aligned: canvasData.quad.render(renderer)
   canvasData.quadMesh.render(renderer);
   ```

---

## Implementation Order

1. **Fix B first** - simplest, unblocks testing
2. **Fix C** - restores inspector functionality  
3. **Fix A** - proper deduplication alignment (more complex, can be done later)

---

## Dead Code to Remove

After fixes are complete, remove unused code from `renderer.ts`:
- `_getQuadMesh()` method (LSP shows it's never read)
- Any other orphaned methods from the old `renderQuad()` approach

---

## Three.js Reference

### NodeFrame in Three.js (`src/nodes/core/NodeFrame.js`)
```js
class NodeFrame {
    frameId = 0;
    renderId = 0;
    // ...
    
    update() {
        this.frameId++;
        // update time, deltaTime
    }
    
    updateBeforeNode(node) {
        const updateType = node.getUpdateBeforeType();
        if (updateType === 'frame') {
            if (this._updateBeforeMap.get(node) !== this.frameId) {
                this._updateBeforeMap.set(node, this.frameId);
                node.updateBefore(this);
            }
        } else if (updateType === 'render') {
            if (this._updateBeforeMap.get(node) !== this.renderId) {
                this._updateBeforeMap.set(node, this.renderId);
                node.updateBefore(this);
            }
        } else if (updateType === 'object') {
            node.updateBefore(this);
        }
    }
}
```

### RenderPipeline in Three.js (`src/renderers/common/RenderPipeline.js`)
```js
class RenderPipeline {
    render() {
        this._update();
        this._quadMesh.render(this._renderer);
    }
}
```

### Renderer.render() in Three.js
```js
render(scene, camera) {
    this._frameBufferTarget = null;
    // ... setup ...
    this._renderScene(scene, camera);  // renderId++ inside
}

_renderScene(scene, camera) {
    this._nodeFrame.renderId++;
    // ... render objects ...
}
```
