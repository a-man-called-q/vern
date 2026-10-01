import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, waitFor } from 'storybook/test'
import { z } from 'zod'
import { Button } from '@vern/ui/components/button'
import { useAppForm } from '@vern/ui/components/form-tanstack'
import { Input } from '@vern/ui/components/input'

const schema = z.object({
  email: z.email('Enter a valid email address'),
})

function InvoiceEmailForm() {
  const form = useAppForm({
    defaultValues: { email: '' },
    validators: { onChange: schema },
  })

  return (
    <form.AppForm>
      <form.Form className="grid w-72 gap-4">
        <form.AppField name="email">
          {(field) => (
            <field.FormItem>
              <field.FormLabel>Email</field.FormLabel>
              <field.FormControl>
                <Input
                  type="email"
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </field.FormControl>
              <field.FormDescription>Invoices are sent to this address.</field.FormDescription>
              <field.FormMessage />
            </field.FormItem>
          )}
        </form.AppField>
        <Button type="submit">Save</Button>
      </form.Form>
    </form.AppForm>
  )
}

const meta = {
  title: 'UI/Form/TanStack Form',
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
