import type { Meta, StoryObj } from '@storybook/react-vite'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { expect, waitFor } from 'storybook/test'
import { z } from 'zod'
import { Button } from '@vern/ui/components/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@vern/ui/components/form-rhf'
import { Input } from '@vern/ui/components/input'

const schema = z.object({
  email: z.email('Enter a valid email address'),
})

function InvoiceEmailForm() {
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  })

  return (
    <Form {...form}>
      <form noValidate className="grid w-72 gap-4" onSubmit={form.handleSubmit(() => {})}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" {...field} />
              </FormControl>
              <FormDescription>Invoices are sent to this address.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Save</Button>
      </form>
    </Form>
  )
}

const meta = {
  title: 'UI/Form/React Hook Form',
  component: InvoiceEmailForm,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof InvoiceEmailForm>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    const input = canvas.getByLabelText('Email')
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }))
    await expect(await canvas.findByText('Enter a valid email address')).toBeVisible()
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await userEvent.type(input, 'ada@example.com')
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'false'))
    await expect(canvas.queryByText('Enter a valid email address')).toBeNull()
  },
}
