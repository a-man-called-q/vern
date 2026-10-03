import type { ReactNode } from "react";

export type SiteFooterProps = {
	siteName: string;
	/** A line beside the copyright. */
	note?: ReactNode;
};

/** The footer of the pages a visitor sees before signing in. */
export function SiteFooter({ siteName, note }: SiteFooterProps) {
	const year = new Date().getFullYear();

	return (
		<footer className="mt-20 border-t px-4 py-8 text-muted-foreground">
			<div className="page-wrap flex flex-col items-center justify-between gap-2 text-center sm:flex-row sm:text-left">
				<p className="m-0 text-sm">
					&copy; {year} {siteName}. All rights reserved.
				</p>
				{note}
			</div>
		</footer>
	);
}
