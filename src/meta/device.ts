/**
 * What it was played on.
 *
 * Enough to explain a frame time and nothing beyond that. Every field here earns
 * its place by answering a question somebody would otherwise guess at: whether a
 * quality preset is set right for the hardware that actually runs it, whether a
 * slow run was a slow machine, whether a GPU regression is one vendor.
 *
 * Deliberately *not* fingerprinting. No canvas hashing, no font enumeration, no
 * audio probe — those identify a browser without telling you anything about how
 * it performs, which is the wrong half of the trade. What is collected here is
 * already visible to any page and is read once, at run start.
 *
 * It does add entropy to a corpus that `pid` already made pseudonymous. That is
 * a real change in degree rather than in kind: these fields make an existing
 * identifier stronger, they do not create one.
 */
import type { Application } from 'pixi.js';

export interface DeviceInfo {
  /** 'webgl' | 'webgpu' | null when the renderer would not say. */
  backend: string | null;
  /**
   * The unmasked GPU string, where the browser allows it.
   *
   * The single most useful field here for a game that is GPU-bound, and the
   * least reliably available: Firefox gates the extension behind a pref and
   * Safari returns something generic. Null is a normal answer, not a failure.
   */
  gpu: string | null;
  cores: number | null;
  /** GiB, coarse and Chrome-only. Absent elsewhere. */
  memory: number | null;
  dpr: number;
  vw: number;
  vh: number;
  /** Coarse platform from Client Hints, falling back to nothing. Never the full UA. */
  platform: string | null;
  /** Whether the GPU timer extension was there, so absent timings can be read. */
  gpuTimer: boolean;
}

const MAX = 96;

function clip(s: string): string {
  return s.length > MAX ? s.slice(0, MAX) : s;
}

/**
 * Read the device once.
 *
 * Takes the live Pixi application rather than making its own context: a
 * throwaway WebGL context to read one string costs a real allocation on exactly
 * the machines least able to spare it, and `GpuTimer` already proves the context
 * can be reached from here.
 */
export function describeDevice(app: Application, gpuTimer: boolean): DeviceInfo {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { platform?: string };
  };

  let gpu: string | null = null;
  let backend: string | null = null;
  try {
    const renderer = app.renderer as unknown as {
      type?: number;
      name?: string;
      gl?: WebGL2RenderingContext;
      context?: { gl?: WebGL2RenderingContext };
    };
    backend = typeof renderer.name === 'string' ? renderer.name : null;
    const gl = renderer.gl ?? renderer.context?.gl ?? null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info') as {
        UNMASKED_RENDERER_WEBGL: number;
      } | null;
      const raw = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown) : null;
      if (typeof raw === 'string') gpu = clip(raw);
      if (!backend) backend = 'webgl';
    }
  } catch {
    // A locked-down browser, a lost context, a Pixi internal that moved. None of
    // it is worth a thrown error on the path that starts a run.
  }

  return {
    backend,
    gpu,
    cores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    dpr: Math.round((globalThis.devicePixelRatio ?? 1) * 100) / 100,
    vw: Math.round(globalThis.innerWidth ?? 0),
    vh: Math.round(globalThis.innerHeight ?? 0),
    platform:
      typeof nav.userAgentData?.platform === 'string' ? clip(nav.userAgentData.platform) : null,
    gpuTimer,
  };
}
