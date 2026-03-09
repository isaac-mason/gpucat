# schema.ts redesign plan

The goal is to make every descriptor a proper tagged type carrying full structural
information, so `Node<D>` can provide typed `.element()` and `.field()` access with
`never` for misuse — with no string parsing at runtime.

---

## What exists today

```ts
export type WgslType = string;
export type WgslDesc<T extends WgslType> = { readonly wgslType: T };
export type StructSchema = Record<string, WgslDesc<WgslType>>;
```

`WgslDesc<T>` is just a box around a WGSL type name string literal. Structs are
duck-typed via `{ schema: StructSchema }` — there is no `StructDesc` type. Arrays
carry their element type only as part of the string (`array<vec3f>`), which is why
the current codebase has to regex-parse it back out at runtime.

---

## 1. Rename `WgslDesc` → `PrimDesc` for leaf scalar/vec/mat types

These are the descriptors that have no inner structure — they just name a WGSL type.
Rename makes the distinction clear.

```ts
// Before
export type WgslDesc<T extends WgslType> = { readonly wgslType: T };

// After
export type PrimDesc<T extends string = string> = { readonly wgslType: T };
```

All existing `d.f32`, `d.vec3f`, `d.mat4x4f` etc. stay as-is — they are `PrimDesc`
values. Nothing about their shape changes.

`WgslDesc` becomes the union of all descriptor kinds (see §5 below).

---

## 2. `StructDesc` — first-class tagged type

Currently structs are duck-typed. Replace with an explicit type:

```ts
export type StructSchema = Record<string, WgslDesc>;  // WgslDesc = the union

export type StructDesc<
    S extends StructSchema = StructSchema,
    Name extends string = string
> = {
    readonly wgslType: Name;          // WGSL uses the struct name as the type
    readonly isStructDesc: true;
    readonly name: Name;
    readonly schema: S;
};
```

Factory:

```ts
export function struct<S extends StructSchema, Name extends string>(
    name: Name,
    schema: S,
): StructDesc<S, Name>
```

The existing `struct()` in `nodes.ts` currently returns a `StructDef` (a class
instance). That is a separate concern (it registers the struct for WGSL emission).
`d.struct()` in schema.ts is purely the descriptor — a plain object. The two can
coexist: `StructDef` can hold a `StructDesc` as its `.desc` property rather than a
raw `.schema`.

`isStructDef` / `isStructDesc` guards are updated accordingly.

---

## 3. `ArrayDesc` — element desc replaces element string

Currently:

```ts
export type ArrayDesc<E extends WgslType> = WgslDesc<`array<${E}>`> & {
    readonly isArrayDesc: true;
    readonly elementDesc: WgslDesc<E>;  // element is WgslDesc<string>
};
```

The problem: `E` is constrained to `WgslType = string`, so `elementDesc` loses
structural info for struct elements. After this change `E` is constrained to
`WgslDesc` (the full union), so the element descriptor is preserved exactly:

```ts
export type ArrayDesc<E extends WgslDesc = WgslDesc> = {
    readonly wgslType: `array<${E['wgslType']}>`;
    readonly isArrayDesc: true;
    readonly elementDesc: E;
};

export type SizedArrayDesc<E extends WgslDesc = WgslDesc, N extends number = number> =
    ArrayDesc<E> & {
        readonly wgslType: `array<${E['wgslType']}, ${N}>`;
        readonly count: N;
    };
```

Factories stay the same call-site shape:

```ts
d.array(d.vec3f)             // ArrayDesc<PrimDesc<'vec3f'>>
d.array(MyStruct)            // ArrayDesc<StructDesc<{ pos: ... }, 'Particle'>>
d.arrayOf(d.vec3f, 100)      // SizedArrayDesc<PrimDesc<'vec3f'>, 100>
```

---

## 4. `AtomicDesc` — tightened to use `PrimDesc`

Currently `innerDesc: WgslDesc<T>`. After rename this becomes `innerDesc: PrimDesc<T>`.
No functional change.

---

## 5. `WgslDesc` becomes the union of all descriptor kinds

```ts
export type WgslDesc =
    | PrimDesc
    | StructDesc
    | ArrayDesc
    | SizedArrayDesc
    | AtomicDesc<AtomicInner>
    | TextureDesc
    | SamplerDesc;
```

This is the packcat pattern: the union type is the entry point, individual kinds are
named members. Anywhere that currently says `WgslDesc<WgslType>` (meaning "any
descriptor") just becomes `WgslDesc`.

Note: `PrimDesc<T>` retains its string type parameter for the cases where the exact
WGSL string literal matters (e.g. `PrimDesc<'vec3f'>` vs `PrimDesc<'f32'>`). The
union type `WgslDesc` is the widened form used for storage and function boundaries.

---

## 6. `Infer<D>` — updated to match new descriptor shapes

The existing `Infer<D>` works by matching against `WgslDesc<'f32'>` etc. After the
rename it matches against `PrimDesc<'f32'>` etc. The struct case currently duck-types
via `D extends { readonly schema: infer S extends StructSchema }` — this becomes the
cleaner `D extends StructDesc<infer S, any>`. The array cases already work via
`ArrayDesc<infer E>` and continue to do so.

The struct → `{ [K in keyof S]: Infer<S[K]> }` recursion is unchanged in shape but
now `S[K]` is `WgslDesc` (the union) rather than `WgslDesc<WgslType>` (a string
wrapper), so it recurses properly through nested structs and arrays.

---

## 7. `StructSchema` field type tightened

```ts
// Before
export type StructSchema = Record<string, WgslDesc<WgslType>>;

// After
export type StructSchema = Record<string, WgslDesc>;
```

Fields can now be structs, arrays, atomics — not just primitive descriptors.

---

## 8. Size/align utilities — remove string parsing

`wgslAlignOf` and `wgslSizeOf` currently switch on `desc.wgslType` (a string) for
every case. They also call `isStructDef(desc)` which duck-types via `'schema' in
desc`. After this change:

- The struct branch uses `isStructDesc(desc)` — cleaner guard, same logic
- The array branch uses `isArrayDesc(desc)` and reads `desc.elementDesc` directly
  instead of parsing `array<E>` from the wgslType string
- No other changes needed — primitive type strings are unchanged

---

## What does NOT change

- All `d.f32`, `d.vec3f`, `d.mat4x4f` etc. descriptor singletons — same values,
  same property shape, just their TypeScript type is `PrimDesc<'f32'>` instead of
  `WgslDesc<'f32'>`. Structurally identical.
- All texture and sampler descriptors — they already have discriminant fields
  (`isTextureDesc`, `isSamplerDesc`), just fold into the union.
- `wgslAlignOf`, `wgslSizeOf`, `wgslStrideOf`, `roundUp` — same logic, minor guard
  cleanup only.
- `itemSizeOf`, `typedArrayCtorOf` — unchanged.
- The `d.*` import-as-namespace API — unchanged.

---

## Summary of type-level changes

| Before | After |
|---|---|
| `WgslDesc<T extends string>` | `PrimDesc<T extends string>` (leaf) |
| `WgslDesc<WgslType>` (any desc) | `WgslDesc` (the union) |
| `StructSchema = Record<string, WgslDesc<WgslType>>` | `StructSchema = Record<string, WgslDesc>` |
| `ArrayDesc<E extends WgslType>` with `elementDesc: WgslDesc<E>` | `ArrayDesc<E extends WgslDesc>` with `elementDesc: E` |
| struct duck-typed via `{ schema: StructSchema }` | `StructDesc<S, Name>` explicit tagged type |
| `Infer<D>` struct branch: duck-type match | `Infer<D>` struct branch: `D extends StructDesc<infer S, any>` |

---

## Type utilities `Node<D>` will use (defined here, consumed in core.ts)

These helper types live in schema.ts and are used by core.ts to type `.element()` and
`.field()`:

```ts
// The element descriptor of an array descriptor, or never for non-arrays
export type DescElement<D extends WgslDesc> =
    D extends ArrayDesc<infer E> ? E : never;

// The field map of a struct descriptor, or never for non-structs
export type DescFields<D extends WgslDesc> =
    D extends StructDesc<infer S, any> ? S : never;
```

These make the Node method signatures clean and self-contained:

```ts
// In core.ts:
element(idx: Node<AnyDesc>): Node<DescElement<D>>   // never if D is not an array
field<K extends keyof DescFields<D>>(k: K): Node<DescFields<D>[K]>  // never if D is not a struct
```

---

## File scope

Only `schema.ts` changes in this step. `core.ts`, `storage.ts`, `builder.ts` etc.
are untouched — they continue to use `node.type` (which currently reads `desc.wgslType`
as a string) without modification. The node system migration is a separate step.
