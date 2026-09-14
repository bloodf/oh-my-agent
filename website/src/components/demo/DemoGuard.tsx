"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { isDemoAuthenticated } from "@site/mock/session";

/** Keeps /console behind the demo login; the login and review pages stay open. */
export function DemoGuard({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const router = useRouter();
	const open = pathname === "/console/login" || pathname.startsWith("/console/review");
	const [allowed, setAllowed] = useState(false);

	useEffect(() => {
		if (open || isDemoAuthenticated()) {
			setAllowed(true);
			return;
		}
		setAllowed(false);
		router.replace("/console/login");
	}, [open, pathname, router]);

	return allowed ? children : null;
}
