import { expect, test } from 'vitest';
import { GpuSampler } from '../src/core/gpu-sampler';

/** The key is kept between reads, and follows any setting changed after one: a stale key would share a wrong GPUSampler. */
test('settingsKey follows every setting changed after it was read', () => {
    const sampler = new GpuSampler();
    const first = sampler.settingsKey;
    expect(sampler.settingsKey).toBe(first);

    const changes: ((s: GpuSampler) => void)[] = [
        (s) => (s.minFilter = 'nearest'),
        (s) => (s.magFilter = 'nearest'),
        (s) => (s.mipmapFilter = 'nearest'),
        (s) => (s.addressModeU = 'repeat'),
        (s) => (s.addressModeV = 'repeat'),
        (s) => (s.addressModeW = 'repeat'),
        (s) => (s.maxAnisotropy = 4),
        (s) => (s.lodMinClamp = 1),
        (s) => (s.lodMaxClamp = 8),
        (s) => (s.compare = 'less'),
    ];
    let before = first;
    for (const change of changes) {
        change(sampler);
        const after = sampler.settingsKey;
        expect(after).not.toBe(before);
        expect(after).toBe(new GpuSampler({ ...sampler }).settingsKey);
        before = after;
    }
});
