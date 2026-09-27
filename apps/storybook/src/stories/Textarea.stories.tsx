import type { Meta, StoryObj } from '@storybook/react-vite'
import { Textarea } from '@vern/ui/components/textarea'

const meta = {
  title: 'UI/Textarea',
  component: Textarea,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
  args: { placeholder: 'Write a message…' },
} satisfies Meta<typeof Textarea>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Invalid: Story = { args: { 'aria-invalid': true, value: 'Please review this value.' } }
export const Disabled: Story = { args: { disabled: true, value: 'Unavailable' } }
