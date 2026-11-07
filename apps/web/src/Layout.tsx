import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";

export function Brand() {
  return (
    <Link to="/" className="brand">
      <span className="logo">W</span> WalletShop
    </Link>
  );
}

export function PublicLayout() {
  const { user } = useAuth();
  return (
    <>
      <header className="topbar">
        <Brand />
        <nav className="row">
          <Link className="btn ghost" to="/shop">Shop</Link>
          {user ? (
            <Link className="btn" to="/dashboard">Dashboard</Link>
          ) : (
            <>
              <Link className="btn ghost" to="/login">Log in</Link>
              <Link className="btn" to="/register">Register</Link>
            </>
          )}
        </nav>
      </header>
      <Outlet />
    </>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav className="side-nav" aria-label="Main">
          <NavLink to="/dashboard">Dashboard</NavLink>
          <NavLink to="/shop">Shop</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
        <div className="side-foot">
          <span className="muted small">{user?.email}</span>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
