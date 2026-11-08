import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { AddToCartButton, money } from "./cart";

export type Product = {
  id: string; name: string; slug: string; description: string; type: "PHYSICAL" | "DIGITAL";
  category: string; priceCents: number; currency: string; image: string; stockQuantity: number | null; inStock: boolean;
};
type ListResponse = { items: Product[]; page: number; pageSize: number; total: number; totalPages: number; categories: string[] };

function Availability({ p }: { p: Product }) {
  if (p.stockQuantity === null) return <span className="avail ok">Instant delivery</span>;
  if (p.stockQuantity === 0) return <span className="avail out">Out of stock</span>;
  if (p.stockQuantity <= 5) return <span className="avail low">Only {p.stockQuantity} left</span>;
  return <span className="avail ok">In stock</span>;
}

const TypeBadge = ({ type }: { type: Product["type"] }) => (
  <span className={`badge ${type === "DIGITAL" ? "digital" : "physical"}`}>{type === "DIGITAL" ? "Digital" : "Physical"}</span>
);

export function Shop() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const type = params.get("type") ?? "";
  const category = params.get("category") ?? "";
  const page = Number(params.get("page") ?? 1) || 1;

  const [search, setSearch] = useState(q);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [cats, setCats] = useState<string[]>([]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!("page" in patch)) next.delete("page");
    setParams(next);
  };

  // Debounce typing into the search box.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => update({ q: search.trim() }), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const qs = new URLSearchParams({ page: String(page), pageSize: "9" });
    if (q) qs.set("q", q);
    if (type) qs.set("type", type);
    if (category) qs.set("category", category);
    api<ListResponse>(`/api/products?${qs}`)
      .then((r) => { if (!cancelled) { setData(r); setCats(r.categories); } })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load products"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [q, type, category, page]);

  return (
    <main className="page">
      <h1>Shop</h1>
      <p className="muted">Physical and digital products. Add items to your cart. Checkout arrives in a later task.</p>

      <div className="filters">
        <div className="field grow">
          <label htmlFor="search">Search products</label>
          <input id="search" type="search" placeholder="Search by name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="type">Type</label>
          <select id="type" value={type} onChange={(e) => update({ type: e.target.value })}>
            <option value="">All types</option>
            <option value="PHYSICAL">Physical</option>
            <option value="DIGITAL">Digital</option>
          </select>
        </div>
      </div>
      <div className="chips" role="group" aria-label="Categories">
        <button className={`chip ${category === "" ? "on" : ""}`} onClick={() => update({ category: "" })}>All</button>
        {cats.map((c) => (
          <button key={c} className={`chip ${category === c ? "on" : ""}`} onClick={() => update({ category: c })}>{c}</button>
        ))}
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading products…</p>}
      {data && data.items.length === 0 && !loading && (
        <div className="card center-card"><h3>No products found</h3><p className="muted">Try a different search or filter.</p></div>
      )}
      {data && (
        <div className={`product-grid ${loading ? "dim" : ""}`}>
          {data.items.map((p) => (
            <article key={p.id} className="product-card">
              <Link to={`/shop/${p.slug}`} className="product-link">
                <img src={p.image} alt={p.name} loading="lazy" />
                <div className="product-body">
                  <div className="row between"><TypeBadge type={p.type} /><span className="muted small">{p.category}</span></div>
                  <h3>{p.name}</h3>
                  <div className="row between">
                    <strong>{money(p.priceCents, p.currency)}</strong>
                    <Availability p={p} />
                  </div>
                </div>
              </Link>
              <div className="product-actions"><AddToCartButton product={p} compact /></div>
            </article>
          ))}
        </div>
      )}
      {data && data.totalPages > 1 && (
        <div className="row pager">
          <button className="btn ghost" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>← Previous</button>
          <span className="muted small">Page {data.page} of {data.totalPages}</span>
          <button className="btn ghost" disabled={page >= data.totalPages} onClick={() => update({ page: String(page + 1) })}>Next →</button>
        </div>
      )}
    </main>
  );
}

export function ProductDetail() {
  const { slug } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    setProduct(null);
    setError(null);
    api<{ product: Product }>(`/api/products/${encodeURIComponent(slug ?? "")}`)
      .then((r) => setProduct(r.product))
      .catch((e) => setError(e instanceof ApiError ? { status: e.status, message: e.message } : { status: 0, message: "Failed to load product" }));
  }, [slug]);

  if (error) {
    return (
      <main className="page">
        <Link to="/shop">← Back to shop</Link>
        <h1>{error.status === 404 ? "Product not found" : "Something went wrong"}</h1>
        <p className="muted">{error.status === 404 ? "This product doesn't exist or is no longer available." : error.message}</p>
      </main>
    );
  }
  if (!product) return <main className="page"><p className="muted">Loading…</p></main>;

  return (
    <main className="page">
      <Link to="/shop">← Back to shop</Link>
      <div className="detail">
        <img className="detail-img" src={product.image} alt={product.name} />
        <div>
          <div className="row"><TypeBadge type={product.type} /><span className="muted small">{product.category}</span></div>
          <h1>{product.name}</h1>
          <p className="price">{money(product.priceCents, product.currency)}</p>
          <p>{product.description}</p>
          <dl className="dl">
            <dt>Type</dt><dd>{product.type === "DIGITAL" ? "Digital product" : "Physical product"}</dd>
            <dt>Category</dt><dd>{product.category}</dd>
            <dt>Availability</dt><dd><Availability p={product} /></dd>
            <dt>{product.type === "DIGITAL" ? "Fulfillment" : "Delivery"}</dt>
            <dd>
              {product.type === "DIGITAL"
                ? "Delivered digitally right after purchase (license key or download link in your orders)."
                : "Shipped to your address. Shipping is simulated in this demo."}
            </dd>
          </dl>
          <AddToCartButton product={product} />
        </div>
      </div>
    </main>
  );
}
