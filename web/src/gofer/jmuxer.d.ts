declare module "jmuxer" {
  export default class JMuxer {
    constructor(options: {
      node: HTMLVideoElement;
      mode: "video";
      flushingTime?: number;
      maxDelay?: number;
      clearBuffer?: boolean;
      fps?: number;
      debug?: boolean;
      onReady?: () => void;
      onError?: (error: unknown) => void;
    });
    feed(data: { video: Uint8Array; duration?: number }): void;
    destroy(): void;
  }
}
