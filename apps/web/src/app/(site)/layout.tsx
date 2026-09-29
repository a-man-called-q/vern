import Footer from "@/components/Footer";
import Header from "@/components/Header";

export default function SiteLayout({ children }: LayoutProps<"/">) {
	return (
		<>
			<Header />
			{children}
			<Footer />
		</>
	);
}
