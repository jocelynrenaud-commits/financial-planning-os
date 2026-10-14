/* THE PORTFOLIO: private deals and everything else, as one thing.
 *
 * The first version of this schema said Balances held "everything that is not a private
 * deal", and that was wrong. A deal sits IN an account -- an IRA, a Roth, an SDIRA, a
 * taxable account -- so private and public are not two worlds. They are two levels of
 * DETAIL on one portfolio:
 *
 *   Positions   one row per deal, because each has terms and timing
 *   Balances    one row per account x sleeve, because an index fund has no exit window
 *
 * Joined on Account. That join is what makes allocation honest, withdrawal ordering
 * possible, and -- when tax arrives -- a pre-tax total that includes the deals inside it.
 *
 * NOTHING HERE IS REQUIRED. A tracker with none of these tabs produces an empty portfolio
 * and the app says so. That is the whole backward-compatibility promise: the sheet people
 * already have keeps working, and the new tabs add rather than replace.
 */
(function (root) {
  'use strict';

  const num = (v) => {
    if (v == null || v === '') return 0;
    const n = Number(String(v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const low = (v) => String(v == null ? '' : v).trim().toLowerCase();

  /* A sheet is identified by what it CONTAINS, not by its name. People rename tabs, and a
     tab called "Balances (2027)" is still a balances tab. */
  function findSheet(sheets, test) {
    for (const nm of Object.keys(sheets || {})) {
      const aoa = sheets[nm] || [];
      const hit = test(aoa, nm);
      if (hit) return { name: nm, aoa, hdr: hit.hdr, map: hit.map };
    }
    return null;
  }

  function headerMap(row, spec) {
    const map = {};
    (row || []).forEach((h, i) => {
      const k = low(h);
      if (!k) return;
      for (const [field, names] of spec) {
        if (map[field] != null) continue;
        if (names.some((n) => k === n || k.startsWith(n))) { map[field] = i; return; }
      }
    });
    return map;
  }

  /* ── You: label/value pairs, deliberately not a header table ─────────────
     A two-column list cannot be mistaken for positions by the deal scanner, which walks
     every sheet looking for a name and a commitment. */
  const YOU_KEYS = [
    ['birthYear', ['birth year', 'year of birth', 'born']],
    ['stopYear', ['stop work', 'planned stop', 'retire in', 'stop year']],
    ['planToAge', ['plan to age', 'plan until', 'horizon age', 'plan to']],
    ['spend', ['annual spend', 'spend target', 'target spend']],
    ['floorSpend', ['floor spend', 'floor', 'must-have', 'must have']],
    ['inflPre', ['inflation until', 'inflation before', 'inflation pre']],
    ['inflPost', ['inflation after', 'inflation post', 'inflation in retirement']],
    ['benefitAge', ['benefit start age', 'benefit age', 'claim age', 'social security age']],
    ['benefitAnnual', ['estimated annual benefit', 'annual benefit', 'benefit', 'social security']],
  ];

  function parseYou(sheets) {
    let found = null;
    for (const nm of Object.keys(sheets || {})) {
      const aoa = sheets[nm] || [];
      const got = {};
      let hits = 0;
      for (const row of aoa) {
        if (!row || row.length < 2) continue;
        const k = low(row[0]);
        if (!k) continue;
        for (const [field, names] of YOU_KEYS) {
          if (got[field] != null) continue;
          if (names.some((n) => k === n || k.startsWith(n))) {
            const v = row.slice(1).find((c) => c != null && c !== '');
            if (v != null) { got[field] = v; hits++; }
            break;
          }
        }
      }
      /* Two matches is the threshold. One could be a coincidence in a notes tab; a real
         You tab carries several. */
      if (hits >= 2 && (!found || hits > found.hits)) found = { name: nm, got, hits };
    }
    if (!found) return null;

    const g = found.got;
    const pctOf = (v) => { const n = num(v); return n > 1 ? n / 100 : n; };
    const out = { _sheet: found.name, _fields: Object.keys(g) };
    if (g.birthYear != null) out.birthYear = parseInt(num(g.birthYear), 10);
    if (g.stopYear != null) out.stopYear = parseInt(num(g.stopYear), 10);
    if (g.planToAge != null) out.planToAge = parseInt(num(g.planToAge), 10);
    if (g.spend != null) out.spend = num(g.spend);
    if (g.floorSpend != null) out.floorSpend = num(g.floorSpend);
    if (g.inflPre != null) out.inflPre = pctOf(g.inflPre);
    if (g.inflPost != null) out.inflPost = pctOf(g.inflPost);
    if (g.benefitAge != null) out.benefitAge = parseInt(num(g.benefitAge), 10);
    if (g.benefitAnnual != null) out.benefitAnnual = num(g.benefitAnnual);
    return out;
  }

  /* ── Balances: one row per account x sleeve ─────────────────────────────── */
  const BAL_SPEC = [
    /* Narrower first, for the reason the deal parser records: matching is by prefix, so
       'account type' must be claimed before a bare 'account' can take it. */
    ['type', ['account type', 'account kind', 'registration type', 'tax treatment']],
    ['account', ['account', 'held in', 'custodian', 'wrapper', 'registration']],
    ['sleeve', ['sleeve', 'role', 'bucket']],
    ['label', ['label', 'holding', 'description', 'name', 'fund']],
    ['value', ['value', 'balance', 'market value', 'amount', 'current value']],
    ['basis', ['cost basis', 'basis', 'cost']],
    ['yield', ['yield']],
    ['ret', ['expected return', 'return', 'assumed return']],
    ['vol', ['volatility', 'vol', 'std dev']],
    ['asOf', ['as of', 'as-of', 'date']],
  ];

  function parseBalances(sheets) {
    const hit = findSheet(sheets, (aoa) => {
      for (let i = 0; i < Math.min(aoa.length, 12); i++) {
        const map = headerMap(aoa[i], BAL_SPEC);
        /* A balances sheet is one that has a VALUE and an ACCOUNT. Positions has neither
           under those names, so the two cannot be confused. */
        if (map.value != null && map.account != null) return { hdr: i, map };
      }
      return null;
    });
    if (!hit) return null;

    const rows = [];
    for (let i = hit.hdr + 1; i < hit.aoa.length; i++) {
      const r = hit.aoa[i] || [];
      const get = (f) => (hit.map[f] != null ? r[hit.map[f]] : '');
      const value = num(get('value'));
      const account = String(get('account') || '').trim();
      if (!(value > 0) || !account) continue;
      const pctOf = (v) => { const n = num(v); return n > 1 ? n / 100 : n; };
      /* A BLANK CELL IS NOT A ZERO. Testing only against '' let an empty spreadsheet cell
         -- which arrives as null, not '' -- become an explicit 0, so a sleeve with no
         stated expected return compounded at 0% a year instead of falling back to the
         model's assumption. The app would then print a confident number nobody typed, and
         a pessimistic one, which is the direction that looks responsible and is still
         wrong. Found by parsing this app's own template. */
      const said = (v) => v !== '' && v != null;
      rows.push({
        account,
        type: String(get('type') || '').trim(),
        sleeve: String(get('sleeve') || '').trim(),
        label: String(get('label') || '').trim(),
        value,
        basis: num(get('basis')),
        yield: said(get('yield')) ? pctOf(get('yield')) : null,
        ret: said(get('ret')) ? pctOf(get('ret')) : null,
        vol: said(get('vol')) ? pctOf(get('vol')) : null,
      });
    }
    return rows.length ? { sheet: hit.name, rows } : null;
  }

  /* ── Property ───────────────────────────────────────────────────────────
     A property is four things at once -- an asset, a liability, an income stream and a
     DATED liquidity event -- and folding it into Balances would keep only the first. The
     sale year is usually the largest single dated event in a plan, which is the whole
     reason it gets its own tab rather than a row. */
  const PROP_SPEC = [
    ['sellYear', ['sell in year', 'sell year', 'sale year', 'sell in']],
    ['costToSell', ['cost to sell', 'selling costs', 'costs to sell']],
    ['mortgage', ['mortgage balance', 'mortgage', 'loan balance', 'debt']],
    ['rate', ['rate', 'interest rate']],
    ['payment', ['payment', 'monthly payment', 'payment / mo', 'payment per month']],
    ['rent', ['net rent', 'rent', 'net rent / mo', 'rental income']],
    ['value', ['value', 'market value', 'estimated value']],
    ['name', ['property', 'name', 'label', 'address']],
  ];

  function parseProperty(sheets) {
    const hit = findSheet(sheets, (aoa) => {
      for (let i = 0; i < Math.min(aoa.length, 12); i++) {
        const map = headerMap(aoa[i], PROP_SPEC);
        /* Identified by the pair nothing else has: a value AND a sell year. Balances has a
           value and no sell year; Events has a year and no mortgage. */
        if (map.value != null && map.sellYear != null) return { hdr: i, map };
      }
      return null;
    });
    if (!hit) return null;

    const said = (v) => v !== '' && v != null;
    const pctOf = (v) => { const n = num(v); return n > 1 ? n / 100 : n; };
    const rows = [];
    for (let i = hit.hdr + 1; i < hit.aoa.length; i++) {
      const r = hit.aoa[i] || [];
      const get = (f) => (hit.map[f] != null ? r[hit.map[f]] : '');
      const value = num(get('value'));
      if (!(value > 0)) continue;
      rows.push({
        name: String(get('name') || 'Property').trim(),
        value,
        mortgage: num(get('mortgage')),
        rate: said(get('rate')) ? pctOf(get('rate')) : 0,
        payment: num(get('payment')),
        rent: num(get('rent')),
        sellYear: said(get('sellYear')) ? parseInt(num(get('sellYear')), 10) : null,
        costToSell: said(get('costToSell')) ? pctOf(get('costToSell')) : 0.06,
      });
    }
    return rows.length ? { sheet: hit.name, rows } : null;
  }

  /* ── Cashflows and Events ───────────────────────────────────────────────── */
  const FLOW_SPEC = [
    ['starts', ['starts', 'start year', 'from', 'begins']],
    ['ends', ['ends', 'end year', 'to', 'until']],
    ['inflates', ['inflate', 'inflates', 'indexed', 'rises with inflation']],
    ['amount', ['amount / yr', 'amount per year', 'amount', 'annual', 'per year']],
    ['account', ['account', 'into', 'from account']],
    ['label', ['label', 'name', 'description', 'what']],
  ];

  function parseCashflows(sheets) {
    const hit = findSheet(sheets, (aoa) => {
      for (let i = 0; i < Math.min(aoa.length, 12); i++) {
        const map = headerMap(aoa[i], FLOW_SPEC);
        if (map.amount != null && map.starts != null) return { hdr: i, map };
      }
      return null;
    });
    if (!hit) return null;
    const rows = [];
    for (let i = hit.hdr + 1; i < hit.aoa.length; i++) {
      const r = hit.aoa[i] || [];
      const get = (f) => (hit.map[f] != null ? r[hit.map[f]] : '');
      const amount = num(get('amount'));
      const starts = parseInt(num(get('starts')), 10);
      if (!amount || !starts) continue;
      const ends = parseInt(num(get('ends')), 10) || null;
      const inf = low(get('inflates'));
      rows.push({
        label: String(get('label') || 'Cashflow').trim(),
        amount, starts, ends,
        account: String(get('account') || '').trim(),
        inflates: inf === '' ? true : !(inf === 'no' || inf === 'n' || inf === 'false' || inf === '0'),
      });
    }
    return rows.length ? { sheet: hit.name, rows } : null;
  }

  const EVENT_SPEC = [
    ['year', ['year', 'when', 'in year']],
    ['amount', ['amount', 'value', 'sum']],
    ['account', ['account', 'into', 'from account']],
    ['label', ['label', 'name', 'description', 'what']],
  ];

  function parseEvents(sheets, taken) {
    const hit = findSheet(sheets, (aoa, nm) => {
      /* A sheet already claimed as Cashflows or Property must not be re-read as Events:
         both carry a year and an amount, and the looser spec here would match them. */
      if (taken && taken.indexOf(nm) >= 0) return null;
      for (let i = 0; i < Math.min(aoa.length, 12); i++) {
        const map = headerMap(aoa[i], EVENT_SPEC);
        if (map.amount != null && map.year != null && map.label != null) return { hdr: i, map };
      }
      return null;
    });
    if (!hit) return null;
    const rows = [];
    for (let i = hit.hdr + 1; i < hit.aoa.length; i++) {
      const r = hit.aoa[i] || [];
      const get = (f) => (hit.map[f] != null ? r[hit.map[f]] : '');
      const amount = num(get('amount'));
      const year = parseInt(num(get('year')), 10);
      if (!amount || !year) continue;
      rows.push({
        label: String(get('label') || 'Event').trim(),
        year, amount,
        account: String(get('account') || '').trim(),
      });
    }
    return rows.length ? { sheet: hit.name, rows } : null;
  }

  /* Everything dated, as one stream the runway can spend. Sign convention: POSITIVE is
     money arriving. A property sale is net of its mortgage and its selling costs, because
     the gross price is not what reaches the plan. */
  function datedFlows(port, horizonYear) {
    /* A BLANK "ENDS" MEANS FOR THE REST OF THE PLAN, not once. Defaulting the end to the
       start year paid a pension for exactly one year and then stopped -- which is the
       single most common way this tab will be filled in, since most people know when a
       pension begins and not when it ends. The horizon comes from the You tab; with no
       You tab there is no plan to run to, and an open-ended flow stays a single year
       rather than being invented out to a number nobody gave. */
    const horizon = horizonYear
      || (port.you && port.you.birthYear && port.you.planToAge
            ? port.you.birthYear + port.you.planToAge
            : null);
    const out = {};
    const add = (y, amt, label) => {
      if (!y || !amt) return;
      (out[y] = out[y] || { net: 0, items: [] });
      out[y].net += amt;
      out[y].items.push({ label, amount: amt });
    };
    (port.property ? port.property.rows : []).forEach((p) => {
      if (!p.sellYear) return;
      const net = p.value * (1 - p.costToSell) - p.mortgage;
      add(p.sellYear, net, 'Sale of ' + p.name);
    });
    (port.cashflows ? port.cashflows.rows : []).forEach((f) => {
      const end = f.ends || horizon || f.starts;
      /* Guard the loop as well as the end: a typo putting the end before the start, or a
         horizon a century out, should not hang the page. */
      const last = Math.min(end, f.starts + 120);
      for (let y = f.starts; y <= last; y++) add(y, f.amount, f.label);
    });
    (port.events ? port.events.rows : []).forEach((e) => add(e.year, e.amount, e.label));
    return out;
  }

  /* ── the join ───────────────────────────────────────────────────────────── */

  /* Braiden's sleeve names, mapped onto the model's four archetypes. A sleeve the model
     does not recognise is treated as growth and SAID SO, rather than silently assigned. */
  const SLEEVE_KIND = {
    growth: 'growth', equities: 'growth', equity: 'growth', venture: 'growth',
    convex: 'growth', tech: 'growth',
    income: 'income', credit: 'income', debt: 'income', 'real estate': 'income',
    /* 'ballast' stays accepted. It was the name until 2026-09-30 and a blanket rename
       collapsed it into a duplicate key, which silently stopped recognising it -- any sheet
       already filled in with the old word would have been reclassified as Growth without
       a word on screen. An old name costs one alias; dropping it costs somebody their
       allocation. */
    bonds: 'bonds', ballast: 'bonds', treasuries: 'bonds', bond: 'bonds',
    cash: 'cash', 'money market': 'cash',
  };

  /* WHICH TAX BUCKET AN ACCOUNT FALLS IN, from its name.

     ROTH IS TESTED FIRST AND THAT IS THE WHOLE TRICK: "Roth IRA" contains "IRA", so checking
     the pre-tax patterns first taxes tax-free money at the ordinary rate, which is the single
     most expensive mistake available here. An HSA is tax-free on the way out for its purpose
     and is grouped with Roth. Anything unrecognised is treated as TAXABLE, which is the
     cautious default: it taxes the withdrawal at the gains rate rather than at zero. */
  function taxTreatment(account, type) {
    const t = (String(account || '') + ' ' + String(type || '')).toLowerCase();
    if (/roth|hsa|529|tax.?free/.test(t)) return 'roth';
    if (/401|403|457|tsp|sep|simple|trad|pre.?tax|deferred|\bira\b|sdira|rollover/.test(t)) {
      return 'preTax';
    }
    return 'taxable';
  }

  function kindOf(sleeve) {
    const k = low(sleeve);
    if (SLEEVE_KIND[k]) return { kind: SLEEVE_KIND[k], known: true };
    for (const key of Object.keys(SLEEVE_KIND)) {
      if (k && k.startsWith(key)) return { kind: SLEEVE_KIND[key], known: true };
    }
    return { kind: 'growth', known: false };
  }

  /**
   * One portfolio from both halves.
   * @param sheets  every sheet of the workbook, by name
   * @param book    the parsed deal book (Engine.buildBook output)
   */
  function build(sheets, book) {
    const you = parseYou(sheets);
    const bal = parseBalances(sheets);
    const prop = parseProperty(sheets);
    const flows = parseCashflows(sheets);
    /* Events is matched LAST and told which sheets are spoken for. Its spec is the loosest
       of the three -- a year, an amount and a label -- so left to itself it would happily
       re-read the Cashflows tab and double every recurring line. */
    const taken = [bal && bal.sheet, prop && prop.sheet, flows && flows.sheet].filter(Boolean);
    const events = parseEvents(sheets, taken);
    const deals = (book || []).slice();

    /* Accounts come from BOTH halves. An account named only on a deal row is still an
       account, and one named only on Balances is too. */
    const accounts = {};
    const touch = (name) => {
      const k = name || '';
      if (!accounts[k]) accounts[k] = { name: k, type: '', liquid: 0, private: 0, sleeves: {} };
      return accounts[k];
    };

    (bal ? bal.rows : []).forEach((r) => {
      const a = touch(r.account);
      if (!a.type && r.type) a.type = r.type;
      a.liquid += r.value;
      const kk = kindOf(r.sleeve);
      const s = (a.sleeves[kk.kind] = a.sleeves[kk.kind] || { value: 0, known: kk.known });
      s.value += r.value;
      if (!kk.known) s.known = false;
    });

    deals.forEach((d) => {
      const a = touch(d.account || '');
      /* Committed, not funded: it is the commitment the plan is on the hook for, and the
         same basis every other panel in this app uses. */
      a.private += d.commitment || 0;
    });

    /* The model's sleeves, from Balances only. Deals are NOT folded in as a balance --
       they arrive as dated proceeds from the deal engine, which is the entire reason
       this tool exists. Counting them twice would be the worst available bug. */
    const sleeves = [];
    const byKind = {};
    (bal ? bal.rows : []).forEach((r) => {
      const kk = kindOf(r.sleeve);
      const s = (byKind[kk.kind] = byKind[kk.kind]
        || { id: kk.kind, label: kk.kind.charAt(0).toUpperCase() + kk.kind.slice(1),
             kind: kk.kind, balance: 0, retW: 0, volW: 0, yldW: 0,
             wRet: 0, wVol: 0, wYld: 0, unknown: 0 });
      s.balance += r.value;
      /* A WEIGHT PER FIELD. One shared counter meant a holding that stated a yield but no
         expected return contributed nothing at all -- a muni fund at 4% lost its yield
         because the return column beside it was blank, which is exactly how most people
         fill this in. */
      if (r.ret != null) { s.retW += r.ret * r.value; s.wRet += r.value; }
      if (r.vol != null) { s.volW += r.vol * r.value; s.wVol += r.value; }
      if (r.yield != null) { s.yldW += r.yield * r.value; s.wYld += r.value; }
      if (!kk.known) s.unknown += r.value;
      /* HOW THIS MONEY IS TAXED WHEN IT COMES OUT, carried as a value-weighted blend so a
         Growth sleeve that is 70% 401k and 30% brokerage can be taxed as what it is. Read off
         the account name, which people already type, rather than asking for another column. */
      const tt = taxTreatment(r.account, r.type);
      s.tax = s.tax || { preTax: 0, roth: 0, taxable: 0 };
      s.tax[tt] += r.value;
    });
    Object.keys(byKind).forEach((k) => {
      const s = byKind[k];
      const out = { id: s.id, label: s.label, kind: s.kind, balance: s.balance };
      /* Value-weighted, each field over its OWN weight, and only where someone actually
         stated a number. A blank column must leave the model's default in place rather
         than averaging in a zero. */
      if (s.wRet > 0) out.mu = s.retW / s.wRet;
      if (s.wVol > 0) out.sd = s.volW / s.wVol;
      if (s.wYld > 0) out.yield = s.yldW / s.wYld;
      out.unknownSleeveValue = s.unknown;
      if (s.tax) {
        const tot = s.tax.preTax + s.tax.roth + s.tax.taxable;
        if (tot > 0) {
          out.taxMix = { preTax: s.tax.preTax / tot, roth: s.tax.roth / tot,
                         taxable: s.tax.taxable / tot };
        }
      }
      sleeves.push(out);
    });

    /* A property is an asset on the allocation AND a dated event later. It is added to
       its account's net worth here; datedFlows handles the sale. Net of the mortgage,
       because the debt is real. */
    (prop ? prop.rows : []).forEach((p) => {
      const a = touch(p.name);
      a.property = (a.property || 0) + Math.max(0, p.value - p.mortgage);
    });

    const unnamed = deals.filter((d) => !d.account).length;
    const out = {
      you,
      balances: bal,
      property: prop,
      cashflows: flows,
      events,
      sleeves,
      accounts: Object.keys(accounts).map((k) => accounts[k]),
      dealsWithoutAccount: unnamed,
      dealCount: deals.length,
      hasAny: !!(you || bal || prop || flows || events),
    };
    out.dated = datedFlows(out);
    return out;
  }

  root.Portfolio = { build, parseYou, parseBalances, parseProperty, parseCashflows,
                     taxTreatment,
                     parseEvents, datedFlows, kindOf, SLEEVE_KIND };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Portfolio;
}(typeof window !== 'undefined' ? window : globalThis));
