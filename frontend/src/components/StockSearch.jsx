import { useEffect, useRef, useState } from 'react';
import { searchSymbols } from '../services/api.js';

export default function StockSearch({ symbol, onSelect }) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hi, setHi] = useState(-1);
  const box = useRef(null);
  const timer = useRef(null);

  useEffect(() => { if (!open) setText(''); }, [symbol, open]);
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(timer.current);
    let alive = true;
    timer.current = setTimeout(async () => {
      try { const r = await searchSymbols(text); if (alive) { setItems(r.results || []); setHi(-1); } } catch { if (alive) setItems([]); }
    }, 180);
    return () => { alive = false; clearTimeout(timer.current); };
  }, [text, open]);
  useEffect(() => {
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, []);

  const pick = (sym) => { const s = sym.trim().toUpperCase(); if (s) { onSelect(s); setOpen(false); setText(''); } };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(-1, h - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const t = text.trim().toUpperCase().replace(/\s+/g, '');
      const exact = items.find((it) => it.symbol === t);
      const prefix = items.find((it) => it.symbol.startsWith(t));
      pick(hi >= 0 ? items[hi].symbol : exact ? exact.symbol : prefix && t.length >= 2 ? prefix.symbol : text);
    }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="search" ref={box}>
      <label className="search-field">
        <i className="bi bi-search" />
        <input
          type="text" value={text} placeholder="Search NSE stock, e.g. RELIANCE" autoComplete="off" spellCheck="false"
          aria-label="Search NSE stock" aria-expanded={open} role="combobox" aria-controls="stock-list"
          onFocus={() => setOpen(true)} onChange={(e) => { setText(e.target.value); setOpen(true); }} onKeyDown={onKey}
        />
        <kbd>Enter</kbd>
      </label>
      {open && items.length > 0 && (
        <ul className="search-list glass" id="stock-list" role="listbox">
          {items.map((it, i) => (
            <li key={it.symbol} role="option" aria-selected={i === hi} className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(it.symbol); }}>
              <b>{it.symbol}</b><span>{it.name}</span><em>{it.exchange}</em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
