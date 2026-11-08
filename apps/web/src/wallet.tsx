import { useEffect, useState } from "react";
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
        <button className="btn" disabled aria-disabled="true">Top up — Coming in TASK 006</button>
        <button className="btn ghost" disabled aria-disabled="true">Exchange — Coming soon</button>
      </div>

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
          <div className="center-card"><h3>No transactions yet</h3><p className="muted">Top-ups, purchases and exchanges will appear here.</p></div>
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
