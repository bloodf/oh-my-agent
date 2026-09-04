import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Purpose: Collect a remote operator token while leaving session handshake to its parent.
 * Public API: AuthScreen and AuthScreenProps.
 * Upstream deps: shadcn Card/form primitives and parent authentication callback.
 * Downstream consumers: ConsoleShell remote-auth boundary.
 * Failure modes: callback rejection and supplied errors display inline; token draft remains.
 * Performance: one callback invocation per submit.
 */

export type AuthScreenProps = {
  onAuthenticate: (token: string) => Promise<void>;
  error?: string;
};

export function AuthScreen({ onAuthenticate, error = "" }: AuthScreenProps) {
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef("");

  return (
    <section
      id="operator-auth"
      className="flex min-h-svh items-center justify-center bg-background p-6"
    >
      <Card className="w-full max-w-sm" size="sm">
        <CardHeader>
          <CardTitle id="operator-auth-title">
            Operator authentication
          </CardTitle>
          <CardDescription>
            Enter the operator token to open this remote console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="operator-auth-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const submittedToken = token;
              const value = submittedToken.trim();
              if (!value) return inputRef.current?.focus();
              setLocalError("");
              void onAuthenticate(value).catch((cause) => {
                sessionStorage.removeItem("oh-my-agent.operator-token");
                if (tokenRef.current === submittedToken) {
                  tokenRef.current = "";
                  setToken("");
                }
                setLocalError(
                  cause instanceof Error ? cause.message : String(cause),
                );
                queueMicrotask(() => inputRef.current?.focus());
              });
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
                onChange={(event) => {
                  tokenRef.current = event.target.value;
                  setToken(event.target.value);
                }}
              />
            </div>
            <Button type="submit">
              Open console
            </Button>
            <p
              id="operator-auth-error"
              role="alert"
              className="min-h-5 text-xs text-destructive"
            >
              {localError || error}
            </p>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
