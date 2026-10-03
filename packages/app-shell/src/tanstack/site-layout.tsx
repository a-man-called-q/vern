import type { ReactNode } from "react";
import { SiteFooter } from "../components/site-footer";
import { SiteHeader } from "../components/site-header";
import { AuthControls, type AuthControlsProps } from "./auth-controls";
import { RouterLink } from "./link";

export type SiteLayoutProps = {
	siteName: string;
	/** `getCurrentUserFn` of the app's `src/server/auth.ts`. */
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
				link={RouterLink}
				nav={nav}
				auth={<AuthControls getUser={getUser} />}
			/>
			{children}
			<SiteFooter siteName={siteName} note={footerNote} />
		</>
	);
}
