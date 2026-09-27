import type { StoryObj } from '@storybook/react-vite'
import { Slider } from '@vern/ui/components/slider'

const meta = {
  title: 'UI/Slider',
  component: Slider,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { defaultValue: [50], max: 100, step: 1, 'aria-label': 'Volume' },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = { args: { className: 'w-72' } }
export const Disabled: Story = { args: { className: 'w-72', disabled: true } }
