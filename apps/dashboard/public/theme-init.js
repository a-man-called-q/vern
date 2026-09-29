(function () {
	try {
		var stored = window.localStorage.getItem("theme");
		var dashboardDefault = window.location.pathname.indexOf("/dashboard") === 0 ? "dark" : "auto";
		var mode = stored === "light" || stored === "dark" || stored === "auto" ? stored : dashboardDefault;
		var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
		var resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;
		var root = document.documentElement;
		root.classList.remove("light", "dark");
		root.classList.add(resolved);
		if (mode === "auto") {
			root.removeAttribute("data-theme");
		} else {
			root.setAttribute("data-theme", mode);
		}
		root.style.colorScheme = resolved;
	} catch {
		document.documentElement.classList.add("light");
		document.documentElement.style.colorScheme = "light";
	}
})();
