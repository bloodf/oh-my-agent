"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initializeTheme } from "@/lib/theme";
import { isDemoAuthenticated, signIn } from "@site/mock/session";
import { DemoBanner } from "./DemoBanner";

const REFUSED = "Operator token refused. Re-enter the token.";

/** The console's AuthScreen, checked against the demo password instead of a daemon. */
export function DemoLogin() {
	const router = useRouter();
	const [token, setToken] = useState("");
	const [error, setError] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		initializeTheme();
		if (isDemoAuthenticated()) router.replace("/console");
	}, [router]);

	return (
		<div className="flex min-h-svh flex-col bg-background text-foreground">
			<DemoBanner variant="login" />
			<section id="operator-auth" className="flex flex-1 items-center justify-center p-6">
				<Card className="w-full max-w-sm" size="sm">
					<CardHeader>
						<CardTitle id="operator-auth-title">Operator authentication</CardTitle>
						<CardDescription>Enter the operator token to open this remote console.</CardDescription>
					</CardHeader>
					<CardContent>
						<form
							id="operator-auth-form"
							className="grid gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								const value = token.trim();
								if (!value) return inputRef.current?.focus();
								if (signIn(value)) {
									setError("");
									router.replace("/console");
									return;
								}
								setToken("");
								setError(REFUSED);
								queueMicrotask(() => inputRef.current?.focus());
							}}
						>
							<div className="grid gap-2">
								<Label htmlFor="operator-token">Operator token</Label>
								<Input
									id="operator-token"
									ref={inputRef}
									type="password"
									autoComplete="off"
									required
									autoFocus
									value={token}
									onChange={(event) => setToken(event.target.value)}
								/>
							</div>
							<Button type="submit">Open console</Button>
							<p id="operator-auth-error" role="alert" className="min-h-5 text-xs text-destructive">
								{error}
							</p>
						</form>
					</CardContent>
				</Card>
			</section>
		</div>
	);
}
