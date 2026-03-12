import { Texture } from './texture';

/**
 * A texture created from a video element.
 * Automatically updates each frame.
 */
export class VideoTexture extends Texture<HTMLVideoElement> {
    readonly isVideoTexture = true;

    constructor(video: HTMLVideoElement) {
        super(video, {
            generateMipmaps: false,
            flipY: false,
        });
    }

    /**
     * Call this each frame to check if the video needs updating.
     * Sets needsUpdate if the video is playing and has new data.
     */
    update(): void {
        const video = this.image;
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
            this.needsUpdate = true;
        }
    }
}
