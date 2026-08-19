import { createTheme, type PaletteMode } from "@mui/material/styles";

export function createAdminTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? "#8ab4f8" : "#1f5fae" },
      success: { main: dark ? "#78c895" : "#247a45" },
      warning: { main: dark ? "#f5c56b" : "#9a5b00" },
      error: { main: dark ? "#ff8c84" : "#b3261e" },
      background: {
        default: dark ? "#111315" : "#f6f7f8",
        paper: dark ? "#1b1e21" : "#ffffff",
      },
      divider: dark ? "#383d42" : "#d9dde2",
    },
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 14,
      h1: { fontSize: "1.75rem", fontWeight: 700, lineHeight: 1.25, letterSpacing: 0 },
      h2: { fontSize: "1.05rem", fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
      h3: { fontSize: "0.95rem", fontWeight: 700, lineHeight: 1.35, letterSpacing: 0 },
      button: { fontWeight: 600, textTransform: "none", letterSpacing: 0 },
      caption: { letterSpacing: 0 },
      overline: { letterSpacing: 0, fontWeight: 700 },
    },
    components: {
      MuiButtonBase: {
        defaultProps: { disableRipple: true },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { minHeight: 36, borderRadius: 4 } },
      },
      MuiCard: {
        styleOverrides: { root: { borderRadius: 6, boxShadow: "none" } },
      },
      MuiPaper: {
        styleOverrides: { rounded: { borderRadius: 6 } },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { padding: "10px 12px", borderColor: dark ? "#383d42" : "#e4e7eb" },
          head: { fontWeight: 700, color: dark ? "#c7ccd1" : "#4e5965", background: dark ? "#22262a" : "#f5f6f7" },
        },
      },
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 4 } } },
      MuiChip: { styleOverrides: { root: { borderRadius: 4, fontWeight: 600 } } },
    },
  });
}
