import Link from "next/link";
import { type ReactNode, Suspense } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { AuthControls, type AuthControlsProps } from "./auth-controls";

export type SiteLayoutProps = {
	siteName: string;
	/** `getCurrentUser` of the app's `src/server/auth.server.ts`. */
	getUser: AuthControlsProps["getUser"];
	/** Links to the public pages, in the header. */
	nav?: ReactNode;
	/** A line beside the copyright, in the footer. */
	footerNote?: ReactNode;
	children: ReactNode;
};

/** The header and footer around the pages a visitor sees before signing in. */
export function SiteLayout({
	siteName,
	getUser,
	nav,
	footerNote,
	children,
}: SiteLayoutProps) {
	return (
		<>
			<SiteHeader
				siteName={siteName}
				link={Link}
				nav={nav}
				auth={
					<Suspense
						fallback={<span className="px-2 text-sm" aria-hidden="true" />}
					>
						<AuthControls getUser={getUser} />
					</Suspense>
				}
			/>
			{children}
			<SiteFooter siteName={siteName} note={footerNote} />
		</>
	);
}
