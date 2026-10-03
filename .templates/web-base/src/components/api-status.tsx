const STATUS = {
	connected: { label: "Connected", color: "bg-emerald-500" },
	"not-configured": { label: "Not configured", color: "bg-amber-500" },
	unavailable: { label: "Unavailable", color: "bg-rose-500" },
};

/** Whether the app reaches its API as the signed-in user, in the sidebar's foot. */
export function ApiStatus({ status }: { status: keyof typeof STATUS }) {
	const { label, color } = STATUS[status];

	return (
		<div className="mx-2 rounded-lg border border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5">
			<div className="flex items-center gap-2 text-xs font-medium">
				<span aria-hidden="true" className={`size-1.5 rounded-full ${color}`} />
				API connection
				<span className="ml-auto text-sidebar-foreground/60">{label}</span>
			</div>
		</div>
	);
}
