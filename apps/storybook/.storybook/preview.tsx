import type { Preview } from '@storybook/react-vite'
import { useEffect } from 'react'
import { mswLoader } from 'msw-storybook-addon/csf3'
import '../src/index.css'
import { mswHandlers } from './msw-handlers'

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'UI theme',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: ['light', 'dark'],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme ?? 'light'
      useEffect(() => {
        document.documentElement.classList.toggle('dark', theme === 'dark')
        return () => document.documentElement.classList.remove('dark')
      }, [theme])
      return <Story />
    },
  ],
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo'
    }
  },
  loaders: [mswLoader()],
  beforeEach({ msw }) {
    msw.use(...mswHandlers)
  },
};

export default preview;
