import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import { money } from "./cart";

type Balance = { currency: "EUR" | "USD"; balanceMinor: number };
type Tx = { reference: string; type: "CREDIT" | "DEBIT"; currency: "EUR" | "USD"; amountMinor: number; balanceAfterMinor: number | null; description: string | null; createdAt: string };
type TxPage = { items: Tx[]; page: number; total: number; totalPages: number };

const NAMES = { EUR: "Euro", USD: "US Dollar" } as const;
const SYMBOLS = { EUR: "€", USD: "$" } as const;

export function WalletPage() {
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [balError, setBalError] = useState("");
  const [txs, setTxs] = useState<TxPage | null>(null);
  const [txError, setTxError] = useState("");
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState<"" | "EUR" | "USD">("");
  const [txLoading, setTxLoading] = useState(true);
  const [topUpOpen, setTopUpOpen] = useState(false);

  useEffect(() => {
    api<{ wallet: { balances: Balance[] } }>("/api/wallet")
      .then((r) => setBalances(r.wallet.balances))
      .catch((e) => setBalError(e instanceof ApiError ? e.message : "Failed to load balances"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTxLoading(true);
    setTxError("");
    const qs = new URLSearchParams({ page: String(page), pageSize: "10" });
    if (currency) qs.set("currency", currency);
    api<TxPage>(`/api/wallet/transactions?${qs}`)
      .then((r) => !cancelled && setTxs(r))
      .catch((e) => !cancelled && setTxError(e instanceof ApiError ? e.message : "Failed to load transactions"))
      .finally(() => !cancelled && setTxLoading(false));
    return () => { cancelled = true; };
  }, [page, currency]);

  return (
    <>
      <h1>Wallet</h1>
      <p className="muted">Demo wallets in EUR and USD. No real money is involved.</p>

      {balError && <p className="alert" role="alert">{balError}</p>}
      {!balances && !balError && <p className="muted">Loading balances…</p>}
      {balances && (
        <div className="wallet-cards">
          {balances.map((b) => (
            <section key={b.currency} className="card wallet-card" aria-label={`${b.currency} wallet`}>
              <div className="row between">
                <span className="badge physical">{b.currency}</span>
                <span className="muted small">{NAMES[b.currency]} ({SYMBOLS[b.currency]})</span>
              </div>
              <p className="balance">{money(b.balanceMinor, b.currency)}</p>
              <p className="muted small">Available balance</p>
            </section>
          ))}
        </div>
      )}

      <div className="row wallet-actions">
        <button className="btn" onClick={() => setTopUpOpen(true)} aria-expanded={topUpOpen}>Top up EUR</button>
        <button className="btn ghost" disabled aria-disabled="true">Exchange — Coming soon</button>
      </div>

      {topUpOpen && <TopUpPanel onClose={() => setTopUpOpen(false)} />}

      <section className="card">
        <div className="row between">
          <h2>Transaction history</h2>
          <div className="field inline">
            <label htmlFor="cur">Currency</label>
            <select id="cur" value={currency} onChange={(e) => { setCurrency(e.target.value as "" | "EUR" | "USD"); setPage(1); }}>
              <option value="">All</option>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
          </div>
        </div>
        {txError && <p className="alert" role="alert">{txError}</p>}
        {txLoading && !txs && <p className="muted">Loading transactions…</p>}
        {txs && txs.items.length === 0 && !txError && (
          <div className="center-card"><h3>No transactions yet</h3><p className="muted">Top-ups and purchases will appear here.</p></div>
        )}
        {txs && txs.items.length > 0 && (
          <ul className="tx-list" aria-busy={txLoading}>
            {txs.items.map((t) => (
              <li key={t.reference} className="tx">
                <div>
                  <strong>{t.description ?? (t.type === "CREDIT" ? "Credit" : "Debit")}</strong>
                  <div className="muted small">
                    {new Date(t.createdAt).toLocaleString()} · Ref {t.reference.slice(0, 8).toUpperCase()}
                  </div>
                </div>
                <div className="tx-amount">
                  <span className={t.type === "CREDIT" ? "pos" : "neg"}>
                    {t.type === "CREDIT" ? "+" : "−"}{money(t.amountMinor, t.currency)}
                  </span>
                  {t.balanceAfterMinor !== null && <div className="muted small">Balance {money(t.balanceAfterMinor, t.currency)}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {txs && txs.totalPages > 1 && (
          <div className="row pager">
            <button className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Previous</button>
            <span className="muted small">Page {txs.page} of {txs.totalPages}</span>
            <button className="btn ghost" disabled={page >= txs.totalPages} onClick={() => setPage(page + 1)}>Next →</button>
          </div>
        )}
      </section>
    </>
  );
}

const PRESETS = [1000, 2500, 5000, 10000];
const MIN_MINOR = 500;
const MAX_MINOR = 50000;

/** "12.5" -> 1250. String math only, no floating point. Returns null if invalid. */
function eurosToMinor(input: string): number | null {
  const m = /^(\d{1,5})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
}

function TopUpPanel({ onClose }: { onClose: () => void }) {
  const [preset, setPreset] = useState<number | null>(2500);
  const [custom, setCustom] = useState("");
  const [step, setStep] = useState<"choose" | "confirm">("choose");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const amountMinor = custom.trim() !== "" ? eurosToMinor(custom) : preset;

  function validate(): string {
    if (amountMinor === null) return "Enter a valid amount, for example 25 or 12.50";
    if (amountMinor < MIN_MINOR) return "Minimum top-up is €5.00";
    if (amountMinor > MAX_MINOR) return "Maximum top-up is €500.00";
    return "";
  }

  async function pay() {
    if (busy || amountMinor === null) return; // blocks duplicate submissions
    setBusy(true);
    setError("");
    try {
      const r = await api<{ checkoutUrl: string }>("/api/top-ups", { method: "POST", body: { currency: "EUR", amountMinor } });
      window.location.assign(r.checkoutUrl); // Stripe hosted Checkout (test mode)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the payment");
      setBusy(false);
    }
  }

  return (
    <section className="card topup" aria-label="Top up EUR wallet">
      <div className="row between">
        <h2>Top up EUR wallet</h2>
        <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
      </div>
      <p className="notice">Stripe TEST mode: no real money is charged. Use the test card 4242 4242 4242 4242 with any future expiry and any CVC.</p>
      {error && <p className="alert" role="alert">{error}</p>}

      {step === "choose" ? (
        <>
          <div className="chips" role="group" aria-label="Amount">
            {PRESETS.map((p) => (
              <button key={p} className={`chip ${custom.trim() === "" && preset === p ? "on" : ""}`} onClick={() => { setPreset(p); setCustom(""); setError(""); }}>
                {money(p, "EUR")}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="custom-amount">Or enter a custom amount (EUR 5 – 500)</label>
            <input id="custom-amount" inputMode="decimal" placeholder="e.g. 75" value={custom} onChange={(e) => { setCustom(e.target.value); setError(""); }} />
          </div>
          <button className="btn" onClick={() => { const v = validate(); setError(v); if (!v) setStep("confirm"); }}>Continue</button>
        </>
      ) : (
        <>
          <p>You are about to top up <strong>{money(amountMinor ?? 0, "EUR")}</strong>. You will be redirected to Stripe's hosted checkout to pay.</p>
          <div className="row">
            <button className="btn" onClick={pay} disabled={busy}>{busy ? "Redirecting…" : `Confirm and pay ${money(amountMinor ?? 0, "EUR")}`}</button>
            <button className="btn ghost" onClick={() => setStep("choose")} disabled={busy}>Back</button>
          </div>
        </>
      )}
    </section>
  );
}

type TopUp = { id: string; status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELED"; amountMinor: number; currency: "EUR" };

/** Landing page after Stripe. The redirect itself proves nothing: we show the status the backend has verified. */
export function TopUpResultPage() {
  const [params] = useSearchParams();
  const id = params.get("topUp");
  const canceledReturn = params.get("canceled") === "1";
  const [topUp, setTopUp] = useState<TopUp | null>(null);
  const [error, setError] = useState("");
  const [gaveUp, setGaveUp] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const cancelSent = useRef(false);

  useEffect(() => {
    if (!id) { setError("Missing top-up reference."); return; }
    let stop = false;
    let attempts = 0;
    async function tick() {
      try {
        if (canceledReturn && !cancelSent.current) {
          cancelSent.current = true;
          const r = await api<{ topUp: TopUp }>(`/api/top-ups/${id}/cancel`, { method: "POST" });
          if (!stop) setTopUp(r.topUp);
          if (r.topUp.status !== "PENDING") return;
        }
        const r = await api<{ topUp: TopUp }>(`/api/top-ups/${id}`);
        if (stop) return;
        setTopUp(r.topUp);
        if (r.topUp.status === "PENDING") {
          if (++attempts >= 30) setGaveUp(true); // ~75 s, then stop polling
          else setTimeout(tick, 2500);
        }
      } catch (e) {
        if (!stop) setError(e instanceof ApiError ? e.message : "Could not check the payment status");
      }
    }
    void tick();
    return () => { stop = true; };
  }, [id, canceledReturn]);

  useEffect(() => {
    if (topUp?.status !== "SUCCEEDED") return;
    api<{ wallet: { balances: Balance[] } }>("/api/wallet")
      .then((r) => setBalance(r.wallet.balances.find((b) => b.currency === "EUR")?.balanceMinor ?? null))
      .catch(() => {});
  }, [topUp?.status]);

  return (
    <>
      <h1>Top-up status</h1>
      <section className="card center-card" aria-live="polite">
        {error && <p className="alert" role="alert">{error}</p>}
        {!error && !topUp && <p className="muted">Checking your payment…</p>}
        {topUp?.status === "PENDING" && (
          <>
            <h2>{gaveUp ? "Still waiting for confirmation" : "Payment pending"}</h2>
            <p className="muted">
              {gaveUp
                ? "We haven't received confirmation from Stripe yet. Your wallet is only credited once the payment is confirmed. Check again in a moment."
                : "Waiting for Stripe to confirm your payment. This usually takes a few seconds."}
            </p>
            {gaveUp && <button className="btn" onClick={() => window.location.reload()}>Check again</button>}
          </>
        )}
        {topUp?.status === "SUCCEEDED" && (
          <>
            <h2 className="pos">Payment successful</h2>
            <p>{money(topUp.amountMinor, topUp.currency)} was added to your EUR wallet.</p>
            {balance !== null && <p className="muted">New EUR balance: <strong>{money(balance, "EUR")}</strong></p>}
          </>
        )}
        {topUp?.status === "CANCELED" && (
          <>
            <h2>Payment canceled</h2>
            <p className="muted">No money was charged and your balance is unchanged.</p>
          </>
        )}
        {topUp?.status === "FAILED" && (
          <>
            <h2 className="neg">Payment failed</h2>
            <p className="muted">The payment could not be completed. Your balance is unchanged.</p>
          </>
        )}
        <p><Link className="btn" to="/wallet">Back to wallet</Link></p>
      </section>
    </>
  );
}
