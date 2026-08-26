/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Outfit", "system-ui", "sans-serif"],
      },
      colors: {
        paper: "#131316",
        surface: {
          DEFAULT: "#1c1c21",
          muted: "#24242b",
        },
        ink: {
          DEFAULT: "#ececf1",
          muted: "#a2a2ae",
          light: "#70707d",
        },
        glass: {
          DEFAULT: "rgba(19,19,22,0.82)",
          stroke: "rgba(255,255,255,0.07)",
          hover: "rgba(255,255,255,0.04)",
        },
        rail: "#0e0e11",
        accent: {
          DEFAULT: "#3b82f6",
          light: "#60a5fa",
          muted: "rgba(59,130,246,0.12)",
        },
        danger: {
          DEFAULT: "#dc2626",
          muted: "rgba(220,38,38,0.08)",
        },
        success: {
          DEFAULT: "#16a34a",
          muted: "rgba(22,163,74,0.08)",
        },
        warn: {
          DEFAULT: "#d97706",
          muted: "rgba(217,119,6,0.08)",
        },
      },
      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
      },
      boxShadow: {
        "soft": "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
        "medium": "0 4px 12px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.03)",
        "lifted": "0 8px 30px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.03)",
        "glow-blue": "0 0 20px rgba(37,99,235,0.15)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(20px) scale(0.98)", filter: "blur(3px)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)", filter: "blur(0)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(28px)", filter: "blur(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.94)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(37,99,235,0.1)" },
          "50%": { boxShadow: "0 0 20px rgba(37,99,235,0.2)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.8s cubic-bezier(0.32,0.72,0,1) forwards",
        "fade-up": "fade-up 0.8s cubic-bezier(0.32,0.72,0,1) forwards",
        "scale-in": "scale-in 0.6s cubic-bezier(0.32,0.72,0,1) forwards",
        shimmer: "shimmer 2.5s infinite linear",
        "pulse-glow": "pulse-glow 2s cubic-bezier(0.4,0,0.6,1) infinite",
      },
    },
  },
  plugins: [],
};
