/**
 * Audio Engine - 4-track player with Transport sync
 */

import * as Tone from "tone";
import {
  deepClone,
  rampParam,
  SOURCE_LIBRARY,
  EFFECT_LIBRARY,
  getTrackAudioUrl,
} from "../utils/helpers";
import { createTrackPlayerRuntime, type TrackPlayerRuntime } from "./runtimes/trackPlayerRuntime";
import { createEffectRuntime } from "./runtimes/effectRuntime";
import { connectSignalChain } from "./chain/signalChain";
import { fetchWithProgress, type DownloadProgress } from "../utils/downloadProgress";
import type { ModuleConfig, Preset, GlobalState } from "../types";

export class AudioEngine {
  app: Record<string, unknown>;
  ready: boolean;
  state: Preset | null;
  chainRuntimes: Map<number, Map<string, Record<string, unknown>>>;
  moduleRuntimes: Map<string, Record<string, unknown>>;
  masterVolume!: Tone.Volume;
  limiter!: Tone.Limiter;
  analyser!: Tone.Analyser;
  spectrumAnalyser!: Tone.Analyser;
  scopeMonoMix!: Tone.Gain;
  isPlaying: boolean;
  _progressCallback: (() => void) | null;
  _onDownloadProgress: ((progress: DownloadProgress) => void) | null;
  private _blobUrls: string[];

  constructor(app: Record<string, unknown>) {
    this.app = app;
    this.ready = false;
    this.state = null;
    this.chainRuntimes = new Map();
    this.moduleRuntimes = new Map();
    this.isPlaying = false;
    this._progressCallback = null;
    this._onDownloadProgress = null;
    this._blobUrls = [];
  }

  async start(state: Preset): Promise<void> {
    if (this.ready) {
      return;
    }

    await Tone.start();
    Tone.context.lookAhead = 0;
    this.state = deepClone(state);
    this.ready = true;

    this.masterVolume = new Tone.Volume(state.global.volume);
    this.limiter = new Tone.Limiter(-10);
    this.analyser = new Tone.Analyser("waveform", 1024);
    this.spectrumAnalyser = new Tone.Analyser("fft", 2048);

    this.masterVolume.connect(this.limiter);
    this.limiter.toDestination();

    this.scopeMonoMix = new Tone.Gain(1);
    this.scopeMonoMix.input.channelCount = 1;
    (this.scopeMonoMix.input as unknown as Record<string, unknown>).channelCountMode = "explicit";

    this.masterVolume.connect(this.scopeMonoMix);
    this.scopeMonoMix.connect(this.analyser);
    this.scopeMonoMix.connect(this.spectrumAnalyser);

    this.rebuildSignalChains();

    if (this.app && (this.app as Record<string, unknown>).modulationManager) {
      const mm = (this.app as Record<string, unknown>).modulationManager as Record<string, unknown>;
      if (typeof mm.connectAllModulations === "function") {
        mm.connectAllModulations();
      }
    }
  }

  onDownloadProgress(callback: (progress: DownloadProgress) => void): void {
    this._onDownloadProgress = callback;
  }

  async preloadAudio(): Promise<void> {
    this._cleanupBlobUrls();

    const chainCount = 4;
    let completedBytes = 0;
    let totalBytes = 0;
    const fileSizes: number[] = [];

    const urls = Array.from({ length: chainCount }, (_, i) => getTrackAudioUrl(i));

    const headResponses = await Promise.all(
      urls.map(async (url) => {
        try {
          const resp = await fetch(url, { method: "HEAD" });
          if (resp.ok) {
            const len = parseInt(resp.headers.get("content-length") || "0", 10);
            totalBytes += len;
            return len;
          }
        } catch {
          // ignore
        }
        return 0;
      })
    );
    fileSizes.push(...headResponses);

    for (let i = 0; i < urls.length; i++) {
      const blob = await fetchWithProgress(urls[i], (progress) => {
        const fileStart = fileSizes.slice(0, i).reduce((a, b) => a + b, 0);
        const currentLoaded = fileStart + progress.loaded;
        const pct = totalBytes > 0 ? Math.round((currentLoaded / totalBytes) * 100) : 0;
        if (this._onDownloadProgress) {
          this._onDownloadProgress({ loaded: currentLoaded, total: totalBytes, percent: pct });
        }
      });

      const blobUrl = URL.createObjectURL(blob);
      this._blobUrls.push(blobUrl);
    }
  }

  private _cleanupBlobUrls(): void {
    this._blobUrls.forEach((url) => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    });
    this._blobUrls = [];
  }

  getAnalyser(): Tone.Analyser {
    return this.analyser;
  }

  getSpectrumAnalyser(): Tone.Analyser {
    return this.spectrumAnalyser;
  }

  fullSync(state: Preset): void {
    this.state = deepClone(state);
    if (!this.ready) {
      return;
    }

    rampParam(this.masterVolume.volume, state.global.volume);
    this.rebuildSignalChains();

    if (this.app && (this.app as Record<string, unknown>).modulationManager) {
      const mm = (this.app as Record<string, unknown>).modulationManager as Record<string, unknown>;
      if (typeof mm.connectAllModulations === "function") {
        mm.connectAllModulations();
      }
    }
  }

  updateGlobal(globalState: GlobalState): void {
    this.state!.global = deepClone(globalState);
    if (!this.ready) {
      return;
    }
    rampParam(this.masterVolume.volume, globalState.volume);
  }

  isSourceModule(module: ModuleConfig): boolean {
    return module.category === "source" || SOURCE_LIBRARY[module.type] !== undefined;
  }

  getChainState(chainIndex: number): { enabled: boolean; modules: ModuleConfig[]; modulations: unknown[] } {
    const chains = Array.isArray(this.state?.chains) ? this.state.chains : [];
    return chains[chainIndex] || { enabled: false, modules: [], modulations: [] };
  }

  getChainRuntimeMap(chainIndex: number): Map<string, Record<string, unknown>> | null {
    return this.chainRuntimes.get(chainIndex) || null;
  }

  getModuleRuntime(chainIndex: number, moduleId: string): Record<string, unknown> | null {
    const map = this.getChainRuntimeMap(chainIndex);
    return map ? map.get(moduleId) || null : null;
  }

  getChainSourceLevel(chainIndex: number): number {
    const map = this.getChainRuntimeMap(chainIndex);
    if (!map) return 0;
    for (const [, runtime] of map) {
      const rt = runtime as Record<string, unknown>;
      if (rt.category === "source" && typeof rt.getLevel === "function") {
        return (rt.getLevel as () => number)();
      }
    }
    return 0;
  }

  disposeRuntimeMap(runtimeMap: Map<string, Record<string, unknown>> | null): void {
    if (!runtimeMap) {
      return;
    }
    runtimeMap.forEach((runtime) => {
      if ((runtime as Record<string, unknown>).dispose) {
        ((runtime as Record<string, unknown>).dispose as () => void)();
      }
    });
    runtimeMap.clear();
  }

  refreshCurrentRuntimeAlias(): void {
    const selectedChain = ((this.app as Record<string, unknown>)?.getSelectedChainIndex as () => number)?.() ?? 0;
    this.moduleRuntimes = this.getChainRuntimeMap(selectedChain) || new Map();
  }

  rebuildSignalChains(): void {
    if (!this.masterVolume) {
      return;
    }

    this.chainRuntimes.forEach((runtimeMap) => {
      this.disposeRuntimeMap(runtimeMap);
    });
    this.chainRuntimes.clear();

    const chains = Array.isArray(this.state?.chains) ? this.state.chains : [];
    chains.forEach((chain, chainIndex) => {
      const modules = Array.isArray(chain?.modules) ? chain.modules : [];
      if (!chain?.enabled) {
        return;
      }

      const runtimeMap = new Map<string, Record<string, unknown>>();

      // Create runtimes for all enabled modules
      modules.forEach((module) => {
        if (!module.enabled) return;
        const runtime = this.createModuleRuntime(module, chainIndex);
        runtimeMap.set(module.id, runtime);
      });

      // Connect signal chain
      connectSignalChain({
        modules,
        runtimeMap,
        masterVolume: this.masterVolume,
        isSourceModule: (m) => this.isSourceModule(m),
      });

      this.chainRuntimes.set(chainIndex, runtimeMap);
    });

    this.refreshCurrentRuntimeAlias();
  }

  createModuleRuntime(module: ModuleConfig, chainIndex: number): Record<string, unknown> {
    if (this.isSourceModule(module)) {
      const blobUrl = this._blobUrls[chainIndex];
      const url = blobUrl || getTrackAudioUrl(chainIndex);
      return createTrackPlayerRuntime(module, url) as unknown as Record<string, unknown>;
    }
    return createEffectRuntime(module) as unknown as Record<string, unknown>;
  }

  updateModule(
    moduleId: string,
    updates: Partial<ModuleConfig>,
    chainIndex: number = ((this.app as Record<string, unknown>)?.getSelectedChainIndex as () => number)?.() ?? 0
  ): void {
    const chain = this.getChainState(chainIndex);
    const modules = Array.isArray(chain.modules) ? chain.modules : [];
    const moduleIndex = modules.findIndex((m) => m.id === moduleId);
    if (moduleIndex < 0) {
      return;
    }

    modules[moduleIndex] = { ...modules[moduleIndex], ...updates };

    if (!this.ready) {
      return;
    }

    const runtime = this.getModuleRuntime(chainIndex, moduleId);
    if (runtime && (runtime as Record<string, unknown>).apply) {
      ((runtime as Record<string, unknown>).apply as (m: ModuleConfig) => void)(modules[moduleIndex]);
    }
  }

  // Transport control
  async play(): Promise<void> {
    if (!this.ready) return;
    await this._waitForPlayersLoaded();
    Tone.Transport.start();
    this.isPlaying = true;
    this._startProgressLoop();
  }

  pause(): void {
    if (!this.ready) return;
    Tone.Transport.pause();
    this.isPlaying = false;
    this._stopProgressLoop();
  }

  stop(): void {
    if (!this.ready) return;
    Tone.Transport.stop();
    this.isPlaying = false;
    this._stopProgressLoop();
  }

  async togglePlay(): Promise<void> {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  async _waitForPlayersLoaded(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [, runtimeMap] of this.chainRuntimes) {
      for (const [, runtime] of runtimeMap) {
        const rt = runtime as Record<string, unknown>;
        if (rt.loaded instanceof Promise) {
          promises.push(rt.loaded as Promise<void>);
        }
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  seek(seconds: number): void {
    if (!this.ready) return;
    Tone.Transport.seconds = Math.max(0, seconds);
  }

  getProgress(): number {
    return Tone.Transport.seconds;
  }

  getDuration(): number {
    // Return the duration in seconds — poll from the first player that's loaded
    for (const [, runtimeMap] of this.chainRuntimes) {
      for (const [, runtime] of runtimeMap) {
        if ((runtime as Record<string, unknown>).player) {
          const player = (runtime as Record<string, unknown>).player as { buffer?: { duration?: number } };
          const dur = Number(player.buffer?.duration ?? 0);
          if (dur > 0) return dur;
        }
      }
    }
    return 0;
  }

  isTransportPlaying(): boolean {
    return Tone.Transport.state === "started";
  }

  onProgress(callback: () => void): void {
    this._progressCallback = callback;
  }

  _startProgressLoop(): void {
    const loop = (): void => {
      if (!this.isPlaying) return;
      if (this._progressCallback) {
        this._progressCallback();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _stopProgressLoop(): void {
    // Progress callback fires one last time to update UI
    if (this._progressCallback) {
      this._progressCallback();
    }
  }
}
