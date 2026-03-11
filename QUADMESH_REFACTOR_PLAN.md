# QuadMesh Refactor Plan

## Goal
Replace the sloppy internal fullscreen rendering code in `renderer.ts` with a clean Three.js-aligned `QuadMesh` class.

## Current State (the mess)
- `_fullscreenGeometry`, `_fullscreenMesh`, `_fullscreenScene`, `_fullscreenCamera` - internal slop
- `renderQuad()` - inspector-only method
- `renderQuadMesh()` - another method
- `_makeOutputMaterial()` - builds synthetic materials with UV hacks
- `QuadMesh.render()` calls `renderer.renderQuadMesh()` - backwards dependency

## Target State (Three.js aligned)
- `renderScene(object: Object3D, camera)` - renders any Object3D (Scene or Mesh)
- `QuadMesh.render(renderer)` calls `renderer.renderScene(this, this.camera)`
- `render(outputNode)` internally uses QuadMesh
- Inspector uses QuadMesh directly
- All `_fullscreen*` internal state removed

## Implementation Steps

### Step 1: Update render-list.ts
- [x] Change `collectRenderList(state, scene: Scene, camera)` → `collectRenderList(state, object: Object3D, camera)`
- [x] Same for `collectRenderListWithSort`

### Step 2: Update renderer.ts - renderScene signature  
- [x] Change `renderScene(scene: Scene, camera)` → `renderScene(object: Object3D, camera)`

### Step 3: Update QuadMesh.render()
- [x] Change from `renderer.renderQuadMesh(this)` to `renderer.renderScene(this, this.camera)`

### Step 4: Update render(outputNode)
- [ ] Replace internal `_fullscreenMesh` usage with a cached `QuadMesh`
- [ ] Build material from outputNode, assign to quadMesh.material
- [ ] Call `this.renderScene(quadMesh, quadMesh.camera)`

### Step 5: Update inspector viewer
- [ ] Replace `renderQuad(material)` with `quadMesh.render(renderer)` using a QuadMesh

### Step 6: Remove dead code from renderer.ts
- [ ] `renderQuad()`
- [ ] `renderQuadMesh()`
- [ ] `_fullscreenGeometry`, `_fullscreenMesh`, `_fullscreenScene`, `_fullscreenCamera`
- [ ] `_getFullscreenGeometry()`, `_getFullscreenMesh()`, `_getFullscreenScene()`, `_getFullscreenCamera()`

### Step 7: Clean up viewer.ts
- [ ] Remove `makeFullscreenUVVarying()` and related hacks
- [ ] Use QuadMesh with material built from the node

## Prerequisites (already done)
- TextureNode defaults `uvNode` to `varying(uv())`
- QuadMesh geometry has position + UV attributes via `createFullscreenTriangleGeometry()`
