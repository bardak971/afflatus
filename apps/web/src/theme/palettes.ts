/**
 * The colours of the palettes the themes are made from, as their authors publish them.
 *
 * Catppuccin: https://github.com/catppuccin/catppuccin (MIT License, Copyright (c) 2021 Catppuccin)
 * Rosé Pine: https://github.com/rose-pine/rose-pine-theme (MIT License, Copyright (c) 2023 Rosé Pine)
 * Tokyo Night: https://github.com/folke/tokyonight.nvim (Apache License 2.0, Copyright (c) folke)
 * Kanagawa: https://github.com/rebelot/kanagawa.nvim (MIT License, Copyright (c) 2021 Tommaso Laurenzi)
 *
 * Catppuccin's and Rosé Pine's are generated from their palette.json files; Tokyo Night's and Kanagawa's
 * are copied from their colour files, under their own names. None is edited by hand.
 */

export const catppuccin = {
  latte: { rosewater: "#dc8a78", flamingo: "#dd7878", pink: "#ea76cb", mauve: "#8839ef", red: "#d20f39", maroon: "#e64553", peach: "#fe640b", yellow: "#df8e1d", green: "#40a02b", teal: "#179299", sky: "#04a5e5", sapphire: "#209fb5", blue: "#1e66f5", lavender: "#7287fd", text: "#4c4f69", subtext1: "#5c5f77", subtext0: "#6c6f85", overlay2: "#7c7f93", overlay1: "#8c8fa1", overlay0: "#9ca0b0", surface2: "#acb0be", surface1: "#bcc0cc", surface0: "#ccd0da", base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8" },
  frappe: { rosewater: "#f2d5cf", flamingo: "#eebebe", pink: "#f4b8e4", mauve: "#ca9ee6", red: "#e78284", maroon: "#ea999c", peach: "#ef9f76", yellow: "#e5c890", green: "#a6d189", teal: "#81c8be", sky: "#99d1db", sapphire: "#85c1dc", blue: "#8caaee", lavender: "#babbf1", text: "#c6d0f5", subtext1: "#b5bfe2", subtext0: "#a5adce", overlay2: "#949cbb", overlay1: "#838ba7", overlay0: "#737994", surface2: "#626880", surface1: "#51576d", surface0: "#414559", base: "#303446", mantle: "#292c3c", crust: "#232634" },
  macchiato: { rosewater: "#f4dbd6", flamingo: "#f0c6c6", pink: "#f5bde6", mauve: "#c6a0f6", red: "#ed8796", maroon: "#ee99a0", peach: "#f5a97f", yellow: "#eed49f", green: "#a6da95", teal: "#8bd5ca", sky: "#91d7e3", sapphire: "#7dc4e4", blue: "#8aadf4", lavender: "#b7bdf8", text: "#cad3f5", subtext1: "#b8c0e0", subtext0: "#a5adcb", overlay2: "#939ab7", overlay1: "#8087a2", overlay0: "#6e738d", surface2: "#5b6078", surface1: "#494d64", surface0: "#363a4f", base: "#24273a", mantle: "#1e2030", crust: "#181926" },
  mocha: { rosewater: "#f5e0dc", flamingo: "#f2cdcd", pink: "#f5c2e7", mauve: "#cba6f7", red: "#f38ba8", maroon: "#eba0ac", peach: "#fab387", yellow: "#f9e2af", green: "#a6e3a1", teal: "#94e2d5", sky: "#89dceb", sapphire: "#74c7ec", blue: "#89b4fa", lavender: "#b4befe", text: "#cdd6f4", subtext1: "#bac2de", subtext0: "#a6adc8", overlay2: "#9399b2", overlay1: "#7f849c", overlay0: "#6c7086", surface2: "#585b70", surface1: "#45475a", surface0: "#313244", base: "#1e1e2e", mantle: "#181825", crust: "#11111b" },
} as const;

export const rosePine = {
  main: { base: "#191724", surface: "#1f1d2e", overlay: "#26233a", muted: "#6e6a86", subtle: "#908caa", text: "#e0def4", love: "#eb6f92", gold: "#f6c177", rose: "#ebbcba", pine: "#31748f", foam: "#9ccfd8", iris: "#c4a7e7" },
  moon: { base: "#232136", surface: "#2a273f", overlay: "#393552", muted: "#6e6a86", subtle: "#908caa", text: "#e0def4", love: "#eb6f92", gold: "#f6c177", rose: "#ea9a97", pine: "#3e8fb0", foam: "#9ccfd8", iris: "#c4a7e7" },
  dawn: { base: "#faf4ed", surface: "#fffaf3", overlay: "#f2e9e1", muted: "#9893a5", subtle: "#797593", text: "#464261", love: "#b4637a", gold: "#ea9d34", rose: "#d7827e", pine: "#286983", foam: "#56949f", iris: "#907aa9" },
} as const;

export const tokyoNight = {
  night: { bg: "#1a1b26", bg_dark: "#16161e", bg_highlight: "#292e42", terminal_black: "#414868", fg: "#c0caf5", fg_dark: "#a9b1d6", fg_gutter: "#3b4261", comment: "#565f89", dark3: "#545c7e", dark5: "#737aa2", blue: "#7aa2f7", cyan: "#7dcfff", magenta: "#bb9af7", purple: "#9d7cd8", green: "#9ece6a", teal: "#1abc9c", orange: "#ff9e64", yellow: "#e0af68", red: "#f7768e" },
  day: { bg: "#e1e2e7", bg_dark: "#d0d5e3", bg_highlight: "#c4c8da", fg: "#3760bf", fg_dark: "#6172b0", fg_gutter: "#a8aecb", comment: "#848cb5", blue: "#2e7de9", cyan: "#007197", magenta: "#9854f1", purple: "#7847bd", green: "#587539", teal: "#118c74", orange: "#b15c00", yellow: "#8c6c3e", red: "#f52a65" },
} as const;

export const kanagawa = {
  wave: { sumiInk0: "#16161d", sumiInk3: "#1f1f28", sumiInk4: "#2a2a37", sumiInk5: "#363646", sumiInk6: "#54546d", fujiWhite: "#dcd7ba", oldWhite: "#c8c093", fujiGray: "#727169", crystalBlue: "#7e9cd8", oniViolet: "#957fb8", springGreen: "#98bb6c", carpYellow: "#e6c384", surimiOrange: "#ffa066", waveRed: "#e46876", sakuraPink: "#d27e99", waveAqua2: "#7aa89f" },
  lotus: { lotusWhite0: "#d5cea3", lotusWhite1: "#dcd5ac", lotusWhite2: "#e5ddb0", lotusWhite3: "#f2ecbc", lotusWhite4: "#e7dba0", lotusInk1: "#545464", lotusInk2: "#43436c", lotusGray3: "#8a8980", lotusBlue4: "#4d699b", lotusViolet4: "#624c83", lotusGreen: "#6f894e", lotusYellow: "#77713f", lotusOrange: "#cc6d00", lotusRed: "#c84053", lotusPink: "#b35b79", lotusAqua: "#597b75" },
} as const;
