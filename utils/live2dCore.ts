// Adaptive Cubism Core loader.
// Reads the moc3 file header to detect version (v5 = Cubism 5.1, v6 = Cubism 5.3)
// and loads the matching Core automatically, so any model version works.
const CUBISM_CORE_V5 = 'https://cubism.live2d.com/sdk-web/core/live2dcubismcore.min.js';
const CUBISM_CORE_V6 = 'https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js';

type CubismCoreGlobal = {
  Version?: {
    csmGetLatestMocVersion?: () => number;
  };
};

let corePromise: Promise<void> | null = null;
let runtimePromise: Promise<typeof import('untitled-pixi-live2d-engine/cubism')> | null = null;

// Track which Core version is currently loaded so we can reload if needed.
let loadedCoreVersion: number | null = null;

const getCore = (): CubismCoreGlobal | undefined =>
  (window as Window & { Live2DCubismCore?: CubismCoreGlobal }).Live2DCubismCore;

const getLatestMocVersion = (): number | null => {
  try {
    const version = getCore()?.Version?.csmGetLatestMocVersion?.();
    return typeof version === 'number' && Number.isFinite(version) ? version : null;
  } catch {
    return null;
  }
};

const hasCore = (): boolean => (getLatestMocVersion() ?? 0) >= 5;

/**
 * Peek at the moc3 file's 5th byte to determine its version.
 * moc3 format: bytes 0-3 = "MOC3", byte 4 = version (5 = SDK5.1, 6 = SDK5.3).
 * Returns null if the file cannot be read or is not a valid moc3.
 */
export const detectMoc3Version = async (file: File | Blob): Promise<number | null> => {
  try {
    const header = await file.slice(0, 8).arrayBuffer();
    const bytes = new Uint8Array(header);
    // Check magic bytes "MOC3"
    if (bytes[0] !== 0x4D || bytes[1] !== 0x4F || bytes[2] !== 0x43 || bytes[3] !== 0x33) {
      return null;
    }
    const version = bytes[4];
    return version >= 3 && version <= 10 ? version : null;
  } catch {
    return null;
  }
};

/**
 * Pick the right Core URL for a given moc3 version.
 * v6+ needs Core 06 (Cubism 5.3); v5 and below use Core 5.1.
 */
const coreUrlForMocVersion = (mocVersion: number): string =>
  mocVersion >= 6 ? CUBISM_CORE_V6 : CUBISM_CORE_V5;

const loadScript = (src: string): Promise<void> => new Promise((resolve, reject) => {
  const existing = document.querySelector<HTMLScriptElement>(`script[data-live2d-core="${src}"]`);
  if (existing) {
    if (hasCore()) resolve();
    else existing.addEventListener('load', () => hasCore() ? resolve() : reject(new Error('Cubism Core 未注册')), { once: true });
    return;
  }
  const script = document.createElement('script');
  script.src = src;
  script.async = true;
  script.dataset.live2dCore = src;
  script.onload = () => hasCore() ? resolve() : reject(new Error('Cubism Core 脚本已加载，但没有注册运行时。'));
  script.onerror = () => {
    script.remove();
    reject(new Error(`无法加载 ${src}`));
  };
  document.head.appendChild(script);
});

const findLocalCore = async (): Promise<string | null> => {
  const local = new URL('vendor/live2dcubismcore.min.js', document.baseURI).toString();
  try {
    const response = await fetch(local, { method: 'HEAD', cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    return response.ok && /javascript|ecmascript|octet-stream/i.test(contentType) ? local : null;
  } catch {
    return null;
  }
};

/** Load the proprietary Cubism Core without bundling or redistributing it. */
export const ensureLive2DCubismCore = (requiredMocVersion = 5): Promise<void> => {
  if (typeof window === 'undefined') return Promise.reject(new Error('Live2D 只能在浏览器中运行。'));

  // If a compatible Core is already loaded for this moc version, reuse it.
  const currentMax = getLatestMocVersion() ?? 0;
  if (hasCore() && currentMax >= requiredMocVersion) return Promise.resolve();

  // If a different version needs loading, reset so we reload the right Core.
  if (corePromise && loadedCoreVersion !== null && loadedCoreVersion < requiredMocVersion) {
    corePromise = null;
  }

  if (corePromise) return corePromise;

  const targetUrl = coreUrlForMocVersion(requiredMocVersion);

  corePromise = (async () => {
    // Local vendor file takes priority regardless of version.
    const local = await findLocalCore();
    if (local) {
      try {
        await loadScript(local);
        loadedCoreVersion = getLatestMocVersion();
        return;
      } catch {
        // Stale/corrupt local file — fall through to CDN.
      }
    }
    try {
      await loadScript(targetUrl);
      loadedCoreVersion = requiredMocVersion;
    } catch {
      // If the version-specific CDN fails, try the other one as fallback.
      const fallbackUrl = requiredMocVersion >= 6 ? CUBISM_CORE_V5 : CUBISM_CORE_V6;
      try {
        await loadScript(fallbackUrl);
        loadedCoreVersion = requiredMocVersion >= 6 ? 5 : 6;
      } catch {
        throw new Error('Cubism Core 加载失败。请联网重试，或将官方 live2dcubismcore.min.js 放进 public/vendor/。');
      }
    }
  })().catch(error => {
    corePromise = null;
    throw error;
  });
  return corePromise;
};

/** Start the heavy Cubism framework chunk early while the user is choosing/importing a model. */
export const preloadLive2DRuntime = (): Promise<typeof import('untitled-pixi-live2d-engine/cubism')> => {
  if (runtimePromise) return runtimePromise;
  runtimePromise = ensureLive2DCubismCore()
    .then(() => import('untitled-pixi-live2d-engine/cubism'))
    .catch(error => {
      runtimePromise = null;
      throw error;
    });
  return runtimePromise;
};

/**
 * Core 6 moved the combined drawable/offscreen render order to Model.
 * The current Pixi adapter still reads the pre-5.3 drawables.renderOrders field.
 * Bridge that field for v6 models that do not use the new offscreen feature.
 */
export const bridgeCubism6RenderOrders = (model: unknown): { offscreenCount: number } => {
  const internal = (model as any)?.internalModel;
  const rawModel = internal?.coreModel?._model;
  const drawables = rawModel?.drawables;
  const offscreenCount = Number(rawModel?.offscreens?.count ?? 0);
  const renderOrders = rawModel?.getRenderOrders?.() ?? rawModel?.renderOrders;

  if (!drawables || drawables.renderOrders || !renderOrders) {
    return { offscreenCount };
  }

  if (offscreenCount > 0) {
    throw new Error(
      `This Cubism 5.3 model uses ${offscreenCount} offscreen object(s), which require the Cubism 5.3 renderer.`,
    );
  }

  const drawableCount = Number(drawables.count ?? renderOrders.length);
  drawables.renderOrders = typeof renderOrders.subarray === 'function'
    ? renderOrders.subarray(0, drawableCount)
    : renderOrders;

  return { offscreenCount };
};
