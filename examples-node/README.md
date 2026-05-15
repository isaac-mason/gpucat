# gpucat-examples-node

Headless Node.js examples for gpucat using a native WebGPU library.

## Setup

```sh
pnpm install
```

The `webgpu` package ships native Dawn binaries — no additional system dependencies needed on macOS / Linux / Windows.

## Examples

### `render-to-png`

Renders a lit cube headlessly and writes `output.png`.

```sh
pnpm run render
```

## How it works

1. `webgpu`'s `create()` returns a `GPU` instance equivalent to `navigator.gpu`.
2. We request an adapter + device ourselves and pass them into `WebGPURenderer({ device, adapter, headless: true })`. Headless mode skips canvas creation and the swapchain entirely.
3. We render into a `RenderTarget` with `colorFormat: 'rgba8unorm'` so the result is directly readable as 8-bit RGBA.
4. `readPixels(renderer, renderTarget)` does `copyTextureToBuffer` + `mapAsync`, strips the 256-byte row alignment padding, and returns a tightly-packed `Uint8Array`.
5. `pngjs` encodes the bytes and writes to disk.
