import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from '@vern/ui/components/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@vern/ui/components/card'

const meta = {
  title: 'UI/Card',
  component: Card,
  tags: ['autodocs'],
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card className="w-80">
      <CardHeader>
        <CardTitle>Workspace members</CardTitle>
        <CardDescription>Manage who can access this workspace.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm">3 of 5 seats are currently in use.</p>
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button size="sm">Manage members</Button>
      </CardFooter>
    </Card>
  ),
}
