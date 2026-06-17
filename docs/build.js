import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const here = path.dirname(new URL(import.meta.url).pathname);
const srcDir = path.join(here, '../src');

/* ─────────────────────────────────────────────────────────────────────────
 * Section manifest - the human-curated table of contents.
 *
 * This is the ONE place you edit to organise the API reference. Symbol
 * details (JSDoc + signature) are generated from source, but the grouping,
 * ordering, and section blurbs are yours.
 *
 * A group is one of:
 *   { title, modules: ['renderer/renderer', ...] }  - all exports of those src files
 *   { nodesBlock: true }                              - the DSL `export { … } from
 *                                                       './nodes/nodes'` block,
 *                                                       auto-split by its // category
 *                                                       comments in src/index.ts
 * ──────────────────────────────────────────────────────────────────────── */
const SECTIONS = [
    {
        title: 'Shading language (DSL)',
        blurb: 'The full node DSL, grouped by category. Learn it with examples in the [guide](./README.md).',
        groups: [
            { nodesBlock: true },
        ],
    },
    {
        title: 'Renderer',
        blurb: 'Drive the GPU: create a renderer, build pipelines, render to the canvas or a target.',
        groups: [
            { title: 'Renderer', modules: ['renderer/renderer'] },
            { title: 'Pipelines & targets', modules: ['renderer/render-pipeline', 'renderer/canvas-target', 'renderer/read-pixels', 'core/render-target', 'core/cube-render-target'] },
        ],
    },
    {
        title: 'Scene & objects',
        blurb: 'The scene graph, cameras, and the objects you put in it.',
        groups: [
            { title: 'Scene graph', modules: ['scene/scene', 'core/object3d'] },
            { title: 'Cameras', modules: ['camera/camera', 'camera/perspective-camera', 'camera/orthographic-camera', 'camera/cube-camera'] },
            { title: 'Objects', modules: ['objects/mesh', 'objects/line'] },
            { title: 'Geometry', modules: ['geometry/geometry', 'geometry/geometry-helpers'] },
        ],
    },
    {
        title: 'GPU resources',
        blurb: 'Declarative, data-oriented resources: buffers, uniforms, materials, and textures.',
        groups: [
            { title: 'Buffers & uniforms', modules: ['core/gpu-buffer', 'core/uniform'] },
            { title: 'Materials', modules: ['material/material'] },
            { title: 'Textures', modules: ['texture/texture', 'texture/source', 'texture/canvas-texture', 'texture/cube-texture', 'texture/depth-texture', 'texture/array-texture'] },
        ],
    },
    {
        title: 'Compilation',
        blurb: 'Turn a node graph into WGSL.',
        groups: [
            { title: 'Compile', modules: ['nodes/builder'] },
        ],
    },
    {
        title: 'Schema (`d`)',
        blurb: 'WGSL type descriptors (imported as `d`) and std430 buffer packing.',
        groups: [
            { title: 'Descriptors & packing', modules: ['schema/pack'] },
        ],
    },
    {
        title: 'Controls & debugging',
        groups: [
            { title: 'Camera controls', modules: ['controls/orbit-controls', 'controls/fly-controls', 'controls/transform-controls'] },
            { title: 'Inspector', modules: ['inspector/inspector'] },
        ],
    },
    {
        title: 'Math & utils',
        groups: [
            { title: 'Math', modules: ['math/frustum', 'math/raycaster'] },
        ],
    },
];

/* ───────────────────────────── program setup ───────────────────────────── */

function getAllSourceFiles(dir) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) files = files.concat(getAllSourceFiles(fullPath));
        else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(fullPath);
    }
    return files;
}

const sourceFiles = getAllSourceFiles(srcDir);
const tsProgram = ts.createProgram(sourceFiles, {
    allowJs: false,
    declaration: true,
    emitDeclarationOnly: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: false,
    stripInternal: true, // omit @internal-tagged declarations from the emitted .d.ts
});

/* Emit .d.ts for every file into memory. The declaration output is exactly the
 * public shape - JSDoc preserved, no method bodies - which is what a reference
 * wants. We then parse each .d.ts and slice out individual symbols. */
const dtsByPath = new Map();
tsProgram.emit(
    undefined,
    (fileName, data) => dtsByPath.set(path.normalize(fileName), data),
    undefined,
    true, // emitOnlyDtsFiles
);
const dtsSourceFiles = [...dtsByPath.entries()].map(([fileName, text]) =>
    ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true),
);

/* Map a module path used in index.ts (e.g. 'renderer/renderer') to its emitted
 * .d.ts SourceFile. */
function dtsForModule(modulePath) {
    const want = path.normalize(path.join(srcDir, modulePath) + '.d.ts');
    return dtsSourceFiles.find((sf) => path.normalize(sf.fileName) === want) ?? null;
}

/* ───────────────────────── symbol extraction (.d.ts) ────────────────────── */

function isExported(node) {
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function declName(node) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

/** Ordered list of exported symbol names declared directly in a .d.ts file. */
function exportedNamesOf(dtsSf) {
    const names = [];
    for (const stmt of dtsSf.statements) {
        if (!isExported(stmt)) continue;
        if (
            ts.isFunctionDeclaration(stmt) ||
            ts.isClassDeclaration(stmt) ||
            ts.isInterfaceDeclaration(stmt) ||
            ts.isTypeAliasDeclaration(stmt) ||
            ts.isEnumDeclaration(stmt)
        ) {
            const n = declName(stmt);
            if (n) names.push(n);
        } else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
                if (decl.name && ts.isIdentifier(decl.name)) names.push(decl.name.text);
            }
        }
    }
    return [...new Set(names)];
}

/** Slice the declaration text (incl. leading JSDoc) for `name` from a .d.ts.
 * Multiple overloads are concatenated. Returns null if not found. */
function declTextOf(name, dtsSf) {
    const sfList = dtsSf ? [dtsSf] : dtsSourceFiles;
    for (const sf of sfList) {
        const fullText = sf.getFullText();
        const matches = [];
        for (const stmt of sf.statements) {
            if (!isExported(stmt)) continue;
            let hit = false;
            if (
                ts.isFunctionDeclaration(stmt) ||
                ts.isClassDeclaration(stmt) ||
                ts.isInterfaceDeclaration(stmt) ||
                ts.isTypeAliasDeclaration(stmt) ||
                ts.isEnumDeclaration(stmt)
            ) {
                hit = declName(stmt) === name;
            } else if (ts.isVariableStatement(stmt)) {
                hit = stmt.declarationList.declarations.some((d) => d.name && ts.isIdentifier(d.name) && d.name.text === name);
            }
            if (hit) {
                const text = ts.isClassDeclaration(stmt)
                    ? classDeclText(stmt, sf, fullText)
                    : sliceWithJsDoc(stmt, sf, fullText);
                matches.push(text.replace(/^export declare /gm, 'export '));
            }
        }
        if (matches.length) return matches.join('\n');
    }
    return null;
}

/** Text of a declaration including its leading JSDoc. */
function sliceWithJsDoc(node, sf, fullText) {
    const jsDoc = ts.getJSDocCommentsAndTags(node)[0];
    const start = jsDoc ? jsDoc.getStart(sf) : node.getStart(sf);
    return fullText.slice(start, node.getEnd());
}

/** Render a class declaration, dropping `_`-prefixed (internal-by-convention)
 * members. Keeps the constructor and all public members with their JSDoc. */
function classDeclText(stmt, sf, fullText) {
    const jsDoc = ts.getJSDocCommentsAndTags(stmt)[0];
    const headStart = jsDoc ? jsDoc.getStart(sf) : stmt.getStart(sf);
    const braceIdx = fullText.indexOf('{', stmt.getStart(sf));
    let out = fullText.slice(headStart, braceIdx + 1);

    const kept = stmt.members.filter((m) => {
        const n = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null;
        if (n === null) return ts.isConstructorDeclaration(m); // keep ctor, drop index sigs etc.
        return !n.startsWith('_');
    });
    for (const m of kept) out += '\n' + sliceWithJsDoc(m, sf, fullText).replace(/^\s*/, '    ');
    out += '\n}';
    return out;
}

/* ─────────────────────── DSL nodes-block parsing ────────────────────────── */

/** Parse the `export { … } from './nodes/nodes'` block in src/index.ts into
 * ordered { category, names[] } groups, using the // category comments. */
function parseNodesBlock() {
    const indexText = fs.readFileSync(path.join(srcDir, 'index.ts'), 'utf-8');
    const m = indexText.match(/export\s*\{([\s\S]*?)\}\s*from\s*['"]\.\/nodes\/nodes['"]/);
    if (!m) return [];
    const groups = [];
    let current = { category: 'general', names: [] };
    for (const raw of m[1].split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const comment = line.match(/^\/\/\s*(.+)$/);
        if (comment) {
            if (current.names.length) groups.push(current);
            current = { category: comment[1].trim(), names: [] };
            continue;
        }
        // strip trailing comma, `type ` prefix, and `X as Y` aliasing
        const token = line.replace(/,\s*$/, '').replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(token)) current.names.push(token);
    }
    if (current.names.length) groups.push(current);
    return groups;
}

/* ───────────────────────── markdown rendering ───────────────────────────── */

const usedAnchors = new Set();
function anchorFor(displayName) {
    const base = displayName.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
    let a = base;
    let i = 2;
    while (usedAnchors.has(a)) a = `${base}-${i++}`;
    usedAnchors.add(a);
    return a;
}

/** Render one group → { toc, detail }. resolve(name) → decl text or null. */
function renderGroup(title, names, resolve) {
    const entries = [];
    for (const name of names) {
        const text = resolve(name);
        if (!text) {
            console.warn(`  · no declaration found for "${name}"`);
            continue;
        }
        entries.push({ name, anchor: anchorFor(name), text: text.trim() });
    }
    if (!entries.length) return { toc: '', detail: '' };

    // TOC: a compact grid of linked code chips
    const cols = Math.min(4, entries.length);
    let toc = title ? `**${title}**\n\n` : '';
    toc += '<table><tr>\n';
    entries.forEach((e, i) => {
        toc += `<td><a href="#${e.anchor}"><code>${e.name}</code></a></td>`;
        if ((i + 1) % cols === 0 && i < entries.length - 1) toc += '\n</tr><tr>\n';
    });
    const rem = entries.length % cols;
    if (rem !== 0) for (let i = 0; i < cols - rem; i++) toc += '<td></td>';
    toc += '\n</tr></table>\n\n';

    // Detail: per-symbol heading + fenced declaration
    let detail = '';
    for (const e of entries) {
        detail += `#### \`${e.name}\`\n\n\`\`\`ts\n${e.text}\n\`\`\`\n\n`;
    }
    return { toc, detail };
}

function generateApiDocs() {
    const nodesGroups = parseNodesBlock();
    let toc = '';
    let detail = '';

    for (const section of SECTIONS) {
        toc += `### ${section.title}\n\n`;
        if (section.blurb) toc += `${section.blurb}\n\n`;
        detail += `## ${section.title}\n\n`;
        if (section.blurb) detail += `${section.blurb}\n\n`;

        for (const group of section.groups) {
            if (group.nodesBlock) {
                for (const ng of nodesGroups) {
                    const names = ng.names.filter((n) => n !== 'Node' && !/Node$/.test(n));
                    const r = renderGroup(ng.category, names, (name) => declTextOf(name));
                    toc += r.toc;
                    detail += r.detail;
                }
                continue;
            }
            const names = [];
            const resolvers = new Map();
            for (const mod of group.modules) {
                const dts = dtsForModule(mod);
                if (!dts) {
                    console.warn(`  · no .d.ts for module "${mod}"`);
                    continue;
                }
                for (const n of exportedNamesOf(dts)) {
                    if (!resolvers.has(n)) {
                        names.push(n);
                        resolvers.set(n, dts);
                    }
                }
            }
            const r = renderGroup(group.title, names, (name) => declTextOf(name, resolvers.get(name)));
            toc += r.toc;
            detail += r.detail;
        }
    }

    return toc + '\n---\n\n' + detail;
}

/* Render one DSL category (from the nodes block) inline: chips + detail.
 * Node-class types (`*Node`, bare `Node`) are dropped so the reference stays
 * focused on the DSL surface, not the backing classes. */
function renderCategory(name, compact = false) {
    const g = parseNodesBlock().find((x) => x.category.toLowerCase() === name.toLowerCase());
    if (!g) {
        console.warn(`  · <RenderCategory> category "${name}" not found`);
        return '';
    }
    const names = g.names.filter((n) => n !== 'Node' && !/Node$/.test(n));
    if (compact) return compactGrid(names);
    // Detail only: inline in a concept section the prose is the intro, so a chip
    // grid on top of the entries right below it is just redundant.
    const r = renderGroup(null, names, (nm) => declTextOf(nm));
    return r.detail;
}

/* A grid of code chips linking to their full entry in api.md. No signatures, so
 * a concept section in the guide stays prose-first. */
function slug(s) {
    return s.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}
function compactGrid(names) {
    if (!names.length) return '';
    const cols = Math.min(6, names.length);
    let out = '<table><tr>\n';
    names.forEach((n, i) => {
        out += `<td><a href="./api.md#${slug(n)}"><code>${n}</code></a></td>`;
        if ((i + 1) % cols === 0 && i < names.length - 1) out += '\n</tr><tr>\n';
    });
    const rem = names.length % cols;
    if (rem !== 0) for (let i = 0; i < cols - rem; i++) out += '<td></td>';
    out += '\n</tr></table>\n';
    return out;
}

/* Render every export of one module inline: chips + detail. */
function renderModule(modulePath) {
    const dts = dtsForModule(modulePath);
    if (!dts) {
        console.warn(`  · <RenderModule> no .d.ts for "${modulePath}"`);
        return '';
    }
    const r = renderGroup(null, exportedNamesOf(dts), (nm) => declTextOf(nm, dts));
    return r.toc + r.detail;
}

/* Render the public method/getter surface of the `Node` class as one block.
 * This is the method-chaining reference (`a.mul(b)`, `.toVar()`, `.xyz`, ...). */
function renderNodeMethods() {
    const d = declTextOf('Node');
    if (!d) {
        console.warn('  · <RenderNodeMethods> class Node not found');
        return '';
    }
    return `\`\`\`ts\n${d.trim()}\n\`\`\`\n`;
}

/* A gallery table of examples with screenshots, read from examples.json.
 * Each cell links to the live example on GitHub Pages and shows its screenshot
 * from examples/public/screenshots/<key>.png. */
const EXAMPLES_COLS = 3;
const EXAMPLE_PAGES_BASE = 'https://isaac-mason.github.io/gpucat/#';
function renderExamples() {
    const jsonPath = path.join(here, '../examples/src/examples.json');
    if (!fs.existsSync(jsonPath)) return console.warn(`examples.json not found: ${jsonPath}`), '';
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const keys = Object.keys(data);
    let out = '<table>\n';
    for (let i = 0; i < keys.length; i += EXAMPLES_COLS) {
        out += '  <tr>\n';
        for (let j = 0; j < EXAMPLES_COLS && i + j < keys.length; ++j) {
            const key = keys[i + j];
            const title = data[key].title || key;
            const img = `./examples/public/screenshots/${key}.png`;
            const href = `${EXAMPLE_PAGES_BASE}${key}`;
            out += `    <td align="center">\n`;
            out += `      <a href="${href}">\n`;
            out += `        <img src="${img}" width="180" height="120" style="object-fit:cover;"/><br/>\n`;
            out += `        ${title}\n`;
            out += `      </a>\n`;
            out += `    </td>\n`;
        }
        out += '  </tr>\n';
    }
    out += '</table>';
    return out;
}

/* A one-row table of one or more examples, for interleaving inside a section.
 * <ExamplesTable ids="example-texture,example-mipmaps" /> */
function renderExamplesTable(idsStr) {
    const jsonPath = path.join(here, '../examples/src/examples.json');
    if (!fs.existsSync(jsonPath)) return console.warn(`examples.json not found: ${jsonPath}`), '';
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const ids = idsStr.split(',').map((s) => s.trim());
    const valid = ids.filter((id) => data[id] || console.warn(`example '${id}' not in examples.json`));
    if (valid.length === 0) return '';
    const cells = valid
        .map((id) => {
            const title = data[id].title || id;
            const img = `./examples/public/screenshots/${id}.png`;
            const href = `${EXAMPLE_PAGES_BASE}${id}`;
            return (
                `    <td align="center">\n` +
                `      <a href="${href}">\n` +
                `        <img src="${img}" width="200" height="133" style="object-fit:cover;"/><br/>\n` +
                `        ${title}\n` +
                `      </a>\n` +
                `    </td>`
            );
        })
        .join('\n');
    return `<table>\n  <tr>\n${cells}\n  </tr>\n</table>`;
}

/* ─────────────────────────── template directives ───────────────────────── */

/* Expand all directives in a template's text. Anchors are per-file, so the
 * collision set is reset for each render. */
function render(text) {
    usedAnchors.clear();

    /* <Examples /> - gallery table of examples with screenshots */
    text = text.replace(/<Examples\s*\/>/g, () => renderExamples());

    /* <ExamplesTable ids="a,b,c" /> - inline one-row table for a section */
    text = text.replace(/<ExamplesTable\s+ids=["'](.+?)["']\s*\/>/g, (_full, ids) => renderExamplesTable(ids));

    /* <RenderAPI /> */
    text = text.replace(/<RenderAPI\s*\/>/g, () => generateApiDocs());

    /* <RenderCategory name="math/operators" />  or  <RenderCategory name="constructors" compact /> */
    text = text.replace(/<RenderCategory\s+name=["'](.+?)["']\s*(compact)?\s*\/>/g, (_full, name, compact) => renderCategory(name, !!compact));

    /* <RenderModule name="texture/texture" /> */
    text = text.replace(/<RenderModule\s+name=["'](.+?)["']\s*\/>/g, (_full, name) => renderModule(name));

    /* <RenderNodeMethods /> */
    text = text.replace(/<RenderNodeMethods\s*\/>/g, () => renderNodeMethods());

    /* <RenderType type="import('gpucat').Name" /> - JSDoc + declaration shape */
    text = text.replace(/<RenderType\s+type=["']import\(['"]gpucat['"]\)\.(\w+)["']\s*\/>/g, (full, name) => {
        const d = declTextOf(name);
        if (!d) return console.warn(`Type ${name} not found`), full;
        return `\`\`\`ts\n${d.trim()}\n\`\`\``;
    });

    /* <RenderSource type="import('gpucat').Name" /> - full source incl. body */
    text = text.replace(/<RenderSource\s+type=["']import\(['"]gpucat['"]\)\.(\w+)["']\s*\/>/g, (full, name) => {
        const d = getSource(name);
        if (!d) return console.warn(`Source ${name} not found`), full;
        return `\`\`\`ts\n${d}\n\`\`\``;
    });

    /* <Snippet source="./snippets.ts" select="group" /> */
    text = text.replace(/<Snippet\s+source=["'](.+?)["']\s+select=["'](.+?)["']\s*\/>/g, (full, sourcePath, groupName) => {
        const abs = path.join(here, sourcePath);
        if (!fs.existsSync(abs)) return console.warn(`Snippet source not found: ${abs}`), full;
        const src = fs.readFileSync(abs, 'utf-8');
        const re = new RegExp(
            String.raw`^([ \t]*)\/\*[ \t]*SNIPPET_START:[ \t]*${groupName}[ \t]*\*\/[\r\n]+([\s\S]*?)[ \t]*^\1\/\*[ \t]*SNIPPET_END:[ \t]*${groupName}[ \t]*\*\/`,
            'm',
        );
        const m = re.exec(src);
        if (!m) return console.warn(`Snippet group '${groupName}' not found`), full;
        let code = m[2];
        if (m[1]) code = code.replace(new RegExp(`^${m[1]}`, 'gm'), '');
        code = code.replace(/^\s*\n|\n\s*$/g, '');
        return `\`\`\`ts\n${code}\n\`\`\``;
    });

    return text;
}

const outputs = [
    { template: './README.template.md', out: '../README.md' },
    { template: './api.template.md', out: '../api.md' },
];
for (const { template, out } of outputs) {
    const tplPath = path.join(here, template);
    if (!fs.existsSync(tplPath)) {
        console.warn(`Skipping ${template} (not found)`);
        continue;
    }
    const result = render(fs.readFileSync(tplPath, 'utf-8'));
    const outPath = path.join(here, out);
    fs.writeFileSync(outPath, result, 'utf-8');
    console.log(`Wrote ${path.relative(process.cwd(), outPath)}`);
}

/* ───────────── getSource - raw source incl. body (for <RenderSource>) ────── */
function getSource(name) {
    let found = null;
    for (const file of sourceFiles) {
        const sf = tsProgram.getSourceFile(file);
        if (!sf) continue;
        const fileText = sf.getFullText();
        const visit = (node) => {
            if (
                (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
                node.name?.text === name
            ) {
                found = fileText.slice(node.getStart(sf), node.getEnd());
            }
            if (ts.isVariableStatement(node) && isExported(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (decl.name && ts.isIdentifier(decl.name) && decl.name.text === name) found = fileText.slice(node.getStart(sf), node.getEnd());
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        if (found) break;
    }
    return found;
}
