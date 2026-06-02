![cover](./docs/cover.png)

```sh
> npm install isaac-mason/gpucat
```

> gpucat is being built in public. as such, docs are sparse, and installation is via the github repo instead of npm for now.

# gpucat

gpucat is a modular WebGPU renderer for typescript. It allows you to write shaders in typescript with advanced type safety, and provides lower-level access so you can create the renderer you want.

It provides you with a declarative data-oriented API for managing resources, a type-safe typescript node-based API that follows WGSL grammar, and it handles all the boilerplate of resource management, pipeline creation, layouts, bind groups, for you.

## Getting Started

A minimal spinning cube — renderer setup, a node-based material, and a `requestAnimationFrame` loop:

<Snippet source="./snippets.ts" select="spinning-cube" />
