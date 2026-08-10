/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,ts,tsx}", "./web/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      // Apple-minimal, monochrome (P2W-05 decision 2026-08-04): near-black ink on white,
      // one warm off-white surface, hairline borders. Colour is used only sparingly for
      // entity highlights. Everything else is Tailwind's neutral/zinc scale + black.
      colors: {
        ink: "#0a0a0a",
        surface: "#fafafa",
        hairline: "#ededed",
        // Category-highlight tint backgrounds (category-control layer): 3 base hues x 2 shades. Pills and
        // legend swatches use these as BACKGROUNDS with near-black `text-ink` on top (see FAMILY_PILL_CLASS)
        // — near-black text clears AA against every tint (>=10:1) and stays passing even while the result
        // panel fades in. rose = hard identifiers, blue = who/where (NER), teal = contact & loose numbers.
        "cat-rose-dark-bg": "#fda4af",
        "cat-rose-light-bg": "#ffe4e6",
        "cat-blue-dark-bg": "#93c5fd",
        "cat-blue-light-bg": "#dbeafe",
        "cat-teal-dark-bg": "#5eead4",
        "cat-teal-light-bg": "#ccfbf1",
      },
      borderRadius: {
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -12px rgba(0,0,0,0.10)",
      },
    },
  },
  plugins: [],
};
