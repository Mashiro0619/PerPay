import { alpha, createTheme, type PaletteMode } from "@mui/material/styles";

const UI_FONT = [
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"Noto Sans CJK SC"',
  '"Source Han Sans SC"',
  '"PingFang SC"',
  "system-ui",
  "sans-serif",
].join(", ");

export function createAdminTheme(mode: PaletteMode, brandFontUrl?: string) {
  const dark = mode === "dark";
  const primary = dark ? "#f5f5f5" : "#171717";
  const primaryContrast = dark ? "#171717" : "#ffffff";
  const secondary = dark ? "#a3a3a3" : "#525252";
  const divider = dark ? "#2d2d2f" : "#dededb";
  const paper = dark ? "#171718" : "#ffffff";
  const canvas = dark ? "#101011" : "#f5f5f3";
  const ink = dark ? "#f4f4f5" : "#18181b";
  const muted = dark ? "#a3a3a3" : "#616161";

  return createTheme({
    palette: {
      mode,
      primary: { main: primary, contrastText: primaryContrast },
      secondary: { main: secondary, contrastText: dark ? "#18181b" : "#ffffff" },
      success: { main: dark ? "#86efac" : "#24734a" },
      warning: { main: dark ? "#facc15" : "#946c00" },
      error: { main: dark ? "#fca5a5" : "#b42318" },
      info: { main: dark ? "#a1a1aa" : "#525252" },
      text: {
        primary: ink,
        secondary: muted,
      },
      background: {
        default: canvas,
        paper,
      },
      divider,
      action: { hover: alpha(primary, dark ? 0.14 : 0.07), selected: alpha(primary, dark ? 0.22 : 0.11), focus: alpha(primary, 0.24) },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: UI_FONT,
      fontSize: 14,
      h1: { fontSize: "1.65rem", fontWeight: 760, lineHeight: 1.24, letterSpacing: "-0.025em" },
      h2: { fontSize: "1.05rem", fontWeight: 740, lineHeight: 1.35, letterSpacing: "-0.01em" },
      h3: { fontSize: "0.92rem", fontWeight: 720, lineHeight: 1.4, letterSpacing: 0 },
      body1: { lineHeight: 1.62, letterSpacing: 0 },
      body2: { lineHeight: 1.55, letterSpacing: 0 },
      button: { fontWeight: 720, textTransform: "none", letterSpacing: 0 },
      caption: { lineHeight: 1.5, letterSpacing: 0 },
      overline: { fontWeight: 700, letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ...(brandFontUrl ? {
            "@font-face": {
              fontFamily: "Meddon",
              src: `url(${JSON.stringify(brandFontUrl)}) format("woff2")`,
              fontWeight: 400,
              fontStyle: "normal",
              fontDisplay: "swap",
            },
          } : {}),
          html: { colorScheme: mode },
          body: {
            minWidth: 320,
            backgroundColor: canvas,
            fontFamily: UI_FONT,
            fontVariantNumeric: "tabular-nums",
            textRendering: "optimizeLegibility",
            WebkitFontSmoothing: "antialiased",
          },
          "a": { color: "inherit" },
          "::selection": {
            color: primaryContrast,
            backgroundColor: alpha(primary, dark ? 0.5 : 0.25),
          },
          "*": {
            scrollbarColor: `${dark ? "#555d68" : "#b7bec8"} transparent`,
            scrollbarWidth: "thin",
          },
          "@media (prefers-reduced-motion: reduce)": {
            "*, *::before, *::after": {
              animationDuration: "0.01ms !important",
              animationIterationCount: "1 !important",
              scrollBehavior: "auto !important",
              transitionDuration: "0.01ms !important",
            },
          },
        },
      },
      MuiButtonBase: {
        styleOverrides: {
          root: {
            "&.Mui-focusVisible": {
              outline: `2px solid ${primary}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, disableRipple: false },
        styleOverrides: {
          root: {
            minHeight: 44,
            minWidth: 0,
            borderRadius: 7,
            paddingInline: 13,
            whiteSpace: "nowrap",
            flexShrink: 0,
          },
          sizeSmall: { minHeight: 34, paddingInline: 11, borderRadius: 6 },
          contained: { boxShadow: "none" },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { width: 40, height: 40, borderRadius: 7 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none" },
          rounded: { borderRadius: 8 },
          outlined: { borderColor: divider },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            boxShadow: "none",
            border: `1px solid ${divider}`,
          },
        },
      },
      MuiCardContent: {
        styleOverrides: {
          root: { padding: 18, "&:last-child": { paddingBottom: 18 } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { minHeight: 42, borderRadius: 7, backgroundColor: paper },
          input: {
            paddingTop: 9,
            paddingBottom: 9,
            "&:-webkit-autofill": {
              WebkitBoxShadow: `0 0 0 100px ${paper} inset`,
              WebkitTextFillColor: ink,
              caretColor: ink,
              borderRadius: 8,
              transition: "background-color 10000s ease-out 0s",
            },
          },
        },
      },
      MuiInputLabel: {
        styleOverrides: { root: { fontWeight: 500 } },
      },
      MuiTextField: { defaultProps: { size: "small", variant: "outlined" } },
      MuiSelect: { defaultProps: { size: "small", variant: "outlined" } },
      MuiMenu: {
        defaultProps: { elevation: 8 },
        styleOverrides: {
          paper: {
            marginTop: 4,
            border: `1px solid ${divider}`,
            borderRadius: 7,
            boxShadow: dark
              ? "0 12px 32px rgba(0, 0, 0, 0.38)"
              : "0 12px 32px rgba(27, 37, 51, 0.16)",
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: 40,
            fontSize: "0.875rem",
            "&.Mui-selected": { fontWeight: 650 },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 44,
            borderRadius: 10,
            marginBottom: 2,
            transition: "background-color 160ms ease-out, color 160ms ease-out",
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 44 },
          indicator: { height: 2 },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minHeight: 44,
            minWidth: 0,
            paddingInline: 16,
            textTransform: "none",
            fontWeight: 650,
          },
        },
      },
      MuiStack: {
        defaultProps: { useFlexGap: true },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            padding: "10px 13px",
            borderColor: divider,
            verticalAlign: "middle",
          },
          head: {
            color: dark ? "#d4d4d8" : "#52525b",
            backgroundColor: dark ? "#202022" : "#f7f7f5",
            fontWeight: 700,
            whiteSpace: "nowrap",
          },
        },
      },
      MuiTableRow: {
        styleOverrides: { root: { "&:last-child td": { borderBottom: 0 } } },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 12, alignItems: "flex-start", border: `1px solid ${divider}` },
          message: { minWidth: 0 },
        },
      },
      MuiChip: {
        styleOverrides: { root: { height: 27, borderRadius: 8, fontWeight: 720 } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true, enterDelay: 450 },
        styleOverrides: { tooltip: { fontSize: "0.75rem" } },
      },
      MuiDivider: {
        styleOverrides: { root: { borderColor: divider } },
      },
    },
  });
}
