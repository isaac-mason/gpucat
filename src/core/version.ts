// One counter every versioned value draws from, so no two versions are equal: a stamp of plain numbers then also tells
// one uniform or object from another that replaced it, and a record of what was packed can never match by accident.
let lastVersion = 0;

/** A version no value has held before. */
export function nextVersion(): number {
    return ++lastVersion;
}
