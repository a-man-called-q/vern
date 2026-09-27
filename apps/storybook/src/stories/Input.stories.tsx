import type { Meta, StoryObj } from '@storybook/react-vite'
import { Input } from '@vern/ui/components/input'

const meta = {
  title: 'UI/Input',
  component: Input,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { placeholder: 'Type something…' },
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Invalid: Story = { args: { 'aria-invalid': true, value: 'Invalid value' } }
export const Disabled: Story = { args: { disabled: true, value: 'Unavailable' } }
