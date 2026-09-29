"use client";

import type { RankingInfo } from "@tanstack/match-sorter-utils";
import { compareItems, rankItem } from "@tanstack/match-sorter-utils";
import type {
	ColumnFiltersState,
	FilterFn,
	SortFn,
} from "@tanstack/react-table";
import { sortFns } from "@tanstack/react-table";
import { flexRender } from "@tanstack/react-table/flex-render";
import type {
	LegacyColumn as Column,
	LegacyColumnDef as ColumnDef,
	LegacyFeatures,
} from "@tanstack/react-table/legacy";
import {
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useLegacyTable as useReactTable,
} from "@tanstack/react-table/legacy";
import { Button } from "@vern/ui/components/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@vern/ui/components/card";
import { Input } from "@vern/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@vern/ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@vern/ui/components/table";
import React from "react";
import type { Person } from "@/data/demo-table-data";
import { makeData, makeSeededData } from "@/data/demo-table-data";

declare module "@tanstack/react-table" {
	interface FilterFns {
		fuzzy: FilterFn<LegacyFeatures, Person>;
	}
	interface FilterMeta {
		itemRank: RankingInfo;
	}
}

// Define a custom fuzzy filter function that will apply ranking info to rows (using match-sorter utils)
const fuzzyFilter: FilterFn<LegacyFeatures, Person> = (
	row,
	columnId,
	value,
	addMeta,
) => {
	// Rank the item
	const itemRank = rankItem(row.getValue(columnId), value);

	// Store the itemRank info
	addMeta?.({
		itemRank,
	});

	// Return if the item should be filtered in/out
	return itemRank.passed;
};

// Define a custom fuzzy sort function that will sort by rank if the row has ranking information
const fuzzySort: SortFn<LegacyFeatures, Person> = (rowA, rowB, columnId) => {
	let dir = 0;
	const rowARank = rowA.columnFiltersMeta[columnId]?.itemRank;
	const rowBRank = rowB.columnFiltersMeta[columnId]?.itemRank;

	// Only sort by rank if the column has ranking information
	if (rowARank && rowBRank) {
		dir = compareItems(rowARank, rowBRank);
	}

	// Provide an alphanumeric fallback for when the item ranks are equal
	return dir === 0 ? sortFns.alphanumeric(rowA, rowB, columnId) : dir;
};

export default function TableDemo() {
	const rerender = React.useReducer(() => ({}), {})[1];

	const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
		[],
	);
	const [globalFilter, setGlobalFilter] = React.useState("");

	const columns = React.useMemo<ColumnDef<Person, unknown>[]>(
		() => [
			{
				accessorKey: "id",
				filterFn: "equalsString", //note: normal non-fuzzy filter column - exact match required
			},
			{
				accessorKey: "firstName",
				cell: (info) => info.getValue(),
				filterFn: "includesStringSensitive", //note: normal non-fuzzy filter column - case sensitive
			},
			{
				accessorFn: (row) => row.lastName,
				id: "lastName",
				cell: (info) => info.getValue(),
				header: () => <span>Last Name</span>,
				filterFn: "includesString", //note: normal non-fuzzy filter column - case insensitive
			},
			{
				accessorFn: (row) => `${row.firstName} ${row.lastName}`,
				id: "fullName",
				header: "Full Name",
				cell: (info) => info.getValue(),
				filterFn: "fuzzy", //using our custom fuzzy filter function
				// filterFn: fuzzyFilter, //or just define with the function
				sortingFn: fuzzySort, //sort by fuzzy rank (falls back to alphanumeric)
			},
		],
		[],
	);

	const [data, setData] = React.useState<Person[]>(() =>
		makeSeededData(1, 5_000),
	);
	const refreshData = () => setData((_old) => makeData(50_000)); //stress test

	const table = useReactTable({
		data,
		columns,
		filterFns: {
			fuzzy: fuzzyFilter, //define as a filter function that can be used in column definitions
		},
		state: {
			columnFilters,
			globalFilter,
		},
		onColumnFiltersChange: setColumnFilters,
		onGlobalFilterChange: setGlobalFilter,
		globalFilterFn: "fuzzy", //apply fuzzy filter to the global filter (most common use case for fuzzy filter)
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(), //client side filtering
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		debugTable: true,
		debugHeaders: true,
		debugColumns: false,
	});

	//apply the fuzzy sort if the fullName column is being filtered
	React.useEffect(() => {
		if (columnFilters[0]?.id === "fullName") {
			if (table.getState().sorting[0]?.id !== "fullName") {
				table.setSorting([{ id: "fullName", desc: false }]);
			}
		}
	}, [columnFilters, table.getState, table.setSorting]);

	return (
		<main className="page-wrap px-4 py-12">
			<Card>
				<CardHeader className="gap-4">
					<div>
						<p className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
							TanStack Table
						</p>
						<CardTitle className="mb-4 text-3xl">Table Demo</CardTitle>
						<DebouncedInput
							value={globalFilter ?? ""}
							onChange={(value) => setGlobalFilter(String(value))}
							className="max-w-sm"
							placeholder="Search all columns..."
						/>
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					<Table className="min-w-[600px]">
						<TableHeader>
							{table.getHeaderGroups().map((headerGroup) => (
								<TableRow key={headerGroup.id}>
									{headerGroup.headers.map((header) => {
										return (
											<TableHead key={header.id} colSpan={header.colSpan}>
												{header.isPlaceholder ? null : (
													<>
														<div
															{...{
																className: header.column.getCanSort()
																	? "cursor-pointer select-none transition-colors hover:text-foreground"
																	: "",
																onClick:
																	header.column.getToggleSortingHandler(),
															}}
														>
															{flexRender(
																header.column.columnDef.header,
																header.getContext(),
															)}
															{{
																asc: " 🔼",
																desc: " 🔽",
															}[header.column.getIsSorted() as string] ?? null}
														</div>
														{header.column.getCanFilter() ? (
															<div className="mt-2">
																<Filter column={header.column} />
															</div>
														) : null}
													</>
												)}
											</TableHead>
										);
									})}
								</TableRow>
							))}
						</TableHeader>
						<TableBody>
							{table.getRowModel().rows.map((row) => {
								return (
									<TableRow key={row.id}>
										{row.getVisibleCells().map((cell) => {
											return (
												<TableCell key={cell.id}>
													{flexRender(
														cell.column.columnDef.cell,
														cell.getContext(),
													)}
												</TableCell>
											);
										})}
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
					<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
						<Button
							type="button"
							variant="outline"
							size="icon"
							onClick={() => table.setPageIndex(0)}
							disabled={!table.getCanPreviousPage()}
						>
							{"<<"}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon"
							onClick={() => table.previousPage()}
							disabled={!table.getCanPreviousPage()}
						>
							{"<"}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon"
							onClick={() => table.nextPage()}
							disabled={!table.getCanNextPage()}
						>
							{">"}
						</Button>
						<Button
							type="button"
							variant="outline"
							size="icon"
							onClick={() => table.setPageIndex(table.getPageCount() - 1)}
							disabled={!table.getCanNextPage()}
						>
							{">>"}
						</Button>
						<span className="flex items-center gap-1">
							<div>Page</div>
							<strong>
								{table.getState().pagination.pageIndex + 1} of{" "}
								{table.getPageCount()}
							</strong>
						</span>
						<span className="flex items-center gap-1">
							| Go to page:
							<Input
								type="number"
								className="h-8 w-20"
								defaultValue={table.getState().pagination.pageIndex + 1}
								onChange={(e) => {
									const page = e.target.value ? Number(e.target.value) - 1 : 0;
									table.setPageIndex(page);
								}}
							/>
						</span>
						<Select
							value={String(table.getState().pagination.pageSize)}
							onValueChange={(value) => table.setPageSize(Number(value))}
						>
							<SelectTrigger className="w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[10, 20, 30, 40, 50].map((pageSize) => (
									<SelectItem key={pageSize} value={String(pageSize)}>
										Show {pageSize}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="text-sm text-muted-foreground">
						{table.getPrePaginatedRowModel().rows.length} Rows
					</div>
					<div className="mt-4 flex gap-2">
						<Button type="button" onClick={() => rerender()} variant="outline">
							Force Rerender
						</Button>
						<Button
							type="button"
							onClick={() => refreshData()}
							variant="outline"
						>
							Refresh Data
						</Button>
					</div>
					<pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-xs">
						{JSON.stringify(
							{
								columnFilters: table.getState().columnFilters,
								globalFilter: table.getState().globalFilter,
							},
							null,
							2,
						)}
					</pre>
				</CardContent>
			</Card>
		</main>
	);
}

function Filter({ column }: { column: Column<Person, unknown> }) {
	const columnFilterValue = column.getFilterValue();

	return (
		<DebouncedInput
			type="text"
			value={(columnFilterValue ?? "") as string}
			onChange={(value) => column.setFilterValue(value)}
			placeholder={`Search...`}
			className="h-8"
		/>
	);
}

// A typical debounced input react component
function DebouncedInput({
	value: initialValue,
	onChange,
	debounce = 500,
	...props
}: {
	value: string | number;
	onChange: (value: string | number) => void;
	debounce?: number;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange">) {
	const [value, setValue] = React.useState(initialValue);

	React.useEffect(() => {
		setValue(initialValue);
	}, [initialValue]);

	React.useEffect(() => {
		const timeout = setTimeout(() => {
			onChange(value);
		}, debounce);

		return () => clearTimeout(timeout);
	}, [value, onChange, debounce]);

	return (
		<Input
			{...props}
			value={value}
			onChange={(e) => setValue(e.target.value)}
		/>
	);
}
