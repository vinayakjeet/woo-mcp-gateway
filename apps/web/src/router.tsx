import { useEffect } from 'react';
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Link,
  Navigate,
  useRouteError,
  type RouteObject,
} from 'react-router';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { AuditPage } from './pages/Audit';
import { ChatPage } from './pages/Chat';
import { HostedPage } from './pages/Hosted';
import { KeysPage } from './pages/Keys';
import { LoginPage } from './pages/Login';
import { MembersPage } from './pages/Members';
import { PoliciesPage } from './pages/Policies';
import { ServersPage } from './pages/Servers';
import { StoresPage } from './pages/Stores';
import { ToolApprovalsPage } from './pages/ToolApprovals';
import { Shell } from './Shell';

function NotFound() {
  return (
    <div className="p-6">
      <p className="mb-2">Page not found.</p>
      <Link to="/" className="text-accent hover:underline">
        Back to the dashboard
      </Link>
    </div>
  );
}

// An unknown URL is a 404 response. Anything else is a bug in a page, and hiding it as "not found"
// cost a debugging round once, so it says so and goes to the console.
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => {
    if (!notFound) console.error(error);
  }, [error, notFound]);
  if (notFound) return <NotFound />;
  return (
    <div className="p-6">
      <p className="mb-2">Something went wrong.</p>
      <Link to="/" className="text-accent hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}

// Exported so a test can run the real route tree in a memory router.
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  {
    path: '/',
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/servers" replace /> },
      { path: 'servers', element: <ServersPage /> },
      { path: 'stores', element: <StoresPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'policies', element: <PoliciesPage /> },
      { path: 'approvals', element: <ToolApprovalsPage /> },
      { path: 'hosted', element: <HostedPage /> },
      { path: 'keys', element: <KeysPage /> },
      { path: 'audit', element: <AuditPage /> },
      { path: 'members', element: <MembersPage /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
