import { Component, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Purpose: Keep one broken view from blanking the whole console. A render
 * error below the boundary shows a recoverable message in its place; the
 * rest of the shell stays usable.
 * Public API: ErrorBoundary.
 * Upstream deps: React class error boundary, shadcn Alert and Button.
 * Downstream consumers: ConsoleShell main views and pickers, Storybook.
 * React reports the caught error to the console itself.
 * Failure modes: "Try again" re-renders the children; an error that repeats
 * shows the message again. Changing `resetKey` (a room or tab switch) clears it.
 */
type Props = { children: ReactNode; label: string; resetKey?: string };
type State = { error: Error | null; resetKey?: string };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="w-full min-w-0 p-4 sm:p-6" data-error-boundary={this.props.label}>
        <Alert variant="destructive">
          <AlertTitle>{this.props.label} could not be shown</AlertTitle>
          <AlertDescription>{error.message || "Something went wrong while drawing this view."}</AlertDescription>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </Alert>
      </div>
    );
  }
}
