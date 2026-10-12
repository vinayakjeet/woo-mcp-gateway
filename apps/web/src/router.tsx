import { createBrowserRouter, Link, Navigate } from 'react-router';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { KeysPage } from './pages/Keys';
import { LoginPage } from './pages/Login';
import { MembersPage } from './pages/Members';
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

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:token', element: <AcceptInvitePage /> },
  {
    path: '/',
    element: <Shell />,
    errorElement: <NotFound />,
    children: [
      { index: true, element: <Navigate to="/keys" replace /> },
      { path: 'keys', element: <KeysPage /> },
      { path: 'members', element: <MembersPage /> },
    ],
  },
]);
