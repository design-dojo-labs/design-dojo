import { Link } from 'react-router';
import { PageShell } from '../components/Shell';

export function NotFound() {
  return (
    <PageShell>
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">
        That address doesn't match anything in the studio. <Link to="/" className="text-focus underline">Go to the home page</Link>.
      </p>
    </PageShell>
  );
}
