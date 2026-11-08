import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "./api";
import { useAuth } from "./auth";
import type { Product } from "./shop";

export type CartItem = {
  productId: string; name: string; slug: string; type: "PHYSICAL" | "DIGITAL"; image: string; quantity: number;
  unitPriceCents: number; lineTotalCents: number; issue: null | { code: string; message: string; available?: number };
};
export type Cart = { currency: string; items: CartItem[]; itemCount: number; subtotalCents: number; hasIssues: boolean };

type CartState = {
  cart: Cart | null;
  loading: boolean;
  loadError: string;
  reload: () => Promise<void>;
  add: (productId: string, quantity?: number) => Promise<void>;
  setQuantity: (productId: string, quantity: number) => Promise<void>;
  remove: (productId: string) => Promise<void>;
};

const CartContext = createContext<CartState>(null!);
export const useCart = () => useContext(CartContext);

export const money = (cents: number, currency = "EUR") =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(cents / 100);

export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setCart((await api<{ cart: Cart }>("/api/cart")).cart);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load cart");
    } finally {
      setLoading(false);
    }
  }, []);

  // The cart belongs to the signed-in user: load on login, clear on logout.
  useEffect(() => {
    if (user) void reload();
    else setCart(null);
  }, [user?.id, reload]);

  // Mutations throw ApiError on failure (callers show the message) and replace local state with the server's cart.
  const mutate = async (path: string, method: string, body?: unknown) => {
    setCart((await api<{ cart: Cart }>(path, { method, body })).cart);
  };

  const value: CartState = {
    cart, loading, loadError, reload,
    add: (productId, quantity = 1) => mutate("/api/cart/items", "POST", { productId, quantity }),
    setQuantity: (productId, quantity) => mutate(`/api/cart/items/${productId}`, "PATCH", { quantity }),
    remove: (productId) => mutate(`/api/cart/items/${productId}`, "DELETE"),
  };
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/** Add-to-cart button with pending state and feedback. Anonymous users are sent to login and returned afterwards. */
export function AddToCartButton({ product, compact = false }: { product: Product; compact?: boolean }) {
  const { user } = useAuth();
  const { add } = useCart();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const outOfStock = !product.inStock;

  async function onClick() {
    if (!user) {
      navigate("/login", { state: { from: location.pathname + location.search } });
      return;
    }
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await add(product.id, 1);
      setMessage({ ok: true, text: "Added to cart" });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "Could not add to cart" });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={compact ? "add-wrap compact" : "add-wrap"}>
      <button className="btn full-sm" onClick={onClick} disabled={outOfStock || pending} aria-disabled={outOfStock || pending}>
        {outOfStock ? "Out of stock" : pending ? "Adding…" : "Add to cart"}
      </button>
      <p className={`add-msg ${message && !message.ok ? "bad" : ""}`} role="status" aria-live="polite">
        {message?.text}
        {message?.ok && <> · <Link to="/cart">View cart</Link></>}
      </p>
    </div>
  );
}

export function CartPage() {
  const { cart, loading, loadError, reload, setQuantity, remove } = useCart();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function run(productId: string, fn: () => Promise<void>) {
    if (pendingId) return; // ignore duplicate actions while a request is in flight
    setPendingId(productId);
    setErrors((e) => ({ ...e, [productId]: "" }));
    try {
      await fn();
    } catch (e) {
      setErrors((x) => ({ ...x, [productId]: e instanceof ApiError ? e.message : "Something went wrong" }));
    } finally {
      setPendingId(null);
    }
  }

  if (loading && !cart) return <p className="muted">Loading your cart…</p>;
  if (loadError && !cart)
    return (
      <>
        <h1>Cart</h1>
        <p className="alert" role="alert">{loadError}</p>
        <button className="btn" onClick={() => void reload()}>Try again</button>
      </>
    );
  if (!cart) return null;

  if (cart.items.length === 0)
    return (
      <>
        <h1>Cart</h1>
        <div className="card center-card">
          <h3>Your cart is empty</h3>
          <p className="muted">Browse the shop and add something you like.</p>
          <Link className="btn" to="/shop">Continue shopping</Link>
        </div>
      </>
    );

  return (
    <>
      <h1>Cart</h1>
      <p className="muted">{cart.itemCount} {cart.itemCount === 1 ? "item" : "items"}</p>
      {cart.hasIssues && <p className="alert" role="alert">Some items have availability problems. Adjust them before continuing.</p>}
      <ul className="cart-list">
        {cart.items.map((i) => {
          const busy = pendingId === i.productId;
          return (
            <li key={i.productId} className="cart-item card">
              <img src={i.image} alt="" />
              <div className="cart-info">
                <Link to={`/shop/${i.slug}`}><strong>{i.name}</strong></Link>
                <div className="row">
                  <span className={`badge ${i.type === "DIGITAL" ? "digital" : "physical"}`}>{i.type === "DIGITAL" ? "Digital" : "Physical"}</span>
                  <span className="muted small">{money(i.unitPriceCents)} each</span>
                </div>
                {i.issue && <p className="field-error">{i.issue.message}</p>}
                {errors[i.productId] && <p className="field-error" role="alert">{errors[i.productId]}</p>}
              </div>
              <div className="qty" role="group" aria-label={`Quantity for ${i.name}`}>
                <button className="btn ghost" aria-label="Decrease quantity" disabled={busy || i.quantity <= 1}
                  onClick={() => run(i.productId, () => setQuantity(i.productId, i.quantity - 1))}>−</button>
                <span aria-live="polite">{i.quantity}</span>
                <button className="btn ghost" aria-label="Increase quantity" disabled={busy || i.quantity >= 20}
                  onClick={() => run(i.productId, () => setQuantity(i.productId, i.quantity + 1))}>+</button>
              </div>
              <div className="line-total">{money(i.lineTotalCents)}</div>
              <button className="btn ghost danger" disabled={busy} aria-label={`Remove ${i.name}`}
                onClick={() => run(i.productId, () => remove(i.productId))}>Remove</button>
            </li>
          );
        })}
      </ul>
      <div className="card summary">
        <div className="row between"><span>Subtotal</span><strong className="price-sm">{money(cart.subtotalCents)}</strong></div>
        <p className="muted small">Shipping and taxes are not calculated in this demo.</p>
        <button className="btn full" disabled aria-disabled="true">Checkout — Coming soon</button>
        <Link to="/shop">← Continue shopping</Link>
      </div>
    </>
  );
}
