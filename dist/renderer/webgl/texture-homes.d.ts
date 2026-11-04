import type { TextureEntry } from '../../nodes/builder';
export declare const FIRST_HOME = 16;
export declare const HOME_COUNT = 15;
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
export declare function createTextureHomes(maxCombinedUnits: number): TextureHomes;
/**
 * The units a program linked for `textures` binds them at: a home for each texture bound by identity, which keeps its
 * unit or takes one its neighbours leave free, and units of its own from 0 for the rest. Throws when those pass 15.
 */
export declare function linkProgramUnits(homes: TextureHomes, textures: readonly TextureEntry[]): ProgramUnits;
/** The unit a program binds `shaderName` at. */
export declare function unitOf(units: ProgramUnits, shaderName: string, fallback: number): number;
/** A program is deleted: its homes stop counting it, and one read by none is freed. */
export declare function releaseProgramUnits(homes: TextureHomes, units: ProgramUnits): void;
/** Every home forgotten, with the programs reading them (renderer dispose). */
export declare function clearTextureHomes(homes: TextureHomes): void;
export declare function getTextureHomeStats(homes: TextureHomes): {
    homes: number;
    unitsHeld: number;
};
