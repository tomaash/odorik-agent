import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'

export const ErikPreset = definePreset(Aura, {
  primitive: {
    borderRadius: {
      none: '0',
      xs: '2px',
      sm: '4px',
      md: '6px',
      lg: '8px',
      xl: '10px',
    },
  },
  semantic: {
    primary: {
      50: '{indigo.50}',
      100: '{indigo.100}',
      200: '{indigo.200}',
      300: '{indigo.300}',
      400: '{indigo.400}',
      500: '{indigo.500}',
      600: '{indigo.600}',
      700: '{indigo.700}',
      800: '{indigo.800}',
      900: '{indigo.900}',
      950: '{indigo.950}',
    },
    colorScheme: {
      light: {
        surface: {
          0: '#ffffff',
          50: '#faf9f6',
          100: '#f4f2ee',
          200: '#e3e1dc',
          300: '#d2cfc8',
          400: '#aaa69e',
          500: '#827e76',
          600: '#625f59',
          700: '#46433f',
          800: '#2e2c29',
          900: '#1d1c1a',
          950: '#11110f',
        },
      },
    },
  },
})
