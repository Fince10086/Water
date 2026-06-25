/**
 * handLandmarker.worker.ts
 * Web Worker for MediaPipe HandLandmarker hand detection
 * Simplified output: per-hand pinch state and center position.
 */

declare function importScripts(...urls: string[]): void;

const PINCH_ENTER_THRESHOLD = 0.08;
const PINCH_EXIT_THRESHOLD = 0.12;
const COOLDOWN_MS = 10;
const VISION_LIBRARY_URL = "/mediapipe/vision_bundle.mjs";

let handLandmarker: unknown = null;
let initialized = false;
let FilesetResolverRef: unknown = null;
let HandLandmarkerRef: unknown = null;

let _originalFetch: typeof fetch | null = null;
let _fetchPatched = false;

interface PinchState {
  pinching: boolean;
  x: number;
  y: number;
}

const pinchState: Record<number, PinchState> = {};
const pinchSmoothAlpha = 0.2;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data || {};

  if (message.type === "init") {
    await initialize(message.payload || {});
    return;
  }

  if (message.type === "detect") {
    await detectFrame(message.payload || {});
    return;
  }

  if (message.type === "dispose") {
    dispose();
  }
};

function installFetchInterceptor(): void {
  if (_fetchPatched) return;
  _originalFetch = self.fetch.bind(self);
  _fetchPatched = true;

  self.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    const response = await _originalFetch!(input, init);

    const contentLength = response.headers.get("content-length");
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    if (total > 0 && response.body) {
      const reader = response.body.getReader();
      let loaded = 0;
      const chunks: Uint8Array<ArrayBuffer>[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.length;

        const fileName = url.split("/").pop() || url;
        self.postMessage({
          type: "progress",
          payload: {
            fileName,
            loaded,
            total,
            percent: Math.round((loaded / total) * 100),
          },
        });
      }

      const blob = new Blob(chunks);
      return new Response(blob, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    return response;
  };
}

function restoreFetch(): void {
  if (!_fetchPatched || !_originalFetch) return;
  self.fetch = _originalFetch;
  _fetchPatched = false;
}

async function initialize(payload: Record<string, unknown>): Promise<void> {
  if (initialized && handLandmarker) {
    self.postMessage({ type: "ready", payload: { delegate: (payload.activeDelegate as string) || "CPU" } });
    return;
  }

  const wasmPath = (payload.wasmPath as string) || "/mediapipe/wasm";
  const modelAssetPath = (payload.modelAssetPath as string) || "/mediapipe/hand_landmarker.task";

  const preferred = (payload.preferredDelegate as string) || "GPU";
  const delegatesToTry = preferred === "GPU" ? ["GPU", "CPU"] : [preferred];

  try {
    installFetchInterceptor();

    await ensureVisionLoaded(payload);

    self.postMessage({
      type: "progress",
      payload: {
        fileName: "model",
        loaded: 0,
        total: 0,
        percent: 0,
        label: "loading_wasm",
      },
    });

    const vision = await (FilesetResolverRef as { forVisionTasks(path: string): Promise<unknown> }).forVisionTasks(wasmPath);

    self.postMessage({
      type: "progress",
      payload: {
        fileName: "model",
        loaded: 0,
        total: 0,
        percent: 0,
        label: "loading_model",
      },
    });

    let lastError: Error | null = null;
    for (const delegate of delegatesToTry) {
      try {
        if (handLandmarker) {
          (handLandmarker as { close(): void }).close();
          handLandmarker = null;
        }

        handLandmarker = await (HandLandmarkerRef as {
          createFromOptions(vision: unknown, options: unknown): Promise<unknown>;
        }).createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate,
          },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.8,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });

        restoreFetch();
        initialized = true;
        self.postMessage({ type: "ready", payload: { delegate } });
        return;
      } catch (delegateError) {
        lastError = delegateError as Error;
        const msg = delegateError instanceof Error ? delegateError.message : String(delegateError);
        console.warn(`[HandLandmarkerWorker] ${delegate} delegate failed, falling back...`, msg);
      }
    }

    restoreFetch();
    throw lastError || new Error("All delegates failed.");
  } catch (error) {
    restoreFetch();
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", payload: { message } });
  }
}

async function ensureVisionLoaded(payload: Record<string, unknown>): Promise<void> {
  if (FilesetResolverRef && HandLandmarkerRef) {
    return;
  }

  const libraryUrl = (payload.libraryUrl as string) || VISION_LIBRARY_URL;

  const looksLikeModuleBundle = typeof libraryUrl === "string" && /\.mjs(?:$|\?)/.test(libraryUrl);

  try {
    const visionApi = await import(/* @vite-ignore */ libraryUrl);
    FilesetResolverRef = visionApi.FilesetResolver;
    HandLandmarkerRef = visionApi.HandLandmarker;
  } catch (importError) {
    if (!looksLikeModuleBundle && typeof importScripts === "function") {
      importScripts(libraryUrl);
      const visionApi = (self as unknown as unknown as Record<string, unknown>).vision || self;
      FilesetResolverRef = (visionApi as unknown as Record<string, unknown>).FilesetResolver;
      HandLandmarkerRef = (visionApi as unknown as Record<string, unknown>).HandLandmarker;
    } else {
      throw importError;
    }
  }

  if (!FilesetResolverRef || !HandLandmarkerRef) {
    throw new Error("Failed to load @mediapipe/tasks-vision in worker context.");
  }
}

async function detectFrame(payload: Record<string, unknown>): Promise<void> {
  if (!initialized || !handLandmarker) {
    self.postMessage({
      type: "error",
      payload: { message: "HandLandmarker worker is not initialized." },
    });
    return;
  }

  const frame = payload.frame as ImageBitmap;
  const timestamp = (payload.timestamp as number) ?? performance.now();

  if (!frame) {
    self.postMessage({
      type: "error",
      payload: { message: "Missing frame payload for detection." },
    });
    return;
  }

  try {
    const results = (handLandmarker as { detectForVideo(frame: ImageBitmap, timestamp: number): { landmarks: unknown[]; handedness: unknown[] } }).detectForVideo(frame, timestamp);
    const gestures = parseGestures(results, timestamp);

    self.postMessage({
      type: "result",
      payload: {
        landmarks: results.landmarks || [],
        handedness: results.handedness || [],
        gestures,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ type: "error", payload: { message } });
  } finally {
    if (typeof (frame as { close?(): void }).close === "function") {
      (frame as { close(): void }).close();
    }
  }
}

function parseGestures(results: { landmarks: unknown[]; handedness: unknown[] }, _now = performance.now()) {
  const landmarks = results.landmarks || [];

  const pinches: Array<{ handIndex: number; pinching: boolean; x: number; y: number }> = [];

  landmarks.forEach((lm, handIndex) => {
    const hand = lm as Array<{ x: number; y: number; z: number }>;
    const pinchDist = getPinchDistance(hand);
    const wasPinching = pinchState[handIndex]?.pinching ?? false;
    const isPinching = updatePinchState(handIndex, pinchDist);
    const center = getPinchCenter(hand);
    const smoothed = smoothPinch(handIndex, center);

    pinches.push({
      handIndex,
      pinching: isPinching,
      x: smoothed.x,
      y: smoothed.y,
    });

    if (!isPinching && wasPinching) {
      delete pinchState[handIndex];
    }
  });

  return { pinches };
}

function getPinchDistance(landmarks: Array<{ x: number; y: number }>): number {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const dx = thumbTip.x - indexTip.x;
  const dy = thumbTip.y - indexTip.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getPinchCenter(landmarks: Array<{ x: number; y: number }>): { x: number; y: number } {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  return {
    x: (thumbTip.x + indexTip.x) / 2,
    y: (thumbTip.y + indexTip.y) / 2,
  };
}

function updatePinchState(handIndex: number, distance: number): boolean {
  const state = pinchState[handIndex];
  const isPinching = state?.pinching ?? false;

  if (!isPinching && distance < PINCH_ENTER_THRESHOLD) {
    pinchState[handIndex] = { pinching: true, x: 0, y: 0 };
    return true;
  }
  if (isPinching && distance < PINCH_EXIT_THRESHOLD) {
    return true;
  }
  if (isPinching && distance >= PINCH_EXIT_THRESHOLD) {
    if (state) state.pinching = false;
    return false;
  }
  return false;
}

function smoothPinch(handIndex: number, pos: { x: number; y: number }): { x: number; y: number } {
  const state = pinchState[handIndex];
  if (!state) {
    return pos;
  }
  if (state.x === 0 && state.y === 0) {
    state.x = pos.x;
    state.y = pos.y;
    return pos;
  }
  state.x = pinchSmoothAlpha * pos.x + (1 - pinchSmoothAlpha) * state.x;
  state.y = pinchSmoothAlpha * pos.y + (1 - pinchSmoothAlpha) * state.y;
  return { x: state.x, y: state.y };
}

function resetState(): void {
  Object.keys(pinchState).forEach((key) => delete pinchState[Number(key)]);
}

function dispose(): void {
  restoreFetch();
  if (handLandmarker) {
    (handLandmarker as { close(): void }).close();
    handLandmarker = null;
  }
  initialized = false;
  resetState();
  self.postMessage({ type: "disposed" });
}
