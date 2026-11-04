import type { TextureEntry } from '../../nodes/builder';

// A texture that programs agree on (bound by identity, so its binding id names it in every program) gets a home: a
// texture unit it keeps renderer-wide, so a program switch finds it already bound instead of rebinding it at whatever
// unit the next program numbered it. Godot reserves the top units for scene textures the same way; wgpu's GL backend
// keeps bindings across pipeline switches where their slots agree.
//
// Homes are units 16 to 30: below them a program numbers what has no home (a storage read, which binds per draw, or a
// texture no home could take), and 31 is the upload unit. Assignment colours an interference graph incrementally, at
// link: two homes read by one live program are neighbours, and a home only takes a unit none of whose holders is a
// neighbour of it. So every live program reads its homes on distinct units, however homes move as programs link. A
// home counts the live programs reading it and is freed at none, so after a scene switch the table holds only the
// new scene's textures.

export const FIRST_HOME = 16;
export const HOME_COUNT = 15;
/** Units a program numbers itself, below the homes. */
const OWN_UNITS = FIRST_HOME;

export type TextureHome = {
    /** The binding id every program reading it declares it by. */
    readonly id: string;
    /** Its unit, or -1 while no unit could take it. */
    unit: number;
    /** Live programs reading it at its unit. */
    readers: number;
    /** Homes read with it by a live program, and by how many. */
    neighbours: Map<TextureHome, number>;
};

export type TextureHomes = {
    /** False on a device with fewer than 32 combined units: every program numbers its own, as the emitter did. */
    enabled: boolean;
    idToHome: Map<string, TextureHome>;
    /** The homes on each unit, from {@link FIRST_HOME}. */
    unitHolders: TextureHome[][];
};

/** What one program binds each of its textures at: its home, or a unit of its own. */
export type ProgramUnits = {
    /** By shader name. */
    nameToHome: Map<string, TextureHome>;
    nameToUnit: Map<string, number>;
    /** The homes it reads, released with it. */
    homes: TextureHome[];
};

export function createTextureHomes(maxCombinedUnits: number): TextureHomes {
    return {
        enabled: maxCombinedUnits >= FIRST_HOME + HOME_COUNT + 1,
        idToHome: new Map(),
        unitHolders: Array.from({ length: HOME_COUNT }, () => []),
    };
}

/**
 * The units a program linked for `textures` binds them at: a home for each texture bound by identity, which keeps its
 * unit or takes one its neighbours leave free, and units of its own from 0 for the rest. Throws when those pass 15.
 */
export function linkProgramUnits(homes: TextureHomes, textures: readonly TextureEntry[]): ProgramUnits {
    const units: ProgramUnits = { nameToHome: new Map(), nameToUnit: new Map(), homes: [] };
    const candidates: TextureHome[] = [];
    for (const entry of textures) {
        if (!homes.enabled || !boundByIdentity(entry) || units.nameToUnit.has(entry.shaderName)) continue;
        let home = homes.idToHome.get(entry.textureId);
        if (home === undefined) {
            home = { id: entry.textureId, unit: -1, readers: 0, neighbours: new Map() };
            homes.idToHome.set(entry.textureId, home);
        }
        if (!candidates.includes(home)) candidates.push(home);
    }

    const taken = new Set<number>();
    for (const home of candidates) {
        if (home.unit < 0 || taken.has(home.unit)) placeHome(homes, home, candidates, taken);
        // with nowhere to go, a home placed elsewhere stays there for its readers and this program numbers it itself
        if (home.unit < 0 || taken.has(home.unit)) continue;
        taken.add(home.unit);
        units.homes.push(home);
    }
    for (const home of units.homes) {
        home.readers++;
        for (const other of units.homes) if (other !== home) home.neighbours.set(other, (home.neighbours.get(other) ?? 0) + 1);
    }

    let own = 0;
    for (const entry of textures) {
        if (units.nameToUnit.has(entry.shaderName)) continue;
        const home = boundByIdentity(entry) ? homes.idToHome.get(entry.textureId) : undefined;
        if (home !== undefined && units.homes.includes(home)) {
            units.nameToHome.set(entry.shaderName, home);
            units.nameToUnit.set(entry.shaderName, -1);
            continue;
        }
        if (own === OWN_UNITS) {
            throw new Error(
                `[webgl] a program samples ${textures.length} textures, ${units.homes.length} at shared units and more than ` +
                    `${OWN_UNITS} of its own; sample fewer in one material on the WebGL2 backend.`,
            );
        }
        units.nameToUnit.set(entry.shaderName, homes.enabled ? own++ : entry.binding);
    }
    // a home no program could place, read by none, goes
    for (const home of candidates) if (home.readers === 0 && home.unit < 0) homes.idToHome.delete(home.id);
    return units;
}

/** The unit a program binds `shaderName` at. */
export function unitOf(units: ProgramUnits, shaderName: string, fallback: number): number {
    const home = units.nameToHome.get(shaderName);
    if (home !== undefined) return home.unit;
    return units.nameToUnit.get(shaderName) ?? fallback;
}

/** A program is deleted: its homes stop counting it, and one read by none is freed. */
export function releaseProgramUnits(homes: TextureHomes, units: ProgramUnits): void {
    for (const home of units.homes) {
        home.readers--;
        for (const other of units.homes) {
            if (other === home) continue;
            const count = (home.neighbours.get(other) ?? 0) - 1;
            if (count > 0) home.neighbours.set(other, count);
            else home.neighbours.delete(other);
        }
    }
    for (const home of units.homes) {
        if (home.readers > 0) continue;
        if (home.unit >= 0) {
            const holders = homes.unitHolders[home.unit - FIRST_HOME]!;
            holders.splice(holders.indexOf(home), 1);
        }
        homes.idToHome.delete(home.id);
    }
    units.homes.length = 0;
}

/** Every home forgotten, with the programs reading them (renderer dispose). */
export function clearTextureHomes(homes: TextureHomes): void {
    homes.idToHome.clear();
    for (const holders of homes.unitHolders) holders.length = 0;
}

export function getTextureHomeStats(homes: TextureHomes): { homes: number; unitsHeld: number } {
    let unitsHeld = 0;
    for (const holders of homes.unitHolders) if (holders.length > 0) unitsHeld++;
    return { homes: homes.idToHome.size, unitsHeld };
}

/** A texture every program reading it names by the same binding id: not a storage read, which binds per draw. */
function boundByIdentity(entry: TextureEntry): boolean {
    return entry.node.slot === null && entry.node.storageBufferSource === null;
}

/**
 * Moves `home` to a unit the linking program has not taken and none of whose holders is a neighbour of it or another
 * home the program reads: an empty unit first, else the one with the fewest holders. Leaves it where it is (or
 * unplaced) when there is none.
 */
function placeHome(homes: TextureHomes, home: TextureHome, programHomes: readonly TextureHome[], taken: Set<number>): void {
    let best = -1;
    let bestHolders = Infinity;
    for (let index = 0; index < HOME_COUNT; index++) {
        const unit = FIRST_HOME + index;
        if (taken.has(unit)) continue;
        const holders = homes.unitHolders[index]!;
        if (holders.length >= bestHolders) continue;
        let clashes = false;
        for (const holder of holders) {
            if (holder !== home && (home.neighbours.has(holder) || programHomes.includes(holder))) {
                clashes = true;
                break;
            }
        }
        if (clashes) continue;
        best = unit;
        bestHolders = holders.length;
        if (bestHolders === 0) break;
    }
    if (best < 0) return;
    if (home.unit >= 0) {
        const holders = homes.unitHolders[home.unit - FIRST_HOME]!;
        holders.splice(holders.indexOf(home), 1);
    }
    home.unit = best;
    homes.unitHolders[best - FIRST_HOME]!.push(home);
}
