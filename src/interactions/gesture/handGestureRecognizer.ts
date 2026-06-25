/**
 * HandGestureRecognizer - manages webcam and MediaPipe hand detection
 */

import visionBundleUrl from "@mediapipe/tasks-vision?url";
import { fetchWithProgress } from "../../utils/downloadProgress";

const WASM_PATH = "/mediapipe/wasm";
const VISION_LIBRARY_URL = visionBundleUrl;
const MODEL_ASSET_PATH = "/mediapipe/hand_landmarker.task";

export interface GestureResults {
  landmarks: unknown[][];
  handedness: unknown[][];
  gestures: unknown;
}

export class HandGestureRecognizer {
  private worker: Worker | null;
  private workerReady: boolean;
  private initializingPromise: Promise<void> | null;
  private resolveInit: (() => void) | null;
  private rejectInit: ((error: Error) => void) | null;

  private video: HTMLVideoElement | null;
  private stream: MediaStream | null;
  private running: boolean;
  private detectRaf: number;
  private lastVideoTime: number;

  onResults: ((results: GestureResults) => void) | null;
  onProgress: ((percent: number, label: string) => void) | null;
  private inferencePending: boolean;
  private _autoAdvanceTimer: ReturnType<typeof setInterval> | null;
  private _preloadedTaskBlobUrl: string | null;

  private handleWorkerMessage: (event: MessageEvent) => void;
  private handleWorkerError: (event: ErrorEvent) => void;

  constructor() {
    this.worker = null;
    this.workerReady = false;
    this.initializingPromise = null;
    this.resolveInit = null;
    this.rejectInit = null;

    this.video = null;
    this.stream = null;
    this.running = false;
    this.detectRaf = 0;
    this.lastVideoTime = -1;

    this.onResults = null;
    this.onProgress = null;
    this.inferencePending = false;
    this._autoAdvanceTimer = null;
    this._preloadedTaskBlobUrl = null;

    this.handleWorkerMessage = (event: MessageEvent) => {
      const message = event.data || {};

      if (message.type === "ready") {
        this._stopAutoAdvance();
        this.workerReady = true;
        this.initializingPromise = null;
        const usedDelegate = message.payload?.delegate || "CPU";
        console.info(`[HandGestureRecognizer] Initialized with ${usedDelegate} delegate.`);
        this.onProgress?.(100, "Ready");
        if (this.resolveInit) {
          this.resolveInit();
          this.resolveInit = null;
          this.rejectInit = null;
        }
        return;
      }

      if (message.type === "progress") {
        const payload = message.payload || {};
        if (payload.percent !== undefined) {
          const pct = 50 + Math.round((payload.percent / 100) * 45);
          this.onProgress?.(pct, `Loading ${payload.fileName || "model"}...`);
        }
        return;
      }

      if (message.type === "result") {
        this.inferencePending = false;
        if (this.onResults) {
          this.onResults(message.payload || { landmarks: [], handedness: [], gestures: null });
        }
        return;
      }

      if (message.type === "error") {
        this._stopAutoAdvance();
        this.inferencePending = false;
        const workerError = new Error(message.payload?.message || "Worker inference failed.");
        if (this.rejectInit) {
          this.rejectInit(workerError);
          this.resolveInit = null;
          this.rejectInit = null;
          this.initializingPromise = null;
          return;
        }
        console.error("Gesture worker error:", workerError);
      }
    };

    this.handleWorkerError = (event: ErrorEvent) => {
      this._stopAutoAdvance();
      this.inferencePending = false;
      this.workerReady = false;
      const workerError =
        event?.error instanceof Error
          ? event.error
          : new Error(event?.message || "Unknown worker error.");

      if (this.rejectInit) {
        this.rejectInit(workerError);
        this.resolveInit = null;
        this.rejectInit = null;
        this.initializingPromise = null;
        return;
      }

      console.error("Gesture worker crashed:", workerError);
    };
  }

  async initialize(): Promise<void> {
    if (this.workerReady && this.worker) {
      this.onProgress?.(100, "Already initialized");
      return;
    }

    if (this.initializingPromise) {
      return this.initializingPromise;
    }

    if (typeof Worker === "undefined") {
      throw new Error("Current browser does not support Web Worker.");
    }

    if (!this.worker) {
      this.worker = new Worker(new URL("./handLandmarker.worker.ts", import.meta.url));
      this.worker.addEventListener("message", this.handleWorkerMessage);
      this.worker.addEventListener("error", this.handleWorkerError);
    }

    this.initializingPromise = (async () => {
      try {
        const mjsText = await this._prefetchMjs();
        const taskBlobUrl = await this._prefetchTask();
        this._preloadedTaskBlobUrl = taskBlobUrl;

        this._startAutoAdvance();

        return new Promise<void>((resolve, reject) => {
          this.resolveInit = resolve;
          this.rejectInit = reject;
          this.worker!.postMessage({
            type: "init",
            payload: {
              libraryText: mjsText,
              wasmPath: WASM_PATH,
              modelAssetPath: taskBlobUrl,
              preferredDelegate: "GPU",
            },
          });
        });
      } catch (error) {
        this.initializingPromise = null;
        this._stopAutoAdvance();
        throw error;
      }
    })();

    return this.initializingPromise;
  }

  private async _prefetchMjs(): Promise<string> {
    this.onProgress?.(0, "Loading vision library...");
    const response = await fetch(VISION_LIBRARY_URL);
    if (!response.ok) {
      throw new Error(`Failed to load vision library: ${response.status}`);
    }
    const text = await response.text();
    this.onProgress?.(20, "Vision library loaded");
    return text;
  }

  private async _prefetchTask(): Promise<string> {
    this.onProgress?.(20, "Loading hand detection model...");
    const blob = await fetchWithProgress(MODEL_ASSET_PATH, (progress) => {
      const overall = 20 + Math.round((progress.percent / 100) * 30);
      this.onProgress?.(overall, `Loading hand model... ${progress.percent}%`);
    });
    const blobUrl = URL.createObjectURL(blob);
    this.onProgress?.(50, "Initializing MediaPipe...");
    return blobUrl;
  }

  private _startAutoAdvance(): void {
    this._stopAutoAdvance();
    let current = 50;
    this._autoAdvanceTimer = setInterval(() => {
      if (current < 95) {
        current += Math.random() * 3 + 1;
        if (current > 95) current = 95;
        this.onProgress?.(Math.round(current), "Loading processing engine...");
      }
    }, 400);
  }

  private _stopAutoAdvance(): void {
    if (this._autoAdvanceTimer) {
      clearInterval(this._autoAdvanceTimer);
      this._autoAdvanceTimer = null;
    }
  }

  async startCamera(): Promise<void> {
    if (this.stream) {
      return;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960, max: 960 },
        height: { ideal: 540, max: 960 },
        frameRate: { ideal: 30, max: 30 },
        facingMode: "user",
      },
    });

    this.video = document.createElement("video");
    this.video.srcObject = this.stream;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    await new Promise((resolve) => {
      this.video!.onloadeddata = resolve;
    });
    await this.video.play();
  }

  stopCamera(): void {
    this.running = false;
    this.inferencePending = false;
    this.lastVideoTime = -1;

    if (this.detectRaf) {
      cancelAnimationFrame(this.detectRaf);
      this.detectRaf = 0;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
  }

  startDetection(): void {
    if (!this.workerReady || !this.worker) {
      return;
    }

    this.running = true;

    const detect = async () => {
      if (!this.running || !this.video || !this.workerReady || !this.worker) {
        this.detectRaf = 0;
        return;
      }

      if (
        this.video.currentTime !== this.lastVideoTime &&
        !this.inferencePending &&
        this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        this.lastVideoTime = this.video.currentTime;

        try {
          this.inferencePending = true;
          const frame = await createImageBitmap(this.video);

          if (!this.running || !this.worker) {
            frame.close();
            this.inferencePending = false;
          } else {
            this.worker.postMessage(
              {
                type: "detect",
                payload: {
                  frame,
                  timestamp: performance.now(),
                },
              },
              [frame]
            );
          }
        } catch (error) {
          this.inferencePending = false;
          console.error("Failed to transfer video frame to gesture worker:", error);
        }
      }

      this.detectRaf = requestAnimationFrame(detect);
    };
    this.detectRaf = requestAnimationFrame(detect);
  }

  dispose(): void {
    this._stopAutoAdvance();
    this.stopCamera();
    if (this._preloadedTaskBlobUrl) {
      try {
        URL.revokeObjectURL(this._preloadedTaskBlobUrl);
      } catch {
        // ignore
      }
      this._preloadedTaskBlobUrl = null;
    }
    if (this.worker) {
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.removeEventListener("error", this.handleWorkerError);

      try {
        this.worker.postMessage({ type: "dispose" });
      } catch (error) {
        console.warn("Failed to dispose gesture worker cleanly:", error);
      }

      this.worker.terminate();
      this.worker = null;
    }

    this.workerReady = false;
    this.initializingPromise = null;
    this.resolveInit = null;
    this.rejectInit = null;
  }
}
