/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Plus Jakarta Sans", "system-ui", "sans-serif"],
      },
      colors: {
        paper: "#f8f8f6",
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f4f4f2",
        },
        ink: {
          DEFAULT: "#1a1a1a",
          muted: "#888885",
          light: "#b0b0ad",
        },
        glass: {
          DEFAULT: "rgba(255,255,255,0.8)",
          stroke: "rgba(0,0,0,0.06)",
          hover: "rgba(0,0,0,0.03)",
        },
        // shadcn/ui (OpenVideo editor) semantic tokens
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: {
          DEFAULT: "var(--card)",
          foreground: "var(--card-foreground)",
        },
        popover: {
          DEFAULT: "var(--popover)",
          foreground: "var(--popover-foreground)",
        },
        primary: {
          DEFAULT: "var(--primary)",
          foreground: "var(--primary-foreground)",
        },
        secondary: {
          DEFAULT: "var(--secondary)",
          foreground: "var(--secondary-foreground)",
        },
        muted: {
          DEFAULT: "var(--muted)",
          foreground: "var(--muted-foreground)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          foreground: "var(--accent-foreground)",
        },
        destructive: {
          DEFAULT: "var(--destructive)",
          foreground: "var(--destructive-foreground)",
        },
        border: "var(--border)",
        input: "var(--input)",
        ring: "var(--ring)",
        chart: {
          1: "var(--chart-1)",
          2: "var(--chart-2)",
          3: "var(--chart-3)",
          4: "var(--chart-4)",
          5: "var(--chart-5)",
        },
        sidebar: {
          DEFAULT: "var(--sidebar)",
          foreground: "var(--sidebar-foreground)",
          primary: "var(--sidebar-primary)",
          "primary-foreground": "var(--sidebar-primary-foreground)",
          accent: "var(--sidebar-accent)",
          "accent-foreground": "var(--sidebar-accent-foreground)",
          border: "var(--sidebar-border)",
          ring: "var(--sidebar-ring)",
        },
        "openvideo-gray": "var(--openvideo-gray)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(24px) scale(0.98)", filter: "blur(4px)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)", filter: "blur(0)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(32px)", filter: "blur(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.92)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "pulse-glow": {
          "0%, 100%": { boxShadow: "0 0 8px rgba(59,130,246,0.12)" },
          "50%": { boxShadow: "0 0 20px rgba(59,130,246,0.25)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.9s cubic-bezier(0.32,0.72,0,1) forwards",
        "fade-up": "fade-up 0.9s cubic-bezier(0.32,0.72,0,1) forwards",
        "scale-in": "scale-in 0.7s cubic-bezier(0.32,0.72,0,1) forwards",
        shimmer: "shimmer 2.5s infinite linear",
        "pulse-glow": "pulse-glow 2s cubic-bezier(0.4,0,0.6,1) infinite",
      },
    },
  },
  plugins: [],
};
