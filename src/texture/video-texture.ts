import { Texture } from './texture';

/**
 * A texture created from a video element.
 * Automatically updates each frame.
 */
export class VideoTexture extends Texture {
    readonly isVideoTexture = true;

    constructor(video: HTMLVideoElement) {
        super(video);

        // video textures need frequent updates
        this.generateMipmaps = false;
        this.flipY = false;
    }

    /**
     * Call this each frame to check if the video needs updating.
     * Sets needsUpdate if the video is playing and has new data.
     */
    update(): void {
        const video = this.source.data as HTMLVideoElement;
        if (video && video.readyState >= video.HAVE_CURRENT_DATA) {
            this.needsUpdate = true;
        }
    }
}
