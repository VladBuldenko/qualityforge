import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";

export function Home() {
  return (
    <main className="hero">
      <p className="eyebrow">Demo FinTech + e-commerce</p>
      <h1>Your money and your shopping, in one wallet.</h1>
      <p className="lead">
        WalletShop is a demo app. Soon: EUR and USD wallets, test-mode top-ups, currency exchange, and a shop with
        physical and digital products. No real funds are used.
      </p>
      <div className="row">
        <Link className="btn big" to="/register">Create account</Link>
        <Link className="btn ghost big" to="/login">Log in</Link>
      </div>
      <div className="grid3">
        <div className="card"><h3>Wallets</h3><p className="muted">EUR and USD balances. Coming soon.</p></div>
        <div className="card"><h3>Exchange</h3><p className="muted">Convert between currencies at demo rates. Coming soon.</p></div>
        <div className="card"><h3>Shop</h3><p className="muted">Browse physical and digital products.</p><Link to="/shop">Open shop →</Link></div>
      </div>
    </main>
  );
}

function Field(props: { id: string; label: string; type?: string; value: string; onChange: (v: string) => void; error?: string; autoComplete?: string }) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        autoComplete={props.autoComplete}
        aria-invalid={!!props.error}
        aria-describedby={props.error ? `${props.id}-err` : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.error && <p id={`${props.id}-err`} className="field-error">{props.error}</p>}
    </div>
  );
}

const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

export function Register() {
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (f.name.trim().length < 2) errs.name = "Name must be at least 2 characters";
    if (!emailOk(f.email)) errs.email = "Enter a valid email address";
    if (f.password.length < 8) errs.password = "Password must be at least 8 characters";
    else if (f.password.length > 72) errs.password = "Password must be at most 72 characters";
    if (f.confirm !== f.password) errs.confirm = "Passwords do not match";
    setErrors(errs);
    setFormError("");
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/api/auth/register", { method: "POST", body: { name: f.name, email: f.email, password: f.password } });
      navigate("/login", { replace: true, state: { registered: true, email: f.email.trim() } });
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v[0]])));
      } else if (err instanceof ApiError && err.status === 409) {
        setErrors({ email: err.message });
      } else setFormError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <form className="card auth" onSubmit={onSubmit} noValidate>
        <h1>Create your account</h1>
        {formError && <p className="alert" role="alert">{formError}</p>}
        <Field id="name" label="Name" value={f.name} onChange={set("name")} error={errors.name} autoComplete="name" />
        <Field id="email" label="Email" type="email" value={f.email} onChange={set("email")} error={errors.email} autoComplete="email" />
        <Field id="password" label="Password" type="password" value={f.password} onChange={set("password")} error={errors.password} autoComplete="new-password" />
        <Field id="confirm" label="Confirm password" type="password" value={f.confirm} onChange={set("confirm")} error={errors.confirm} autoComplete="new-password" />
        <button className="btn big full" disabled={busy}>{busy ? "Creating account…" : "Register"}</button>
        <p className="muted small">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </main>
  );
}

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { registered?: boolean; email?: string; from?: string } | null;
  const [email, setEmail] = useState(state?.email ?? "");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={state?.from ?? "/dashboard"} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!emailOk(email)) errs.email = "Enter a valid email address";
    if (!password) errs.password = "Enter your password";
    setErrors(errs);
    setFormError("");
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await login(email, password);
      navigate(state?.from ?? "/dashboard", { replace: true });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <form className="card auth" onSubmit={onSubmit} noValidate>
        <h1>Log in</h1>
        {state?.registered && <p className="notice" role="status">Account created. Log in to continue.</p>}
        {formError && <p className="alert" role="alert">{formError}</p>}
        <Field id="email" label="Email" type="email" value={email} onChange={setEmail} error={errors.email} autoComplete="email" />
        <Field id="password" label="Password" type="password" value={password} onChange={setPassword} error={errors.password} autoComplete="current-password" />
        <button className="btn big full" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        <p className="muted small">New here? <Link to="/register">Create an account</Link></p>
      </form>
    </main>
  );
}

export function Dashboard() {
  const { user } = useAuth();
  if (!user) return null;
  const since = new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" });
  return (
    <>
      <h1>Welcome, {user.name}</h1>
      <p className="muted">Here's an overview of your account.</p>
      <section className="card">
        <h2>Account overview</h2>
        <dl className="dl">
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Role</dt><dd>{user.role}</dd>
          <dt>Member since</dt><dd>{since}</dd>
        </dl>
        <Link to="/profile">View profile →</Link>
      </section>
      <div className="grid3">
        <section className="card placeholder"><h3>Wallet</h3><p className="muted">EUR/USD wallets are coming in a later task.</p></section>
        <section className="card"><h3>Shop</h3><p className="muted">Browse physical and digital products.</p><Link to="/shop">Open shop →</Link></section>
        <section className="card placeholder"><h3>Orders</h3><p className="muted">Order history is coming in a later task.</p></section>
      </div>
    </>
  );
}

export function Profile() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <>
      <h1>Profile</h1>
      <section className="card">
        <dl className="dl">
          <dt>Name</dt><dd>{user.name}</dd>
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>Role</dt><dd>{user.role}</dd>
          <dt>Account created</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd>
        </dl>
      </section>
    </>
  );
}

export function NotFound() {
  return (
    <main className="hero">
      <h1>Page not found</h1>
      <Link to="/">Go home</Link>
    </main>
  );
}
