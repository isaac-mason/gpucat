import { Texture } from './texture';
/**
 * A texture created from a video element.
 * Automatically updates each frame.
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
