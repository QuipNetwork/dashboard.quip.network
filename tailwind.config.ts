import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "./.ladle/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          gray: {
            0: "#1A1A1A",
            1: "#282828",
            2: "#525252",
            3: "#A9A9A9",
            4: "#DCDCDC",
            5: "#F2F2F2",
            6: "#FFFFFF",
          },
          green: {
            0: "#67E347",
            1: "#EEFF64",
            2: "#EEFDCA",
          },
          yellow: {
            0: "#FFDE53",
            1: "#FEF278",
            2: "#FFFCDA",
          },
          red: {
            0: "#FF6C78",
            1: "#FFE2DA",
            2: "#FFEDEE",
          },
          pink: {
            0: "#FF92D5",
            1: "#FFCDE4",
            2: "#FFE7FB",
          },
          magenta: {
            0: "#A5C3D4",
            1: "#C4E4FC",
            2: "#E6D7FF",
          },
          blue: {
            0: "#4CE0FF",
            1: "#C2F8FD",
            2: "#F3FEFF",
          },
        },
      },
      fontFamily: {
        heading: ["ABC Gaisyr", "serif"],
        accent: ["ABC Favotit Mono", "monospace"],
        body: ["ABC Favotit", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
