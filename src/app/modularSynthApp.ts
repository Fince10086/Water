import type { Analyser } from "tone";
import {
  createBasePreset,
  createDefaultMacroPointState,
  normalizeCurrentPresetData,
  normalizePreset,
  importPresetFromFile,
  exportCurrentPresetToFile,
  exportAllPresetToFile,
  isAllTypePreset,
} from "../preset/preset";
import {
  loadAllPresets,
  getBuiltinPresets,
  getUserPresets,
  getPresetById,
  addUserPreset,
  removeUserPreset,
  generateUserPresetId,
  getLastSelectedId,
  saveLastSelectedId,
} from "../preset/presetLoader";
import { AudioEngine } from "../audio/audio";
import { ModulationManager } from "../interactions/modulation/modulationManager";
import { MacroManager } from "../interactions/macro/macroManager";
import { GestureManager, type GestureManagerApp } from "../interactions/gesture/gestureManager";
import { ModuleDragManager } from "../interactions/drag/moduleDragManager";
import { ENABLED as SOURCE_MONITOR_ENABLED, SourceOutputMonitor } from "../debug/sourceOutputMonitor";
import { generateToneFromDescription } from "../ai/toneGenerator";
import type { ToneGenerationResult } from "../ai/toneGenerator";
import {
  resizeScopeCanvas,
  startScopeRendering,
  stopScopeRendering,
  renderMainCard,
  renderMainCardContent,
  cacheDynamicElements as cacheDynamicElementsFn,
} from "../ui/components";
import { createDownloadOverlay, type DownloadOverlay } from "../ui/components/downloadOverlay";
import { renderModuleCard } from "../ui/rendering/moduleRenderer";
import { layoutModuleMasonry } from "../ui/layout/masonryLayout";
import {
  deepClone,
  getByPath,
  setByPath,
  createModule,
  getAddableModuleOptions,
  clamp,
  getModuleDefinition,
} from "../utils/helpers";
import { formatDb } from "../core/formatters";
import { t, setLanguage, getLanguage, subscribeToLanguageChange, type Language } from "../i18n";
import type {
  Preset,
  ChainState,
  ModuleConfig,
  ModulationConnection,
  ControlBinding,
  ModuleCategory,
  ModuleType,
  MacroPointState,
} from "../types";

const CHAIN_COUNT = 4;

interface ModularSynthAppElements {
  statusText: HTMLElement | null;
  statusDot: HTMLElement | null;
  signalFlow: HTMLElement | null;
  signalFlowShell: HTMLElement | null;
  addModuleCard: HTMLElement | null;
  addModuleDropdown: HTMLElement | null;
  oscilloscope: HTMLCanvasElement | null;
  presetFileInput: HTMLInputElement | null;
  presetSelect: HTMLSelectElement | null;
  importBtn: HTMLElement | null;
  exportBtn: HTMLElement | null;
  resetBtn: HTMLElement | null;
  randomBtn: HTMLElement | null;
  masterReadout: HTMLElement | null;
}

interface PresetWithName extends Preset {
  name?: string;
}

export class ModularSynthApp {
  state: Preset;
  selectedPresetId: string | null;
  hasUnsavedChanges: boolean;
  audioBooted: boolean;

  controlBindings: Map<string, ControlBinding>;

  scopeMode: "scope" | "spectrum";

  macroManager: MacroManager;
  gestureManager: GestureManager;
  modulationManager: ModulationManager;
  dragManager: ModuleDragManager;
  engine: AudioEngine;

  elements: ModularSynthAppElements;
  scopeContext: CanvasRenderingContext2D | null;
  downloadOverlay: DownloadOverlay;

  sourceMonitor: SourceOutputMonitor | undefined;

  selectedChainIndex: number;
  aiPhase: 'idle' | 'reasoning' | 'generating';
  aiReasoning: string | null;
  originalStateSnapshot: Preset | null;

  isPlaying: boolean;
  transportProgress: number;
  transportDuration: number;

  constructor() {
    this.state = createBasePreset();
    this.ensureChainsState();
    this.selectedPresetId = null;
    this.hasUnsavedChanges = false;
    this.audioBooted = false;

    this.controlBindings = new Map();

    this.scopeMode = "scope";

    this.macroManager = new MacroManager(this as unknown as any);
    this.gestureManager = new GestureManager(this as unknown as GestureManagerApp);
    this.modulationManager = new ModulationManager(this);
    this.dragManager = new ModuleDragManager(this as unknown as unknown as Record<string, unknown>);
    this.engine = new AudioEngine(this as unknown as unknown as Record<string, unknown>);
    this.downloadOverlay = createDownloadOverlay();

    this.aiPhase = 'idle';
    this.aiReasoning = null;
    this.originalStateSnapshot = null;

    this.isPlaying = false;
    this.transportProgress = 0;
    this.transportDuration = 0;

    this.bindMacroKeyboardSelection();

    this.cacheElements();
    this.bindEvents();
    subscribeToLanguageChange(() => this.renderAll());

    window.addEventListener("resize", () => {
      this.resizeScopeCanvas();
      this.layoutModuleMasonry();
      this.modulationManager.renderModulationOverlay();
      this.macroManager.renderMacroOverlay();
    });

    if (SOURCE_MONITOR_ENABLED) {
      this.sourceMonitor = new SourceOutputMonitor(this as unknown as unknown as Record<string, unknown>);
      this.sourceMonitor.start();
    }
  }

  ensureChainsState(): void {
    this.state = normalizePreset(this.state);
    this.selectedChainIndex = clamp(Number(this.state.selectedChainIndex ?? 0), 0, CHAIN_COUNT - 1);
    this.state.selectedChainIndex = this.selectedChainIndex;
  }

  getChainCount(): number {
    return CHAIN_COUNT;
  }

  getSelectedChainIndex(): number {
    return this.selectedChainIndex;
  }

  setSelectedChainIndex(index: number): void {
    this.selectedChainIndex = clamp(Number(index || 0), 0, CHAIN_COUNT - 1);
    this.state.selectedChainIndex = this.selectedChainIndex;
    this.engine.refreshCurrentRuntimeAlias();
  }

  getChain(chainIndex = this.selectedChainIndex): ChainState {
    const index = clamp(Number(chainIndex || 0), 0, CHAIN_COUNT - 1);
    if (!Array.isArray(this.state.chains)) {
      this.state.chains = [];
    }
    if (!this.state.chains[index]) {
      this.state.chains[index] = { enabled: true, modules: [], modulations: [] };
    }
    const chain = this.state.chains[index];
    if (!Array.isArray(chain.modules)) {
      chain.modules = [];
    }
    if (!Array.isArray(chain.modulations)) {
      chain.modulations = [];
    }
    chain.enabled = Boolean(chain.enabled);
    return chain;
  }

  getCurrentChain(): ChainState {
    return this.getChain(this.selectedChainIndex);
  }

  getCurrentModules(): ModuleConfig[] {
    return this.getCurrentChain().modules;
  }

  getCurrentModulations(): ModulationConnection[] {
    return this.getCurrentChain().modulations;
  }

  setCurrentModulations(nextModulations: ModulationConnection[]): void {
    this.getCurrentChain().modulations = Array.isArray(nextModulations) ? nextModulations : [];
  }

  isChainEnabled(chainIndex: number): boolean {
    return Boolean(this.getChain(chainIndex).enabled);
  }

  setChainEnabled(chainIndex: number, enabled: boolean): void {
    const chain = this.getChain(chainIndex);
    chain.enabled = Boolean(enabled);
  }

  bindMacroKeyboardSelection(): void {
    document.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if (e.key >= "1" && e.key <= "4") {
        const index = Number(e.key) - 1;
        if (index < this.state.macro.pointCount) {
          this.selectMacroPoint(index);
        }
      }
    });
  }

  selectMacroPoint(index: number): void {
    const pointCount = 4;
    const safeIndex = clamp(index, 0, pointCount - 1);
    this.state.macro.selectedPointIndex = safeIndex;
    const recent = [safeIndex, ...this.state.macro.recentSelection.filter((i) => i !== safeIndex)];
    this.state.macro.recentSelection = recent.slice(0, 3);
    this.markUnsaved();
    this.renderAll();
  }

  setSelectedMacroPointIndex(index: number): void {
    const pointCount = 4;
    const safeIndex = clamp(index, 0, pointCount - 1);
    this.state.macro.selectedPointIndex = safeIndex;
    const recent = [safeIndex, ...this.state.macro.recentSelection.filter((i) => i !== safeIndex)];
    this.state.macro.recentSelection = recent.slice(0, 4);
  }

  getMacroPoint(pointIndex: number): MacroPointState {
    return this.macroManager.getMacroPoint(pointIndex) as unknown as MacroPointState;
  }

  getMacroPointCount(): number {
    return 4;
  }

  getSelectedMacroPointIndex(): number {
    return clamp(this.state.macro.selectedPointIndex, 0, this.getMacroPointCount() - 1);
  }

  updateMacroPointFromGesture(pointIndex: number, x: number, y: number): void {
    const point = this.macroManager.getMacroPoint(pointIndex);
    const nextX = clamp(x, 0, 1);
    const nextY = clamp(y, 0, 1);
    if (Math.abs(point.x - nextX) <= 1e-6 && Math.abs(point.y - nextY) <= 1e-6) {
      return;
    }
    point.x = nextX;
    point.y = nextY;
    this.macroManager.applyMappingsForPoint(pointIndex, false);
    this.markUnsaved();
    this.renderAll();
  }

  cacheElements(): void {
    this.elements = {
      statusText: document.getElementById("statusText"),
      statusDot: document.getElementById("statusDot"),
      signalFlow: document.querySelector(".signal-flow"),
      signalFlowShell: document.querySelector(".signal-flow-shell"),
      addModuleCard: document.getElementById("addModuleCard"),
      addModuleDropdown: document.getElementById("addModuleDropdown"),
      oscilloscope: document.getElementById("oscilloscope") as HTMLCanvasElement | null,
      presetFileInput: document.getElementById("presetFileInput") as HTMLInputElement | null,
      presetSelect: document.getElementById("presetSelect") as HTMLSelectElement | null,
      importBtn: document.getElementById("importBtn"),
      exportBtn: document.getElementById("exportBtn"),
      resetBtn: document.getElementById("resetBtn"),
      randomBtn: document.getElementById("randomBtn"),
      masterReadout: document.getElementById("masterReadout"),
    };
    this.scopeContext = this.elements.oscilloscope?.getContext("2d") || null;
    if (this.elements.addModuleCard) {
      this.elements.addModuleCard.setAttribute("aria-label", t("Add module"));
    }
    document.title = t("Card Synth");
  }

  bindEvents(): void {
    const wakeAudio = () => {
      this.ensureAudioStarted();
    };

    document.addEventListener("pointerdown", wakeAudio, { passive: true });
    document.addEventListener("keydown", wakeAudio);

    this.populateAddModuleDropdown();
    this.elements.addModuleCard?.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest(".add-module-dropdown-item")) {
        return;
      }
      this.toggleAddModuleDropdown();
    });
    document.addEventListener("click", (e) => {
      if (e.target instanceof Element && !e.target.closest(".add-module-card")) {
        this.hideAddModuleDropdown();
      }
    });

    this.elements.presetFileInput?.addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) {
        return;
      }

      try {
        const imported = await importPresetFromFile(file);
        const previousState = deepClone(this.state);

        if (imported.type === "all") {
          this.state = normalizePreset(imported.preset);
          this.setSelectedChainIndex(this.state.selectedChainIndex ?? 0);
        } else {
          const chain = this.getCurrentChain();
          chain.modules = imported.chain.modules as unknown as ModuleConfig[];
          chain.modulations = imported.chain.modulations as unknown as ModulationConnection[];
        }

        const baseName = file.name.replace(/\.json$/i, "");
        const presetId = generateUserPresetId(baseName || "imported");
        addUserPreset(presetId, imported.type === "all" ? imported.preset : imported.chain);
        this.selectedPresetId = presetId;
        this.hasUnsavedChanges = false;
        saveLastSelectedId(presetId);

        this.renderAll(previousState);
        this.engine.fullSync(this.state);
        this.setStatus(
          imported.type === "all"
            ? t("Imported all chains from {{filename}}.", { filename: file.name })
            : t("Imported current chain from {{filename}}.", { filename: file.name }),
          "live",
        );
      } catch (error: unknown) {
        this.setStatus(t("Import failed: {{error}}", { error: error instanceof Error ? error.message : String(error) }), "error");
      } finally {
        (event.target as HTMLInputElement).value = "";
      }
    });

    // Set up progress callback
    this.engine.onProgress(() => {
      this.transportProgress = this.engine.getProgress();
      this.transportDuration = this.engine.getDuration();
      this.isPlaying = this.engine.isTransportPlaying();

      const formatTime = (s: number): string => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, "0")}`;
      };

      const playBtn = document.querySelector(".transport-play-btn") as HTMLButtonElement | null;
      if (playBtn) {
        playBtn.textContent = this.isPlaying ? t("Pause") : t("Play");
        playBtn.classList.toggle("is-playing", this.isPlaying);
      }

      const progressInner = document.querySelector(".transport-progress-inner") as HTMLElement | null;
      if (progressInner) {
        const pct = this.transportDuration > 0 ? (this.transportProgress / this.transportDuration) * 100 : 0;
        progressInner.style.setProperty("--progress-pct", `${Math.min(100, Math.max(0, pct))}%`);
      }

      const timeReadout = document.querySelector(".transport-time") as HTMLElement | null;
      if (timeReadout) {
        timeReadout.textContent = `${formatTime(this.transportProgress)} / ${formatTime(this.transportDuration)}`;
      }
    });

    this.modulationManager.bindEvents();
    this.macroManager.bindEvents();
  }

  handlePlay(): void {
    if (this.isPlaying) {
      this.engine.togglePlay().then(() => {
        this.isPlaying = this.engine.isTransportPlaying();
        this.transportProgress = this.engine.getProgress();
        this.transportDuration = this.engine.getDuration();
        this.renderAll();
      });
      return;
    }

    if (this.audioBooted) {
      this.engine.togglePlay().then(() => {
        this.isPlaying = this.engine.isTransportPlaying();
        this.transportProgress = this.engine.getProgress();
        this.transportDuration = this.engine.getDuration();
        this.renderAll();
      });
      return;
    }

    this.downloadOverlay.show(t("Loading audio..."));
    this.ensureAudioStarted().then(() => {
      this.engine.togglePlay().then(() => {
        this.isPlaying = this.engine.isTransportPlaying();
        this.transportProgress = this.engine.getProgress();
        this.transportDuration = this.engine.getDuration();
        this.renderAll();
      });
    });
  }

  handleSeek(percent: number): void {
    const duration = this.engine.getDuration();
    this.engine.seek(percent * duration);
    this.transportProgress = this.engine.getProgress();
    this.renderAll();
  }

  setStatus(message: string, tone = "neutral"): void {
    if (this.elements.statusText) {
      this.elements.statusText.textContent = message;
    }
    if (this.elements.statusDot) {
      this.elements.statusDot.classList.remove("live", "error");
      if (tone === "live") {
        this.elements.statusDot.classList.add("live");
      }
      if (tone === "error") {
        this.elements.statusDot.classList.add("error");
      }
    }
  }

  async ensureAudioStarted(): Promise<void> {
    if (this.audioBooted) {
      return;
    }
    try {
      this.engine.onDownloadProgress((progress) => {
        this.downloadOverlay.update(progress.percent, `${progress.loaded} / ${progress.total} bytes`);
      });
      await this.engine.preloadAudio();
      await this.engine.start(this.state);
      this.downloadOverlay.update(100);
      this.audioBooted = true;
      this.transportDuration = this.engine.getDuration();
      this.setStatus(t("Audio ready."), "live");
    } catch (error: unknown) {
      this.downloadOverlay.hide();
      this.setStatus(t("Audio failed: {{error}}", { error: error instanceof Error ? error.message : String(error) }), "error");
    }
  }

  populateAddModuleDropdown(): void {
    const dropdown = this.elements.addModuleDropdown;
    if (!dropdown) {
      return;
    }

    dropdown.innerHTML = "";

    const options = getAddableModuleOptions();

    const groups: Record<string, { title: string; items: ReturnType<typeof getAddableModuleOptions> }> = {
      effect: { title: t("Effect"), items: [] },
    };

    options.forEach((option) => {
      const kind = option.category;
      if (groups[kind]) {
        groups[kind].items.push(option);
      }
    });

    Object.entries(groups).forEach(([kind, group]) => {
      if (group.items.length === 0) {
        return;
      }

      const groupEl = document.createElement("div");
      groupEl.className = "add-module-dropdown-group";

      const titleEl = document.createElement("div");
      titleEl.className = "add-module-dropdown-group-title";
      titleEl.textContent = group.title;
      groupEl.appendChild(titleEl);

      group.items.forEach((option) => {
        const itemEl = document.createElement("div");
        itemEl.className = "add-module-dropdown-item";
        itemEl.dataset.value = option.value;
        itemEl.textContent = option.label;
        itemEl.addEventListener("click", (e) => {
          e.stopPropagation();
          this.handleAddModule(option.value);
          this.hideAddModuleDropdown();
        });
        groupEl.appendChild(itemEl);
      });

      dropdown.appendChild(groupEl);
    });
  }

  toggleAddModuleDropdown(): void {
    const dropdown = this.elements.addModuleDropdown;
    const card = this.elements.addModuleCard;
    if (!dropdown || !card) {
      return;
    }

    const isVisible = dropdown.classList.contains("visible");
    if (isVisible) {
      this.hideAddModuleDropdown();
    } else {
      this.positionDropdown(dropdown, card);
      dropdown.classList.add("visible");
      card.classList.add("active");
    }
  }

  positionDropdown(dropdown: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const dropdownHeight = 300;
    const dropdownWidth = 180;
    const gap = 4;

    dropdown.style.left = "";
    dropdown.style.top = "";
    dropdown.style.right = "";
    dropdown.style.bottom = "";
    dropdown.classList.remove("above");

    let top: number;
    const spaceBelow = viewportHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;

    if (spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove) {
      top = rect.bottom + gap;
    } else {
      top = rect.top - gap - dropdownHeight;
      dropdown.classList.add("above");
    }

    let left = rect.left;
    if (left + dropdownWidth > viewportWidth) {
      left = viewportWidth - dropdownWidth - 10;
    }
    if (left < 10) {
      left = 10;
    }

    dropdown.style.left = `${left}px`;
    dropdown.style.top = `${top}px`;
    dropdown.style.width = `${Math.max(rect.width, dropdownWidth)}px`;
  }

  hideAddModuleDropdown(): void {
    const dropdown = this.elements.addModuleDropdown;
    const card = this.elements.addModuleCard;
    if (dropdown) {
      dropdown.classList.remove("visible");
      dropdown.classList.remove("above");
    }
    if (card) {
      card.classList.remove("active");
    }
  }

  handleAddModule(value: string): void {
    if (!value) {
      return;
    }

    const [category, type] = value.split(":");
    const newModule = createModule(category as ModuleCategory, type as ModuleType, this.getSelectedChainIndex());
    this.getCurrentModules().push(newModule);
    this.markUnsaved();
    this.renderAll();
    this.engine.fullSync(this.state);
  }

  renderAll(previousState: Preset | null = null): void {
    this.populateAddModuleDropdown();
    this.controlBindings = new Map();
    this.macroManager.applyAllMappings();

    const sections: [string, () => void][] = [
      ["main-card content", () => this.updateMainCardContent()],
      ["modules", () => this.renderModulesRack()],
    ];

    for (const [label, task] of sections) {
      try {
        task();
      } catch (error: unknown) {
        console.error(`Render error in ${label}:`, error);
        this.setStatus(t("Render error in {{label}}: {{error}}", { label, error: error instanceof Error ? error.message : String(error) }), "error");
      }
    }

    const dynamicElements = cacheDynamicElementsFn();
    Object.assign(this.elements, dynamicElements);

    if (dynamicElements.oscilloscope) {
      this.scopeContext = dynamicElements.scopeContext || null;

      dynamicElements.oscilloscope.addEventListener("click", () => {
        this.toggleScopeMode();
      });
    }

    this.resizeScopeCanvas();

    this.layoutModuleMasonry();
    this.modulationManager.renderModulationOverlay();
    this.macroManager.renderMacroOverlay();

    if (previousState) {
      this.animateControlTransition(previousState, this.state);
    }
  }

  layoutModuleMasonry(): void {
    const container = this.elements.signalFlow;
    if (!container) {
      return;
    }

    const addCard = container.querySelector(".add-module-card");
    const mainCard = container.querySelector('.module-card[data-main-card="true"]');

    layoutModuleMasonry({ container, modules: this.getCurrentModules(), addCard: addCard as HTMLElement | null, mainCard: mainCard as HTMLElement | null });
  }

  updateMainCardContent(): void {
    renderMainCardContent({
      updatePresetSelect: () => this.updatePresetSelect(),
      updateMasterReadout: (value) => this.updateMasterReadout(value),
      volume: this.state.global.volume,
    });
  }

  updatePresetSelect(): void {
    if (this.elements.presetSelect) {
      this.elements.presetSelect.value = this.selectedPresetId ?? "";
    }
  }

  updateMasterReadout(value: number): void {
    if (this.elements.masterReadout) {
      this.elements.masterReadout.textContent = formatDb(value);
    }
  }

  renderModulesRack(): void {
    const container = this.elements.signalFlow;
    if (!container) {
      return;
    }

    const addCard = container.querySelector(".add-module-card");
    const existingMainCard = container.querySelector('.module-card[data-main-card="true"]');

    const oldModuleCards = container.querySelectorAll('.module-card:not([data-main-card="true"])');
    oldModuleCards.forEach((card) => card.remove());

    if (existingMainCard) {
      existingMainCard.remove();
    }

    const mainCardOptions = {
      selectedPresetId: this.selectedPresetId,
      hasUnsavedChanges: this.hasUnsavedChanges,
      builtinPresets: getBuiltinPresets(),
      userPresets: getUserPresets(),
      state: this.state,
      selectedChainIndex: this.getSelectedChainIndex(),
      chains: this.state.chains,
      macro: this.macroManager.getMainCardViewModel(),
      audioBooted: this.audioBooted,
      transport: {
        isPlaying: this.isPlaying,
        progress: this.transportProgress,
        duration: this.transportDuration,
      },
      onPresetChange: (value: string) => this.applyPresetById(value),
      onChainIndexClick: (chainIndex: number, isSelected: boolean) => {
        if (!isSelected) {
          this.setSelectedChainIndex(chainIndex);
          this.renderAll();
          return;
        }

        this.setChainEnabled(chainIndex, !this.isChainEnabled(chainIndex));
        this.markUnsaved();
        this.renderAll();
        this.engine.fullSync(this.state);
      },
      onImportClick: () => this.elements.presetFileInput?.click(),
      onExportCurrentClick: () => {
        const currentPreset = getPresetById(this.selectedPresetId) as PresetWithName | null;
        const presetName = currentPreset?.name || this.selectedPresetId || "preset";
        const filename = exportCurrentPresetToFile(this.state, this.getSelectedChainIndex(), presetName);
        this.setStatus(t("Exported {{filename}}.", { filename }), this.audioBooted ? "live" : "neutral");
      },
      onExportAllClick: () => {
        const currentPreset = getPresetById(this.selectedPresetId) as PresetWithName | null;
        const presetName = currentPreset?.name || this.selectedPresetId || "preset";
        const filename = exportAllPresetToFile(this.state, presetName);
        this.setStatus(t("Exported {{filename}}.", { filename }), this.audioBooted ? "live" : "neutral");
      },
      onResetClick: () => {
        if (this.originalStateSnapshot) {
          const previousState = deepClone(this.state);
          this.state = deepClone(this.originalStateSnapshot);
          this.hasUnsavedChanges = false;
          this.renderAll(previousState);
          this.engine.fullSync(this.state);
          this.setStatus(t("Reset to original state"), this.audioBooted ? "live" : "neutral");
        }
      },
      onRandomClick: () => this.randomizeCurrentPatch(),
      onMasterVolumeChange: (value: number) => {
        this.state.global.volume = value;
        this.markUnsaved();
        this.engine.updateGlobal(this.state.global);
      },
      onMacroPointPointerDown: (event: PointerEvent, pointIndex: number, padElement: HTMLElement) => {
        this.macroManager.startPointDrag({ event, pointIndex, padElement });
      },
      onMacroAxisPointerDown: (event: PointerEvent, axis: string, pointIndex: number) => {
        this.macroManager.startAxisBindingDrag({
          event,
          axis: axis as "x" | "y",
          pointIndex,
        });
      },
      onGestureClick: () => {
        this.downloadOverlay.show(t("Loading gesture model..."));
        this.gestureManager.onDownloadProgress = (percent, label) => {
          this.downloadOverlay.update(percent, label);
        };
        this.gestureManager.activate(
          this.engine.getSpectrumAnalyser() as unknown as { getValue(): Float32Array },
          () => this.engine.getDuration(),
          () => this.engine.getChainSourceLevel(3)
        ).catch(() => {
          this.downloadOverlay.hide();
        });
      },
      onDeleteUserPreset: (id: string) => {
        removeUserPreset(id);
        if (this.selectedPresetId === id) {
          const builtins = getBuiltinPresets();
          const firstId = Object.keys(builtins)[0];
          if (firstId) this.applyPresetById(firstId);
        } else {
          this.renderAll();
        }
      },
      onLanguageChange: (lang: Language) => {
        setLanguage(lang);
      },
      onAiGenerate: (description: string) => this.generateTone(description),
      onPlayClick: () => this.handlePlay(),
      onSeek: (percent: number) => this.handleSeek(percent),
      aiPhase: this.aiPhase,
      aiReasoning: this.aiReasoning,
    };

    const mainCard = renderMainCard(mainCardOptions);
    if (mainCard) {
      if (addCard) {
        container.insertBefore(mainCard, addCard);
      } else {
        container.appendChild(mainCard);
      }
    }

    const modules = this.getCurrentModules();
    modules.forEach((module, index) => {
      const card = renderModuleCard(module, index, this as unknown as any);
      if (card) {
        if (addCard) {
          container.insertBefore(card, addCard);
        } else {
          container.appendChild(card);
        }
      }
    });
  }

  resizeScopeCanvas(): void {
    const canvas = this.elements.oscilloscope;
    const context = this.scopeContext;
    if (canvas && context) {
      resizeScopeCanvas(canvas, context);
    }
  }

  drawOscilloscope(): void {
    stopScopeRendering();
    startScopeRendering({
      getCanvasFn: () => this.elements.oscilloscope,
      getContextFn: () => this.scopeContext,
      getAnalyserFn: () => this.engine.getAnalyser() as unknown as Analyser,
      getSpectrumAnalyserFn: () => this.engine.getSpectrumAnalyser() as unknown as Analyser,
      getAudioBootedFn: () => this.audioBooted,
      getModeFn: () => this.scopeMode,
    });
  }

  toggleScopeMode(): void {
    this.scopeMode = this.scopeMode === "scope" ? "spectrum" : "scope";
  }

  isModulationSource(module: ModuleConfig): boolean {
    return this.modulationManager.isModulationSource(module);
  }

  getModulations(): ModulationConnection[] {
    return this.modulationManager.getModulations();
  }

  getOutgoingModulations(sourceModuleId: string): ModulationConnection[] {
    return this.modulationManager.getOutgoingModulations(sourceModuleId);
  }

  getModulationByTarget(targetModuleId: string, targetParamPath: string): ModulationConnection | undefined {
    return this.modulationManager.getModulationByTarget(targetModuleId, targetParamPath);
  }

  startModulationDrag(options: unknown): void {
    this.modulationManager.startModulationDrag(options as any);
  }

  removeModulationById(connectionId: string): void {
    this.modulationManager.removeModulationById(connectionId);
  }

  removeOutgoingModulations(sourceModuleId: string): void {
    this.modulationManager.removeOutgoingModulations(sourceModuleId);
  }

  removeModuleModulations(moduleId: string): void {
    this.modulationManager.removeModuleModulations(moduleId);
  }

  initModuleDrag(event: PointerEvent, card: HTMLElement, moduleIndex: number): void {
    this.dragManager.initModuleDrag(event, card, moduleIndex);
  }

  async init(): Promise<void> {
    await loadAllPresets();

    const lastId = getLastSelectedId();
    if (lastId && getPresetById(lastId)) {
      this.applyPresetById(lastId, false);
    } else {
      const builtins = getBuiltinPresets();
      const defaultId = "default";
      const targetId = builtins[defaultId] ? defaultId : Object.keys(builtins)[0];
      if (targetId) {
        this.applyPresetById(targetId, false);
      }
    }

    this.renderAll();

    document.body.appendChild(this.downloadOverlay.element);

    const scopeEl = document.getElementById("oscilloscope");
    if (scopeEl) {
      this.elements.oscilloscope = scopeEl as HTMLCanvasElement;
      this.scopeContext = (scopeEl as HTMLCanvasElement).getContext("2d") || null;
    }
    this.resizeScopeCanvas();
    this.drawOscilloscope();
    this.transportDuration = this.engine.getDuration();
  }

  applyPresetById(presetId: string, shouldRender = true): void {
    const preset = getPresetById(presetId);
    if (!preset) {
      return;
    }

    const previousState = deepClone(this.state);

    if (isAllTypePreset(preset)) {
      this.state = normalizePreset(preset);
      this.setSelectedChainIndex(this.state.selectedChainIndex ?? 0);
    } else {
      const chainPreset = normalizeCurrentPresetData(preset as any);
      const chain = this.getCurrentChain();

      chain.modules = chainPreset.modules as unknown as ModuleConfig[];
      chain.modulations = chainPreset.modulations as unknown as ModulationConnection[];
      chain.enabled = true;
    }

    this.selectedPresetId = presetId;
    this.hasUnsavedChanges = false;
    this.originalStateSnapshot = deepClone(this.state);
    saveLastSelectedId(presetId);

    if (shouldRender) {
      this.renderAll(previousState);
      this.engine.fullSync(this.state);
    }

    const loadedPreset = getPresetById(presetId) as PresetWithName | null;
    const presetName = loadedPreset?.name || presetId;
    this.setStatus(t("LOADED PRESET: {{name}}.", { name: presetName }), this.audioBooted ? "live" : "neutral");
  }

  markUnsaved(): void {
    if (!this.hasUnsavedChanges) {
      this.hasUnsavedChanges = true;
      this.renderAll();
    }
  }

  syncControlsFromState(): void {
    this.controlBindings.forEach((binding, path) => {
      const value = getByPath(this.state as unknown as unknown as Record<string, unknown>, path);
      if (typeof value === "number" && Number.isFinite(value)) {
        binding.setVisual(value);
      }
    });
  }

  animateControlTransition(fromState: Preset, toState: Preset): void {
    const animations: Array<{ binding: ControlBinding; startValue: number; endValue: number }> = [];

    this.controlBindings.forEach((binding, path) => {
      const startValue = getByPath(fromState as unknown as unknown as Record<string, unknown>, path);
      const endValue = getByPath(toState as unknown as unknown as Record<string, unknown>, path);

      if (
        typeof startValue === "number" &&
        Number.isFinite(startValue) &&
        typeof endValue === "number" &&
        Number.isFinite(endValue)
      ) {
        binding.setVisual(startValue);
        animations.push({ binding, startValue, endValue });
      }
    });

    if (!animations.length) {
      return;
    }

    const duration = 360;
    const startTime = performance.now();
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    const frame = (now: number) => {
      const progress = clamp((now - startTime) / duration, 0, 1);
      const eased = easeOut(progress);

      animations.forEach(({ binding, startValue, endValue }) => {
        binding.setVisual(startValue + (endValue - startValue) * eased);
      });

      if (progress < 1) {
        requestAnimationFrame(frame);
      }
    };

    requestAnimationFrame(frame);
  }

  randomizeCurrentPatch(): void {
    const randomChoice = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
    const randomRange = (min: number, max: number, step = 0.01): number => {
      const steps = Math.round((max - min) / step);
      return min + Math.floor(Math.random() * (steps + 1)) * step;
    };

    const previousState = deepClone(this.state);
    this.state.global.volume = randomRange(-16, -4, 0.1);

    const modules = this.getCurrentModules();
    modules.forEach((module) => {
      const definition = getModuleDefinition(module);
      if (module.category === "source") {
        module.volume = randomRange(-18, -4, 0.1);
        module.pan = randomRange(-0.45, 0.45, 0.01);
      }
      definition.controls.forEach((control) => {
        if (control.conditional && !control.conditional(module)) {
          return;
        }
        if (control.kind === "switch") {
          return;
        }
        if (control.kind === "select") {
          setByPath(module, control.path, randomChoice(control.options!).value);
        } else if (control.kind === "toggle") {
          setByPath(module, control.path, Math.random() < 0.5);
        } else {
          setByPath(module, control.path, randomRange(control.min!, control.max!, control.step!));
        }
      });
    });

    this.markUnsaved();
    this.renderAll(previousState);
    this.engine.fullSync(this.state);
    this.setStatus(t("Randomized the current patch."), this.audioBooted ? "live" : "neutral");
  }

  async generateTone(description: string): Promise<void> {
    this.aiPhase = 'reasoning';
    this.aiReasoning = null;
    this.renderAll();
    this.setStatus(t("Thinking..."), "neutral");

    try {
      const result = await generateToneFromDescription(
        description,
        (reasoning) => {
          this.aiReasoning = reasoning;
          this.renderAll();
        },
        () => {
          this.aiPhase = 'generating';
          this.setStatus(t("Generating..."), "neutral");
          this.renderAll();
        }
      );

      const presetName = result.name;
      const presetId = generateUserPresetId(presetName);

      const presetData = {
        name: presetName,
        presetType: "current" as const,
        global: result.preset.global,
        modules: result.preset.chains[0]?.modules || [],
        modulations: result.preset.chains[0]?.modulations || [],
      };
      addUserPreset(presetId, presetData);

      this.applyPresetById(presetId);
      this.originalStateSnapshot = deepClone(this.state);

      this.setStatus(
        t("Saved new preset: {{name}}", { name: presetName }),
        this.audioBooted ? "live" : "neutral"
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "NO_API_KEY") {
        this.setStatus(t("API Key not configured"), "error");
      } else {
        this.setStatus(t("Failed to generate timbre: {{error}}", { error: message }), "error");
      }
    } finally {
      this.aiPhase = 'idle';
      this.renderAll();
    }
  }
}
