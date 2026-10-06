import React from 'react';

/**
 * Top-level crash barrier.
 *
 * Without this, any render-time exception (a null `job.provider`, a malformed
 * API payload) unmounts the entire React tree and leaves the user staring at a
 * blank white page with no way back.
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Kept as console output deliberately: there is no error-reporting backend
    // wired up yet, and swallowing this silently would make bugs invisible.
    console.error('Unhandled render error:', error, info?.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
    window.location.assign('/');
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--cream)' }}>
        <div
          className="max-w-md w-full text-center p-8"
          style={{
            background: 'white',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-float)',
            border: '1.5px solid rgba(180, 160, 130, 0.18)',
          }}
        >
          <div className="text-5xl mb-4">🛠️</div>
          <h1 style={{ fontFamily: 'Lora, serif', fontWeight: 600, fontSize: '1.4rem', color: 'var(--text-dark)' }}>
            Something broke on our end
          </h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--text-soft)' }}>
            The page hit an unexpected error. Nothing you did caused it — try
            heading back and starting again.
          </p>
          {import.meta.env.DEV && (
            <pre
              className="mt-4 text-left text-xs overflow-auto p-3"
              style={{ background: 'var(--sand)', borderRadius: '10px', maxHeight: '180px', color: '#8a2f2f' }}
            >
              {String(this.state.error?.stack || this.state.error)}
            </pre>
          )}
          <button onClick={this.handleReset} className="btn-primary mt-6 text-sm" style={{ padding: '0.6rem 1.4rem' }}>
            Back to home
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
