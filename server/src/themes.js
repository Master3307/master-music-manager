// Built-in themes. Each sets the base colours for dark and/or light mode; the
// accent colour is the user's own setting unless a theme suggests one.
const t = (bg, bg2, surface, surface2, line, text, text2, text3) => ({ bg, 'bg-2': bg2, surface, 'surface-2': surface2, line, text, 'text-2': text2, 'text-3': text3 });

export const THEMES = [
  {
    id: 'midnight',
    name: 'Midnight',
    note: 'Deep blue-violet, easy on the eyes. The default.',
    dark: t('#14131c', '#191823', '#1f1e2b', '#272636', 'rgba(255,255,255,.07)', '#ecebf5', '#a9a7bd', '#727089'),
    light: t('#f5f4fa', '#eeedf5', '#ffffff', '#f2f1f8', 'rgba(20,16,50,.09)', '#1b1a26', '#55536b', '#8c8aa2'),
  },
  {
    id: 'oled',
    name: 'OLED',
    note: 'True black. Saves battery on OLED screens.',
    dark: t('#000000', '#060606', '#0d0d0f', '#16161a', 'rgba(255,255,255,.08)', '#f2f2f4', '#a3a3ab', '#6b6b75'),
  },
  {
    id: 'graphite',
    name: 'Graphite',
    note: 'Neutral greys, no colour cast.',
    dark: t('#161617', '#1b1b1c', '#222224', '#2b2b2e', 'rgba(255,255,255,.07)', '#ededee', '#a6a6ab', '#707075'),
    light: t('#f6f6f6', '#efefef', '#ffffff', '#f3f3f3', 'rgba(0,0,0,.09)', '#18181a', '#56565c', '#8d8d93'),
  },
  {
    id: 'nord',
    name: 'Nord',
    note: 'Cool arctic blues.',
    accent: '#88c0d0',
    dark: t('#242933', '#2a303b', '#2e3440', '#3b4252', 'rgba(216,222,233,.08)', '#eceff4', '#c2c8d4', '#8a93a5'),
    light: t('#eceff4', '#e5e9f0', '#ffffff', '#eef1f6', 'rgba(46,52,64,.10)', '#2e3440', '#4c566a', '#7b869b'),
  },
  {
    id: 'rose',
    name: 'Rosé',
    note: 'Muted pine and rose.',
    accent: '#ebbcba',
    dark: t('#191724', '#1f1d2e', '#232136', '#2a273f', 'rgba(224,222,244,.07)', '#e0def4', '#a8a4c4', '#6e6a86'),
    light: t('#faf4ed', '#f4ede8', '#fffaf3', '#f2e9e1', 'rgba(87,82,121,.10)', '#575279', '#797593', '#9893a5'),
  },
  {
    id: 'mocha',
    name: 'Mocha',
    note: 'Warm pastel on dark coffee.',
    accent: '#cba6f7',
    dark: t('#181825', '#1e1e2e', '#24243a', '#313244', 'rgba(205,214,244,.07)', '#cdd6f4', '#a6adc8', '#7f849c'),
    light: t('#eff1f5', '#e6e9ef', '#ffffff', '#eceef3', 'rgba(76,79,105,.10)', '#4c4f69', '#5c5f77', '#8c8fa1'),
  },
  {
    id: 'forest',
    name: 'Forest',
    note: 'Calm greens.',
    accent: '#7fbf8e',
    dark: t('#121815', '#161d19', '#1b241f', '#232e28', 'rgba(230,245,235,.07)', '#e6efe9', '#a5b8ab', '#6d8174'),
    light: t('#f3f6f3', '#ebf0ec', '#ffffff', '#eef3ef', 'rgba(20,50,30,.09)', '#18231c', '#4d5f53', '#86978b'),
  },
  {
    id: 'sunset',
    name: 'Sunset',
    note: 'Dusky orange and plum.',
    accent: '#ff8a5c',
    dark: t('#1a1418', '#20181d', '#271e24', '#31262d', 'rgba(255,235,225,.07)', '#f5e9e4', '#c4aaa5', '#8c726f'),
    light: t('#fbf5f1', '#f5ece6', '#ffffff', '#f6eee9', 'rgba(70,30,20,.09)', '#2a1c18', '#6b5550', '#a08b86'),
  },
  {
    id: 'paper',
    name: 'Paper',
    note: 'Warm, bookish light theme.',
    light: t('#f7f3ea', '#f0ebdf', '#fffdf8', '#f4efe4', 'rgba(60,45,20,.11)', '#2b2418', '#62584a', '#9a8f7d'),
  },
  {
    id: 'contrast',
    name: 'High contrast',
    note: 'Maximum legibility.',
    dark: t('#000000', '#000000', '#0a0a0a', '#1a1a1a', 'rgba(255,255,255,.35)', '#ffffff', '#e6e6e6', '#bdbdbd'),
    light: t('#ffffff', '#ffffff', '#ffffff', '#f0f0f0', 'rgba(0,0,0,.45)', '#000000', '#1a1a1a', '#404040'),
  },
];
