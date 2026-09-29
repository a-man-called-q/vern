import type { Metadata } from "next";
import Providers from "@/components/Providers";
import { SITE_NAME } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
	title: SITE_NAME,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<script src="/theme-init.js" />
			</head>
			<body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-primary/20">
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
