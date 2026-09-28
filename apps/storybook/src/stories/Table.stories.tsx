import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@vern/ui/components/table";

const meta = {
	title: "UI/Table",
	component: Table,
	tags: ["autodocs"],
	parameters: { layout: "padded" },
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Name</TableHead>
					<TableHead>Status</TableHead>
					<TableHead className="text-right">Amount</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell>Invoice #1001</TableCell>
					<TableCell>Paid</TableCell>
					<TableCell className="text-right">$250.00</TableCell>
				</TableRow>
				<TableRow>
					<TableCell>Invoice #1002</TableCell>
					<TableCell>Pending</TableCell>
					<TableCell className="text-right">$125.00</TableCell>
				</TableRow>
			</TableBody>
		</Table>
	),
};
