// @vitest-environment jsdom
import { expect, test } from 'vitest';
import type { Inspector } from '../src/inspector/inspector';
import { SceneHierarchy } from '../src/inspector/tabs/scene-hierarchy';

/**
 * `drawScene` is the only producer of a `SceneRecord`, so a pass that records its draws directly has
 * no tree to walk. Showing nothing made the tab read as if the pass never ran, which is the failure
 * this covers; the draws themselves live in Draw Calls and are not duplicated here.
 */
const inspector = null as unknown as Inspector;

function rowText(tab: SceneHierarchy): string[] {
    return Array.from(tab.list.domElement.querySelectorAll('.hierarchy-name'), (el) => el.textContent ?? '');
}

test('a pass with no tree still gets a row, naming its draw count', () => {
    const tab = new SceneHierarchy();

    tab.update(inspector, [], [{ passId: 'voxels', drawCount: 3 }]);

    const rows = rowText(tab);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('voxels');
    expect(rows[0]).toContain('3 draws');
    expect(rows[0]).toContain('Draw Calls');
});

test('one draw reads as one draw, not "1 draws"', () => {
    const tab = new SceneHierarchy();
    tab.update(inspector, [], [{ passId: 'overlay', drawCount: 1 }]);
    expect(rowText(tab)[0]).toContain('1 draw,');
});

test('a pass that stops drawing loses its row', () => {
    const tab = new SceneHierarchy();

    tab.update(inspector, [], [{ passId: 'voxels', drawCount: 3 }]);
    expect(rowText(tab)).toHaveLength(1);

    tab.update(inspector, [], []);
    expect(rowText(tab)).toHaveLength(0);
});
