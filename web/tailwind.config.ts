import type { Config } from 'tailwindcss'

export default <Partial<Config>>{
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Warm amber accent — daylight, not the usual AI blue.
        brand: {
          50: '#fef8ec',
          100: '#fcecc9',
          200: '#f9d98e',
          300: '#f5c153',
          400: '#f2a93b',
          500: '#e08c18',
          600: '#c26c12',
          700: '#9b4f13',
          800: '#7f3f16',
          900: '#6b3415',
          950: '#3d1a08',
        },
        ink: {
          950: '#0b0b0c',
          900: '#121214',
          800: '#1a1a1d',
          700: '#26262b',
          600: '#3a3a42',
        },
      },
    },
  },
}
