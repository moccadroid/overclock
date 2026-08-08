/**
 * What a row of the configuration sheet does when you press it.
 *
 * Extracted from the terminal so the desk and the terminal share one
 * implementation. There is a lot of it — fifteen rows, four of them continuous,
 * three cycling through lists, and one that opens another screen — and two copies
 * of that would have drifted the first time a setting was added to either.
 *
 * `d` is the direction: +1 or −1 for the continuous and cycling rows, and either
 * for a toggle. A click sends +1, which is why clicking a toggle works at all.
 */
import type { Audio } from '../../audio/audio';
import type { Library } from '../../meta/profile';
import { PHOSPHOR } from '../ui';
import { VIEW_EFFECTS, VIEW_PRESETS, applyEffects } from '../visual';
import { DISPLAY, GAMMA_STEP, setGamma } from '../gfx/display';

export interface SettingsHost {
  library: Library;
  audio: Audio;
  /** Re-read the glass settings onto whatever filters the caller owns. */
  applyGlass: () => void;
  /** Open the calibration screen. The one row that is not a value. */
  openCalibration: () => void;
}

/**
 * The preset whose effect set matches what is currently on, or `custom`.
 *
 * Order-insensitive: the Library stores whatever order the toggles were flipped
 * in, and a preset is a *set*.
 */
function presetIdFor(fx: readonly string[]): string {
  const b = [...fx].sort().join(',');
  return VIEW_PRESETS.find((p) => [...p.effects].sort().join(',') === b)?.id ?? 'custom';
}

/**
 * Move one setting. Returns true if anything changed, so the caller knows
 * whether to redraw and whether to make a noise.
 */
export function adjustSetting(id: string, d: number, host: SettingsHost): boolean {
  const { library, audio } = host;
  const s = library.snapshot.settings;
  const step = (v: number): number =>
    Math.max(0, Math.min(1, Math.round((v + d * 0.05) * 100) / 100));

  switch (id) {
    case 'muted':
      library.setAudio({ muted: !s.muted });
      audio.setMuted(!s.muted);
      return true;
    case 'volume': {
      const v = step(s.volume);
      library.setAudio({ volume: v });
      audio.setVolume(v);
      return true;
    }
    case 'music': {
      const v = step(s.music);
      library.setAudio({ music: v });
      audio.setMusicVolume(v);
      return true;
    }
    case 'effects': {
      const v = step(s.effects);
      library.setAudio({ effects: v });
      audio.setSfxVolume(v);
      return true;
    }
    case 'preset': {
      const ids = VIEW_PRESETS.map((p) => p.id);
      const cur = Math.max(0, ids.indexOf(presetIdFor(s.fx)));
      const next = VIEW_PRESETS[(cur + d + ids.length) % ids.length]!;
      library.setEffects(next.effects);
      applyEffects(next.effects);
      return true;
    }
    case 'beatSync':
      library.setBeatSync(!s.beatSync);
      return true;
    case 'phosphor': {
      const i = Math.max(
        0,
        PHOSPHOR.findIndex((p) => p.id === s.phosphor),
      );
      const next = PHOSPHOR[(i + d + PHOSPHOR.length) % PHOSPHOR.length]!;
      library.setGlass({ phosphor: next.id });
      host.applyGlass();
      return true;
    }
    case 'scanlines':
      library.setGlass({ scanlines: step(s.scanlines) });
      host.applyGlass();
      return true;
    case 'gamma':
      // Straight onto the live setting rather than through `s`: the Library is
      // where it is *kept*, but `DISPLAY` is where it is, and the two only agree
      // because this line puts the clamped result back.
      library.setDisplay({ gamma: setGamma(DISPLAY.gamma + d * GAMMA_STEP) });
      return true;
    case 'calibrate':
      host.openCalibration();
      return false;
    default:
      if (id.startsWith('fx:')) {
        const fx = id.slice(3);
        if (VIEW_EFFECTS.some((e) => e.id === fx)) {
          library.toggleEffect(fx);
          applyEffects(library.snapshot.settings.fx);
          return true;
        }
      }
      return false;
  }
}
