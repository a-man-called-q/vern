import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@vern/ui/components/sidebar'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vern/ui/components/table'

const meta = {
  title: 'UI/Sidebar',
  component: Sidebar,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

const columns = [
  'Campaign',
  'Advertiser',
  'Placement',
  'Start',
  'End',
  'Budget',
  'Spend',
  'Impressions',
  'Clicks',
  'Status',
]

const rows = Array.from({ length: 4 }, (_, index) => index + 1)

export const Default: Story = {
  render: () => (
    <SidebarProvider>
      <Sidebar variant="inset">
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>Campaigns</SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton>Reports</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <h1 className="text-base font-medium">Campaigns</h1>
        </header>
        <div className="p-4">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column} className="whitespace-nowrap">
                    {column}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row}>
                  {columns.map((column) => (
                    <TableCell key={column} className="whitespace-nowrap">
                      {column} {row}, a value that does not wrap
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ),
  // SidebarInset is a flex item: without min-w-0 the wide table sizes it to the
  // table's own width and the page scrolls sideways instead of the table. Only a
  // docked sidebar (md and up) narrows the slot, so this needs a wide viewport;
  // vite.config.ts sets one for the tests.
  play: async ({ canvasElement }) => {
    const inset = canvasElement.querySelector('[data-slot="sidebar-inset"]')
    await expect(inset).not.toBeNull()
    const root = canvasElement.ownerDocument.documentElement
    await expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth)
  },
}
