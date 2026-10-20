import type { TextStyle } from 'react-native';

export const colors = {
  red: '#FF2442', action: '#D91B38', redText: '#C51D39',
  ink: '#252522', muted: '#6D6963', border: '#E9E5DE',
  paper: '#FCFAF7', surface: '#FFFFFF', white: '#FFFFFF', blush: '#FFF0F2',
  green: '#32684E', successSoft: '#EDF5EF', danger: '#B42338',
  imagePlaceholder: '#EEE9E1', overlay: 'rgba(24,22,20,0.48)',
  heroOverlay: 'rgba(20,18,16,0.6)', glass: 'rgba(255,255,255,0.94)',
  viewerBg: '#111215', viewerCanvas: '#17191D', viewerSurface: '#24262C',
  viewerMuted: '#BBBFC8', viewerLine: '#3D4048', viewerSelected: '#4B2630', mask: '#FF244255',
} as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 12, md: 16, lg: 20 } as const;
export const type = {
  brand: { fontSize: 36, lineHeight: 44, fontWeight: '800', letterSpacing: 2 },
  reading: { fontSize: 15, lineHeight: 28 },
  title: { fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.6 },
  heading: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  subtitle: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 24 },
  label: { fontSize: 13, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 18 },
  badge: { fontSize: 11, lineHeight: 16, fontWeight: '600' },
  button: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
} satisfies Record<string, TextStyle>;
export const motion = { fast: 160, normal: 240, slow: 360, pulse: 1200 } as const;
export const layout = { touch: 44, thumbnailRatio: 3 / 4, maxWidth: 520 } as const;
