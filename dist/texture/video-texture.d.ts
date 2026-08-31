import { Texture } from './texture';
/**
 * A texture created from a video element.
 * Automatically updates each frame.
 *
 * No region API of its own, deliberately: a video replaces its whole frame every frame, so partial
 * upload has nothing to save. `addUpdateRegion` is inherited from {@link Texture} and stays correct
 * (the renderer serves it with a full upload for a DOM source), it is simply never the cheaper path.
 */
export declare class VideoTexture extends Texture<HTMLVideoElement> {
    readonly isVideoTexture = true;
    constructor(video: HTMLVideoElement);
    /**
     * Call this each frame to check if the video needs updating.
     * Sets needsUpdate if the video is playing and has new data.
     */
    update(): void;
}
