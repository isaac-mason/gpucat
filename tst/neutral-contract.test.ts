import ts from 'typescript';
import { expect, test } from 'vitest';

/** The two surfaces that must name no graphics API, since one class serves every backend through them. */
const NEUTRAL = [
    { file: 'src/renderer/core/device-backend.ts', name: 'DeviceBackend' },
    { file: 'src/renderer/core/renderer.ts', name: 'Renderer' },
];

/** A backend type in a neutral signature either widens away its own union or forces a cast on the caller. */
const BACKEND_TYPES = /\b(GPU[A-Z]\w*|WebGL\w*|WebGPU\w*)\b/;

function membersOf(file: string, name: string): { member: string; type: string }[] {
    const program = ts.createProgram([file], {
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true,
        noEmit: true,
        strict: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`[neutral-contract] cannot read ${file}`);

    const out: { member: string; type: string }[] = [];
    const visit = (node: ts.Node): void => {
        const isTarget = (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.getText(source) === name;
        if (isTarget) {
            for (const member of node.members) {
                if (!member.name) continue;
                if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword))
                    continue;
                const symbol = checker.getSymbolAtLocation(member.name);
                if (!symbol) continue;
                out.push({
                    member: member.name.getText(source),
                    type: checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, member)),
                });
            }
        }
        node.forEachChild(visit);
    };
    visit(source);
    if (out.length === 0) throw new Error(`[neutral-contract] no members found on ${name}`);
    return out;
}

test('no graphics API leaks into the neutral surfaces the one Renderer serves every backend through', () => {
    const leaks: string[] = [];
    for (const { file, name } of NEUTRAL) {
        for (const { member, type } of membersOf(file, name)) {
            if (BACKEND_TYPES.test(type)) leaks.push(`${name}.${member}: ${type}`);
        }
    }
    expect(leaks).toEqual([]);
});

/**
 * Every member the two neutral surfaces carry. A widened signature leaks no backend type and so slips
 * past the check above: layer 6.30 put `hasFeature(feature: string)` on `DeviceBackend`, throwing away
 * WebGPU's `GPUFeatureName` union to fit, and nothing noticed for six layers. An addition has to be
 * listed here, which is where the argument for it gets made.
 */
const EXPECTED: Record<string, string[]> = {
    DeviceBackend: ['init', 'dispose', 'compileObjects', 'compileCompute', 'readPixels', 'readMemoryStats'],
    Renderer: [
        'backend',
        '_initialized',
        '_isDeviceLost',
        '_frameState',
        '_renderContexts',
        '_computeContext',
        '_nodes',
        '_renderObjects',
        '_renderLists',
        'info',
        'onDeviceLost',
        'inspector',
        'api',
        'init',
        'dispose',
        '_assertInitialized',
        '_beginInfoFrame',
    ],
};

test('a member added to a neutral surface is listed, so widening one to fit cannot pass unremarked', () => {
    for (const { file, name } of NEUTRAL) {
        const actual = membersOf(file, name).map((m) => m.member);
        expect(
            actual.filter((m) => !EXPECTED[name].includes(m)),
            `unlisted on ${name}`,
        ).toEqual([]);
        expect(
            EXPECTED[name].filter((m) => !actual.includes(m)),
            `listed but gone from ${name}`,
        ).toEqual([]);
    }
});
