import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { money } from "./cart";

type Cur = "EUR" | "USD";
type Balance = { currency: Cur; balanceMinor: number };
type Quote = {
  fromCurrency: Cur; toCurrency: Cur; fromAmountMinor: number; toAmountMinor: number;
  rateNumerator: number; rateDenominator: number; rateVersion: string; rateText: string;
  availableBalanceMinor: number; sufficientFunds: boolean;
};
type Exchange = { id: string; fromCurrency: Cur; toCurrency: Cur; fromAmountMinor: number; toAmountMinor: number; rateVersion: string; debitReference: string; createdAt: string };
type History = { items: Exchange[]; page: number; total: number; totalPages: number };

/** "12.5" -> 1250. String math only, never floating point. Returns null if invalid or zero. */
export function amountToMinor(input: string): number | null {
  const m = /^(\d{1,8})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || 0);
  return minor > 0 ? minor : null;
}

const newKey = () => `ex-${crypto.randomUUID()}`;

export function ExchangePanel({ balances, onClose, onDone }: { balances: Balance[] | null; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState<Cur>("EUR");
  const to: Cur = from === "EUR" ? "USD" : "EUR";
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [step, setStep] = useState<"enter" | "confirm" | "done">("enter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0); // bump to force a fresh quote
  const [result, setResult] = useState<{ exchange: Exchange; balances: Balance[] } | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [histPage, setHistPage] = useState(1);
  const [histError, setHistError] = useState("");

  // One idempotency key per logical attempt. It survives retries (including ambiguous network failures)
  // and is replaced only after success or when the attempt itself (direction / amount) changes.
  const keyRef = useRef<string | null>(null);
  const submitting = useRef(false);

  const minor = amountToMinor(amount);
  const balance = balances?.find((b) => b.currency === from)?.balanceMinor ?? null;

  // Any change to the attempt invalidates the confirmation and the key.
  useEffect(() => {
    keyRef.current = null;
    setStep((s) => (s === "done" ? s : "enter"));
    setError("");
  }, [from, amount]);

  // Debounced server quote: the browser never computes the received amount.
  useEffect(() => {
    setQuote(null);
    setQuoteError("");
    if (amount.trim() === "") return;
    if (minor === null) { setQuoteError("Enter a valid amount, for example 100 or 12.50"); return; }
    let cancelled = false;
    setQuoting(true);
    const t = setTimeout(() => {
      api<{ quote: Quote }>(`/api/exchange/quote?${new URLSearchParams({ fromCurrency: from, toCurrency: to, amountMinor: String(minor) })}`)
        .then((r) => !cancelled && setQuote(r.quote))
        .catch((e) => !cancelled && setQuoteError(e instanceof ApiError ? e.message : "Could not get a quote"))
        .finally(() => !cancelled && setQuoting(false));
    }, 300);
    return () => { cancelled = true; clearTimeout(t); setQuoting(false); };
  }, [from, to, amount, minor, nonce]);

  useEffect(() => {
    let cancelled = false;
    api<History>(`/api/exchanges?page=${histPage}&pageSize=5`)
      .then((r) => !cancelled && (setHistory(r), setHistError("")))
      .catch((e) => !cancelled && setHistError(e instanceof ApiError ? e.message : "Failed to load exchange history"));
    return () => { cancelled = true; };
  }, [histPage, result]);

  async function confirm() {
    if (submitting.current || !quote) return; // synchronous guard: blocks double clicks / double submits
    submitting.current = true;
    setBusy(true);
    setError("");
    keyRef.current ??= newKey();
    try {
      const r = await api<{ exchange: Exchange; balances: Balance[] }>("/api/exchange", {
        method: "POST",
        body: { fromCurrency: quote.fromCurrency, toCurrency: quote.toCurrency, amountMinor: quote.fromAmountMinor, rateVersion: quote.rateVersion, idempotencyKey: keyRef.current },
      });
      keyRef.current = null;
      setResult(r);
      setStep("done");
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_RATE") {
        keyRef.current = null;
        setStep("enter");
        setError("The exchange rate changed. We refreshed your quote — please review it and confirm again.");
        setNonce((n) => n + 1);
      } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        keyRef.current = null; // definite rejection: nothing was exchanged
        setError(e.code === "INSUFFICIENT_FUNDS" ? `Insufficient ${from} balance.` : e.message);
        setStep("enter");
      } else {
        // Ambiguous (network error / 5xx): the key is kept, so retrying can never exchange twice.
        setError("We could not confirm whether the exchange went through. Press Confirm again to safely retry — you will not be charged twice.");
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function reset() {
    setResult(null);
    setAmount("");
    setStep("enter");
  }

  return (
    <section className="card exchange" aria-label="Currency exchange">
      <div className="row between">
        <h2>Exchange currency</h2>
        <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
      </div>
      <p className="muted small">Demo rate: 1 EUR = 1.10 USD. Illustrative only, not real market pricing. No fee.</p>

      {step === "done" && result ? (
        <div className="card success-card" role="status">
          <h2>Exchange complete</h2>
          <p>
            You exchanged <strong>{money(result.exchange.fromAmountMinor, result.exchange.fromCurrency)}</strong> for{" "}
            <strong>{money(result.exchange.toAmountMinor, result.exchange.toCurrency)}</strong>.
          </p>
          <p className="muted small">
            {result.balances.map((b) => `${b.currency} ${money(b.balanceMinor, b.currency)}`).join(" · ")}
          </p>
          <div className="row">
            <a className="btn ghost" href="#exchange-history">View exchange history</a>
            <button className="btn" onClick={reset}>New exchange</button>
          </div>
        </div>
      ) : (
        <>
          <div className="exchange-dir row">
            <div className="field">
              <label htmlFor="ex-from">From</label>
              <select id="ex-from" value={from} onChange={(e) => setFrom(e.target.value as Cur)} disabled={busy}>
                <option value="EUR">EUR → USD</option>
                <option value="USD">USD → EUR</option>
              </select>
            </div>
            <button className="btn ghost swap" type="button" onClick={() => setFrom(to)} disabled={busy} aria-label="Swap direction">⇄ Swap</button>
          </div>
          <p className="muted small">Available {from}: {balance === null ? "…" : money(balance, from)}</p>

          <div className="field">
            <label htmlFor="ex-amount">Amount ({from})</label>
            <input id="ex-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} disabled={busy}
              aria-invalid={!!quoteError} onChange={(e) => setAmount(e.target.value)} />
            {quoteError && <p className="field-error" role="alert">{quoteError}</p>}
          </div>

          {quoting && <p className="muted small">Getting quote…</p>}
          {quote && (
            <div className="quote" aria-live="polite">
              <div className="row between"><span>You send</span><strong>{money(quote.fromAmountMinor, quote.fromCurrency)}</strong></div>
              <div className="row between"><span>You receive</span><strong>{money(quote.toAmountMinor, quote.toCurrency)}</strong></div>
              <p className="muted small">Rate {quote.rateNumerator}/{quote.rateDenominator} ({quote.rateVersion}) · {quote.rateText}. Rounded down to the cent. This quote does not reserve funds.</p>
              {!quote.sufficientFunds && (
                <p className="field-error" role="alert">
                  Insufficient {quote.fromCurrency} balance: you need {money(quote.fromAmountMinor - quote.availableBalanceMinor, quote.fromCurrency)} more.
                </p>
              )}
            </div>
          )}

          {error && <p className="alert" role="alert">{error}</p>}

          {step === "enter" && (
            <button className="btn" disabled={!quote || !quote.sufficientFunds || quoting} onClick={() => setStep("confirm")}>Review exchange</button>
          )}
          {step === "confirm" && quote && (
            <div className="confirm-box">
              <p>Confirm: exchange <strong>{money(quote.fromAmountMinor, quote.fromCurrency)}</strong> for <strong>{money(quote.toAmountMinor, quote.toCurrency)}</strong>?</p>
              <div className="row">
                <button className="btn" onClick={confirm} disabled={busy}>{busy ? "Exchanging…" : "Confirm exchange"}</button>
                <button className="btn ghost" onClick={() => setStep("enter")} disabled={busy}>Back</button>
              </div>
            </div>
          )}
        </>
      )}

      <h3 id="exchange-history">Exchange history</h3>
      {histError && <p className="alert" role="alert">{histError}</p>}
      {history && history.items.length === 0 && <p className="muted">No exchanges yet.</p>}
      {history && history.items.length > 0 && (
        <ul className="tx-list">
          {history.items.map((x) => (
            <li key={x.id} className="tx">
              <div>
                <strong>{x.fromCurrency} → {x.toCurrency}</strong>
                <div className="muted small">{new Date(x.createdAt).toLocaleString()} · Ref {x.id.slice(0, 8).toUpperCase()} · {x.rateVersion}</div>
              </div>
              <div className="tx-amount">
                <span className="neg">−{money(x.fromAmountMinor, x.fromCurrency)}</span>{" "}
                <span className="pos">+{money(x.toAmountMinor, x.toCurrency)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {history && history.totalPages > 1 && (
        <div className="row pager">
          <button className="btn ghost" disabled={histPage <= 1} onClick={() => setHistPage(histPage - 1)}>← Previous</button>
          <span className="muted small">Page {history.page} of {history.totalPages}</span>
          <button className="btn ghost" disabled={histPage >= history.totalPages} onClick={() => setHistPage(histPage + 1)}>Next →</button>
        </div>
      )}
    </section>
  );
}
