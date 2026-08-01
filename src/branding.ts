/**
 * Every player-facing name lives here and nowhere else.
 *
 * GDD §25.1: the title is an open decision with trademark risk. "OVERCLOCK" is a
 * placeholder. Nothing outside this file may hardcode it — swapping the title
 * must remain a one-line change forever.
 */
export const BRANDING = {
  title: 'OVERCLOCK',
  titleShort: 'OC',
  tagline: 'the player is the exploit',
} as const;
