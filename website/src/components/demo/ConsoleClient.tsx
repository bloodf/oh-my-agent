"use client";

import dynamic from "next/dynamic";

/** The console touches window, storage, and sockets at import time: client only. */
export const ConsoleClient = dynamic(() => import("./ConsoleApp").then((m) => m.ConsoleApp), {
	ssr: false,
	loading: () => null,
});
