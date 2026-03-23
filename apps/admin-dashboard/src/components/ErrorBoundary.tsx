import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { err: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console -- surface render failures in dev
    console.error('[admin-dashboard]', error, info.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div className="layout">
          <section className="card" style={{ marginTop: 24 }}>
            <h2>Something went wrong</h2>
            <p className="err">{this.state.err.message}</p>
            <button type="button" className="btn" onClick={() => this.setState({ err: null })}>
              Try again
            </button>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}
