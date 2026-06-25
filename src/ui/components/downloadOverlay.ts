import { t } from "../../i18n";

export interface DownloadOverlay {
  show(label: string): void;
  update(percent: number, detail?: string): void;
  hide(): void;
  setLabel(label: string): void;
  get element(): HTMLElement;
}

export function createDownloadOverlay(): DownloadOverlay {
  const overlay = document.createElement("div");
  overlay.className = "download-overlay";

  const inner = document.createElement("div");
  inner.className = "download-overlay-inner";

  const labelEl = document.createElement("div");
  labelEl.className = "download-overlay-label";

  const detailEl = document.createElement("div");
  detailEl.className = "download-overlay-detail";

  const barOuter = document.createElement("div");
  barOuter.className = "download-overlay-bar";

  const barInner = document.createElement("div");
  barInner.className = "download-overlay-bar-inner";
  barOuter.appendChild(barInner);

  inner.appendChild(labelEl);
  inner.appendChild(barOuter);
  inner.appendChild(detailEl);
  overlay.appendChild(inner);

  let visible = false;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  function show(label: string): void {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }

    labelEl.textContent = label;
    detailEl.textContent = "";
    barInner.style.width = "0%";
    barInner.classList.remove("download-overlay-bar-inner--done");

    if (!visible) {
      visible = true;
      overlay.classList.add("download-overlay--visible");
    }
  }

  function update(percent: number, detail?: string): void {
    const pct = Math.min(100, Math.max(0, percent));
    barInner.style.width = `${pct}%`;

    if (detail !== undefined) {
      detailEl.textContent = detail;
    }

    if (pct >= 100) {
      barInner.classList.add("download-overlay-bar-inner--done");
      hideTimeout = setTimeout(() => {
        hide();
      }, 1200);
    }
  }

  function hide(): void {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    visible = false;
    overlay.classList.remove("download-overlay--visible");
  }

  function setLabel(label: string): void {
    labelEl.textContent = label;
  }

  return {
    show,
    update,
    hide,
    setLabel,
    get element() {
      return overlay;
    },
  };
}
