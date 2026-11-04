import { expect, test } from 'vitest';
import type { TextureEntry } from '../src/nodes/builder';
import {
    createTextureHomes,
    FIRST_HOME,
    HOME_COUNT,
    linkProgramUnits,
    type ProgramUnits,
    releaseProgramUnits,
    type TextureHomes,
    unitOf,
} from '../src/renderer/webgl/texture-homes';

/** A program's texture entry for the texture `id`, as the emitter numbers it. */
function entry(id: string, binding: number, storage = false): TextureEntry {
    return {
        textureId: id,
        shaderName: id,
        binding,
        node: { slot: null, storageBufferSource: storage ? { bytesPerTexel: 16 } : null },
    } as unknown as TextureEntry;
}

/** A program reading `ids`, numbered from 0 as the emitter does. */
const program = (homes: TextureHomes, ...ids: string[]) =>
    linkProgramUnits(
        homes,
        ids.map((id, index) => entry(id, index)),
    );

const unitsOf = (units: ProgramUnits, ids: readonly string[]) => ids.map((id) => unitOf(units, id, -1));

test('programs reading one texture find it at one home, above the units a program numbers itself', () => {
    const homes = createTextureHomes(32);
    const terrain = program(homes, 'atlas', 'shadow');
    const water = program(homes, 'shadow', 'foam', 'atlas');
    expect(unitOf(terrain, 'atlas', -1)).toBe(unitOf(water, 'atlas', -1));
    expect(unitOf(terrain, 'shadow', -1)).toBe(unitOf(water, 'shadow', -1));
    for (const unit of unitsOf(water, ['shadow', 'foam', 'atlas'])) expect(unit).toBeGreaterThanOrEqual(FIRST_HOME);
    expect(new Set(unitsOf(water, ['shadow', 'foam', 'atlas'])).size).toBe(3);
});

test('a storage read binds at a unit the program numbers itself, from 0', () => {
    const homes = createTextureHomes(32);
    const units = linkProgramUnits(homes, [entry('atlas', 0), entry('particles', 1, true)]);
    expect(unitOf(units, 'particles', -1)).toBe(0);
    expect(unitOf(units, 'atlas', -1)).toBeGreaterThanOrEqual(FIRST_HOME);
});

test('a device with fewer than 32 units keeps the units the emitter numbered', () => {
    const homes = createTextureHomes(16);
    const units = program(homes, 'atlas', 'shadow');
    expect(unitsOf(units, ['atlas', 'shadow'])).toEqual([0, 1]);
});

test('a home sharing a unit with one a new program also reads moves to a unit neither of their readers uses', () => {
    const homes = createTextureHomes(32);
    const singles = Array.from({ length: HOME_COUNT }, (_, index) => program(homes, `single-${index}`));
    // every unit is held, so the next home shares one
    const late = program(homes, 'late');
    const shared = singles.find((units) => unitOf(units, `single-${singles.indexOf(units)}`, -1) === unitOf(late, 'late', -1))!;
    const sharedId = `single-${singles.indexOf(shared)}`;
    const both = program(homes, 'late', sharedId);
    const [lateUnit, sharedUnit] = unitsOf(both, ['late', sharedId]);
    expect(lateUnit).not.toBe(sharedUnit);
    // the moved home reads at its new unit in the program that placed it first, too
    expect(unitOf(late, 'late', -1)).toBe(lateUnit);
});

test('a program past 16 units of its own fails at link, naming the counts', () => {
    const homes = createTextureHomes(32);
    const storage = Array.from({ length: 17 }, (_, index) => entry(`buffer-${index}`, index, true));
    expect(() => linkProgramUnits(homes, storage)).toThrow(/more than 16 of its own/);
});

test('releasing every program leaves no homes, and the next scene colours from empty', () => {
    const homes = createTextureHomes(32);
    const first = [program(homes, 'a', 'b'), program(homes, 'b', 'c')];
    for (const units of first) releaseProgramUnits(homes, units);
    expect(homes.idToHome.size).toBe(0);
    expect(homes.unitHolders.every((holders) => holders.length === 0)).toBe(true);
    const next = program(homes, 'd');
    expect(unitOf(next, 'd', -1)).toBe(FIRST_HOME);
});

test('however programs link and go, every live program reads its textures on distinct units', () => {
    // a small deterministic generator, so a failure replays
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const homes = createTextureHomes(32);
    const live: { units: ProgramUnits; ids: string[] }[] = [];
    const clashes: string[] = [];
    for (let step = 0; step < 3000; step++) {
        if (live.length > 0 && random() < 0.45) {
            const [gone] = live.splice(Math.floor(random() * live.length), 1);
            releaseProgramUnits(homes, gone!.units);
        } else {
            const count = 1 + Math.floor(random() * 10);
            const ids = new Set<string>();
            while (ids.size < count) ids.add(`t${Math.floor(random() * 60)}`);
            live.push({ units: program(homes, ...ids), ids: [...ids] });
        }
        for (const { units, ids } of live) {
            const read = unitsOf(units, ids);
            if (new Set(read).size !== ids.length) clashes.push(`step ${step}: ${ids.join(',')} at ${read.join(',')}`);
        }
    }
    expect(clashes).toEqual([]);
    for (const { units } of live.splice(0)) releaseProgramUnits(homes, units);
    expect(homes.idToHome.size).toBe(0);
});
