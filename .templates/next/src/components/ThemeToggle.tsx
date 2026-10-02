"use client";

import { Button } from "@vern/ui/components/button";
import { useEffect, useState } from "react";

type ThemeMode = "light" | "dark" | "auto";

/** Each click moves to the next mode: light, dark, then the system's. */
const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
	light: "dark",
	dark: "auto",
	auto: "light",
};

const MODE_NAME: Record<ThemeMode, string> = {
	light: "Light",
	dark: "Dark",
	auto: "Auto",
};

function getInitialMode(defaultMode: ThemeMode): ThemeMode {
	if (typeof window === "undefined") {
		return defaultMode;
	}

	const stored = window.localStorage.getItem("theme");
	if (stored === "light" || stored === "dark" || stored === "auto") {
		return stored;
	}

	return defaultMode;
}

function applyThemeMode(mode: ThemeMode) {
	let resolved = mode;
	if (mode === "auto") {
		const prefersDark = window.matchMedia(
			"(prefers-color-scheme: dark)",
		).matches;
		resolved = prefersDark ? "dark" : "light";
	}

	document.documentElement.classList.remove("light", "dark");
	document.documentElement.classList.add(resolved);

	if (mode === "auto") {
		document.documentElement.removeAttribute("data-theme");
	} else {
		document.documentElement.setAttribute("data-theme", mode);
	}

	document.documentElement.style.colorScheme = resolved;
}

export default function ThemeToggle({
	defaultMode = "auto",
}: {
	defaultMode?: ThemeMode;
}) {
	const [mode, setMode] = useState<ThemeMode>(defaultMode);

	useEffect(() => {
		const initialMode = getInitialMode(defaultMode);
		setMode(initialMode);
		applyThemeMode(initialMode);
	}, [defaultMode]);

	useEffect(() => {
		if (mode !== "auto") {
			return;
		}

		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyThemeMode("auto");

		media.addEventListener("change", onChange);
		return () => {
			media.removeEventListener("change", onChange);
		};
	}, [mode]);

	function toggleMode() {
		const nextMode = NEXT_MODE[mode];
		setMode(nextMode);
		applyThemeMode(nextMode);
		window.localStorage.setItem("theme", nextMode);
	}

	const label =
		mode === "auto"
			? "Theme mode: auto (system). Click to switch to light mode."
			: `Theme mode: ${mode}. Click to switch mode.`;

	return (
		<Button
			type="button"
			onClick={toggleMode}
			aria-label={label}
			title={label}
			variant="outline"
			size="sm"
		>
			{MODE_NAME[mode]}
		</Button>
	);
}
