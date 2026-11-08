import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { money, useCart, type CartItem } from "./cart";

type Blocker = { code: string; message: string };
type Preview = {
  items: CartItem[]; totalCents: number; walletBalanceCents: number; shortfallCents: number;
  requiresShipping: boolean; canCheckout: boolean; blockers: Blocker[];
};
type Shipping = { name: string; line1: string; line2: string; city: string; postalCode: string; country: string };
type Entitlement = { kind: string; code: string; issuedAt: string; note: string };
type OrderItem = {
  id: string; name: string; type: "PHYSICAL" | "DIGITAL"; quantity: number; unitPriceCents: number; lineTotalCents: number;
  fulfillmentState: "PROCESSING" | "SHIPPED" | "DELIVERED"; simulatedDelivery: boolean; entitlements: Entitlement[];
};
type OrderSummary = {
  id: string; reference: string; createdAt: string; totalCents: number; currency: string; paymentStatus: string;
  status: "CONFIRMED" | "COMPLETED"; itemCount: number; hasPhysical: boolean; hasDigital: boolean;
};
type OrderDetail = OrderSummary & {
  payment: { method: string; status: string; walletReference: string };
  shipping: null | { name: string; line1: string; line2: string | null; city: string; postalCode: string; country: string };
  delivery: null | { simulated: boolean; note: string };
  items: OrderItem[];
};

const KEY_STORAGE = "walletshop.checkoutKey";
// One key per logical checkout attempt; survives retries and page refreshes until the order is confirmed.
function checkoutKey() {
  try {
    let k = sessionStorage.getItem(KEY_STORAGE);
    if (!k) { k = crypto.randomUUID(); sessionStorage.setItem(KEY_STORAGE, k); }
    return k;
  } catch {
    return crypto.randomUUID();
  }
}
const clearKey = () => { try { sessionStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ } };

const dateFmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const STATE_LABEL = { PROCESSING: "Processing", SHIPPED: "Shipped", DELIVERED: "Delivered" } as const;
const ORDER_LABEL = { CONFIRMED: "Confirmed", COMPLETED: "Completed" } as const;

const emptyShipping: Shipping = { name: "", line1: "", line2: "", city: "", postalCode: "", country: "" };
const SHIP_FIELDS: { key: keyof Shipping; label: string; autoComplete: string; optional?: boolean }[] = [
  { key: "name", label: "Full name", autoComplete: "name" },
  { key: "line1", label: "Address", autoComplete: "address-line1" },
  { key: "line2", label: "Address line 2 (optional)", autoComplete: "address-line2", optional: true },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "postalCode", label: "Postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country", autoComplete: "country-name" },
];

export function CheckoutPage() {
  const { reload: reloadCart } = useCart();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [ship, setShip] = useState<Shipping>(emptyShipping);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const inFlight = useRef(false); // synchronous guard: state updates are too late for a fast double click

  const load = () =>
    api<{ preview: Preview }>("/api/checkout/preview")
      .then((r) => { setPreview(r.preview); setLoadError(""); })
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Failed to load checkout"));
  useEffect(() => { void load(); }, []);

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || !preview?.canCheckout) return;
    setError("");
    const errs: Record<string, string> = {};
    if (preview.requiresShipping) {
      if (ship.name.trim().length < 2) errs.name = "Enter your full name";
      if (ship.line1.trim().length < 3) errs.line1 = "Enter your address";
      if (ship.city.trim().length < 2) errs.city = "Enter your city";
      if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/.test(ship.postalCode.trim())) errs.postalCode = "Enter a valid postal code";
      if (ship.country.trim().length < 2) errs.country = "Enter your country";
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;

    inFlight.current = true;
    setPaying(true);
    try {
      const body: Record<string, unknown> = { idempotencyKey: checkoutKey() };
      if (preview.requiresShipping) body.shipping = { ...ship, line2: ship.line2.trim() || undefined };
      // Navigate only after the backend confirmed the committed order.
      const r = await api<{ order: OrderDetail }>("/api/checkout", { method: "POST", body });
      clearKey();
      await reloadCart();
      navigate(`/orders/${r.order.id}?placed=1`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFieldErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k.replace("shipping.", ""), v[0]])));
        setError(err.status === 0 ? "We could not confirm your payment. It is safe to press Pay again: you will not be charged twice." : err.message);
        if (err.status === 409) { clearKey(); await load(); await reloadCart(); } // state changed: refresh numbers and use a fresh key
      } else setError("Something went wrong. Please try again.");
    } finally {
      inFlight.current = false;
      setPaying(false);
    }
  }

  if (loadError) return (<><h1>Checkout</h1><p className="alert" role="alert">{loadError}</p><button className="btn" onClick={() => void load()}>Try again</button></>);
  if (!preview) return <p className="muted">Loading checkout…</p>;
  if (preview.items.length === 0)
    return (
      <>
        <h1>Checkout</h1>
        <div className="card center-card"><h3>Your cart is empty</h3><Link className="btn" to="/shop">Continue shopping</Link></div>
      </>
    );

  const short = preview.shortfallCents > 0;
  return (
    <>
      <h1>Checkout</h1>
      <p className="muted">Pay with your EUR demo wallet. No real money is involved.</p>
      {error && <p className="alert" role="alert">{error}</p>}
      {preview.blockers.filter((b) => b.code !== "INSUFFICIENT_FUNDS" && b.code !== "EMPTY_CART").map((b) => (
        <p key={b.message} className="alert" role="alert">{b.message}</p>
      ))}
      <form onSubmit={pay} noValidate className="checkout-grid">
        <section className="card" aria-label="Order summary">
          <h3>Order summary</h3>
          <ul className="co-list">
            {preview.items.map((i) => (
              <li key={i.productId} className="co-item">
                <img src={i.image} alt="" />
                <div className="co-info">
                  <strong>{i.name}</strong>
                  <span className="muted small">
                    <span className={`badge ${i.type === "DIGITAL" ? "digital" : "physical"}`}>{i.type === "DIGITAL" ? "Digital" : "Physical"}</span>{" "}
                    {i.quantity} × {money(i.unitPriceCents)}
                  </span>
                  {i.issue && <span className="field-error">{i.issue.message}</span>}
                </div>
                <strong>{money(i.lineTotalCents)}</strong>
              </li>
            ))}
          </ul>
          <div className="row between total-row"><span>Total</span><strong className="price-sm">{money(preview.totalCents)}</strong></div>
          <div className="row between"><span className="muted">EUR wallet balance</span><strong>{money(preview.walletBalanceCents)}</strong></div>
          {short && (
            <p className="alert" role="alert">
              Your balance is {money(preview.shortfallCents)} short. <Link to="/wallet">Add funds in Wallet</Link> using Stripe Test Mode, then come back.
            </p>
          )}
        </section>

        <section className="card" aria-label="Payment and delivery">
          {preview.requiresShipping && (
            <fieldset className="ship" disabled={paying}>
              <legend><h3>Shipping address</h3></legend>
              <p className="muted small">Demo only: delivery is simulated and nothing will be shipped.</p>
              {SHIP_FIELDS.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`ship-${f.key}`}>{f.label}</label>
                  <input id={`ship-${f.key}`} value={ship[f.key]} autoComplete={f.autoComplete} maxLength={100}
                    aria-invalid={!!fieldErrors[f.key]} aria-describedby={fieldErrors[f.key] ? `err-${f.key}` : undefined}
                    onChange={(e) => setShip({ ...ship, [f.key]: e.target.value })} />
                  {fieldErrors[f.key] && <p className="field-error" id={`err-${f.key}`}>{fieldErrors[f.key]}</p>}
                </div>
              ))}
            </fieldset>
          )}
          {!preview.requiresShipping && <p className="muted">Digital items only: a demo entitlement is issued on your order page after payment.</p>}
          <button className="btn full" type="submit" disabled={paying || !preview.canCheckout} aria-disabled={paying || !preview.canCheckout}>
            {paying ? "Processing payment…" : `Pay ${money(preview.totalCents)} with EUR Wallet`}
          </button>
          {paying && <p className="muted small" role="status">Please wait, do not close this page.</p>}
          <Link to="/cart">← Back to cart</Link>
        </section>
      </form>
    </>
  );
}

export function OrdersPage() {
  const [data, setData] = useState<{ items: OrderSummary[]; page: number; totalPages: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    let cancelled = false;
    api<NonNullable<typeof data>>(`/api/orders?page=${page}&pageSize=10`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Failed to load orders"));
    return () => { cancelled = true; };
  }, [page]);

  return (
    <>
      <h1>Orders</h1>
      {error && <p className="alert" role="alert">{error}</p>}
      {!data && !error && <p className="muted">Loading orders…</p>}
      {data && data.total === 0 && (
        <div className="card center-card"><h3>No orders yet</h3><p className="muted">Orders you pay for with your wallet appear here.</p><Link className="btn" to="/shop">Browse the shop</Link></div>
      )}
      {data && data.total > 0 && (
        <>
          <ul className="order-list">
            {data.items.map((o) => (
              <li key={o.id} className="card order-row">
                <div>
                  <Link to={`/orders/${o.id}`}><strong>{o.reference}</strong></Link>
                  <div className="muted small">{dateFmt(o.createdAt)} · {o.itemCount} {o.itemCount === 1 ? "item" : "items"}</div>
                </div>
                <div className="row">
                  <span className="badge digital">{o.paymentStatus === "PAID" ? "Paid" : o.paymentStatus}</span>
                  <span className={`badge ${o.status === "COMPLETED" ? "ok" : "physical"}`}>{ORDER_LABEL[o.status]}</span>
                </div>
                <strong className="order-total">{money(o.totalCents, o.currency)}</strong>
              </li>
            ))}
          </ul>
          {data.totalPages > 1 && (
            <div className="row between">
              <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button>
              <span className="muted small">Page {data.page} of {data.totalPages}</span>
              <button className="btn ghost" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Older →</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function OrderDetailPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ order: OrderDetail }>(`/api/orders/${id}`)
      .then((r) => !cancelled && setOrder(r.order))
      .catch((e) => !cancelled && setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof ApiError ? e.message : "Failed to load order" }));
    return () => { cancelled = true; };
  }, [id]);

  if (error)
    return (
      <>
        <h1>Order</h1>
        <p className="alert" role="alert">{error.status === 404 ? "We could not find this order." : error.message}</p>
        <Link className="btn" to="/orders">Back to orders</Link>
      </>
    );
  if (!order) return <p className="muted">Loading order…</p>;

  return (
    <>
      {params.get("placed") && (
        <div className="card success-card" role="status">
          <h2>Order confirmed</h2>
          <p>Thank you! {money(order.totalCents, order.currency)} was paid from your EUR wallet.</p>
        </div>
      )}
      <h1>Order {order.reference}</h1>
      <p className="muted">{dateFmt(order.createdAt)}</p>
      <div className="card">
        <div className="row between"><span>Payment</span><span><span className="badge digital">{order.paymentStatus === "PAID" ? "Paid" : order.paymentStatus}</span> {order.payment.method}</span></div>
        <div className="row between"><span>Order status</span><strong>{ORDER_LABEL[order.status]}</strong></div>
        <div className="row between"><span className="muted small">Wallet reference</span><span className="muted small">{order.payment.walletReference}</span></div>
      </div>
      <h2>Items</h2>
      <ul className="order-items">
        {order.items.map((i) => (
          <li key={i.id} className="card">
            <div className="row between">
              <strong>{i.name}</strong>
              <strong>{money(i.lineTotalCents, order.currency)}</strong>
            </div>
            <div className="muted small">
              <span className={`badge ${i.type === "DIGITAL" ? "digital" : "physical"}`}>{i.type === "DIGITAL" ? "Digital" : "Physical"}</span>{" "}
              {i.quantity} × {money(i.unitPriceCents, order.currency)} (price paid)
            </div>
            {i.type === "PHYSICAL" ? (
              <p>
                <span className={`badge ${i.fulfillmentState === "DELIVERED" ? "ok" : "physical"}`}>{STATE_LABEL[i.fulfillmentState]}</span>{" "}
                <span className="muted small">Simulated delivery (demo): nothing is actually shipped.</span>
              </p>
            ) : (
              <div className="entitlements">
                <p><span className="badge ok">Delivered</span> <span className="muted small">Demo license / download entitlement</span></p>
                {i.entitlements.map((en) => (
                  <div key={en.code} className="demo-code"><code>{en.code}</code></div>
                ))}
                <p className="muted small">Demo code only. It does not unlock real software and nothing is downloadable.</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="card"><div className="row between"><span>Total paid</span><strong className="price-sm">{money(order.totalCents, order.currency)}</strong></div></div>
      {order.shipping && (
        <div className="card">
          <h3>Shipping address</h3>
          <p>{order.shipping.name}<br />{order.shipping.line1}{order.shipping.line2 && <><br />{order.shipping.line2}</>}<br />{order.shipping.postalCode} {order.shipping.city}<br />{order.shipping.country}</p>
          <p className="muted small">{order.delivery?.note}</p>
        </div>
      )}
      <div className="row"><Link className="btn ghost" to="/orders">All orders</Link><Link className="btn ghost" to="/wallet">Wallet</Link></div>
    </>
  );
}
