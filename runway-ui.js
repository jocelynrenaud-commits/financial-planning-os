/* THE LIQUIDITY RUNWAY TAB.
 *
 * Registers itself through the plugin hook in app.js, which is why app.js can stay
 * byte-identical between this app and the live Private Deals one. Nothing here is imported
 * by that app; it arrives only because index.html loads this file.
 *
 * THE SPLIT THIS TAB IS BUILT ON. The sheet holds what is true -- balances, ages, a benefit
 * estimate. The app holds what is assumed, as controls you can move and watch move. A number
 * you would have to reopen Excel to change is a number nobody ever tests a scenario against,
 * and scenario-testing is the whole point of a runway.
 *
 * Until a reader supplies a You tab and a Balances tab, the figures are the AUTHOR'S OWN,
 * and the panel says whose they are rather than letting somebody else's retirement read as
 * the reader's. Real numbers make that disclosure more important rather than less: a made-up
 * $180,000 spend reads as a placeholder, while a real $328,983 one reads as a claim about
 * whoever is looking at it.
 */
(function (root) {
  'use strict';

  /* THE AUTHOR'S REAL PROFILE, so the demo can be checked against something rather than
     admired. Every figure is read from a recorded source and none is invented:

       birthYear   retirement "was fixed at 2032-01-01, age 62"
       spend       250,000 * 1.04^(62-55), W-2 replacement at the stated retirement age
       floorSpend  THE SAME NUMBER on purpose. The stated objective is to "guarantee a
                   $330K/yr income floor by age 62" and no separate essentials figure
                   exists, so the target IS the floor. That makes the guardrail and
                   floor-first modes inert on this profile, which is a true thing about
                   the plan rather than a bug in the demo.
       benefit     claimed at max(62, retirement age), because claiming at 62 while still
                   earning would have nearly all of it withheld.

     THE SLEEVES EXCLUDE THE PRIVATE BOOK. Those arrive from the deal file, so putting the
     self-directed IRA in as a balance would count them twice -- its line-item reconcile
     splits it into deal assets plus cash, and only the cash is here. What remains is the
     liquid side: the growth account's equities, the options-income account, and the cash
     across both. Gold held inside the self-directed IRA sits with the deal assets rather
     than in a sleeve, which is a small known imprecision. */
  const DEMO = {
    label: 'the author\u2019s own figures, so you can see what a filled-in plan looks like',
    birthYear: 1970,
    stopYear: 2032,
    planToAge: 92,
    spend: 328983,
    floorSpend: 328983,
    benefitAge: 62,
    benefitAnnual: 33264,
    sleeves: [
      { id: 'growth', label: 'Growth', kind: 'growth', balance: 430805 },
      { id: 'income', label: 'Income', kind: 'income', balance: 335041 },
      { id: 'cash', label: 'Cash', kind: 'cash', balance: 363552 },
    ],
  };

  /* Live control state. Session-only on purpose: this app stores nothing, and "turn off your wifi
     and it still works" is a promise on the Glossary page. Moving a slider is a what-if,
     not a saved preference. */
  const LIVE = {};

  const MODES = [
    ['fixed', 'Fixed real spend', 'Ask for the full target every year, whatever the markets did.'],
    ['guard', 'Guardrails', 'Trim the ask in thin years, restore it in good ones.'],
    ['floor', 'Income floor first', 'Only ever ask for the must-have number.'],
  ];

  /* EVERY FIGURE THE MODEL PRODUCES IS IN THE DOLLARS OF ITS OWN YEAR, because that is
     what the arithmetic needs. On screen that is a trap: a plan ending with $12,410,179 in
     2067 reads as generational wealth and is about $3.6m in today money. A reader cannot be
     expected to deflate it in their head, so the figures most likely to mislead carry their
     today-money equivalent beside them. */
  function real(v, year, C) {
    const base = C.thisYear || new Date().getFullYear();
    const yrs = Math.max(0, year - base);
    return v / Math.pow(1 + (C.inflPost || 0.03), yrs);
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (v) => (v < 0 ? '-' : '') + '$' + Math.round(Math.abs(v)).toLocaleString('en-US');
  const pct = (v) => (v * 100).toFixed(0) + '%';

  /* What the workbook said, if it said anything. Parsed once per render from the sheets
     app.js kept on its way past them. */
  function fromSheet(ctx) {
    if (!root.Portfolio || !ctx || !ctx.sheets) return null;
    const p = root.Portfolio.build(ctx.sheets, ctx.book || []);
    return p && p.hasAny ? p : null;
  }

  /* DEMO underneath, the sheet over it, the reader's controls on top. Each layer only
     covers what the one below it left, so a sheet that names three fields does not drag
     the other six back to a default. */
  function cfg(port) {
    const base = Object.assign({}, DEMO);
    if (port) {
      if (port.you) Object.keys(port.you).forEach((k) => {
        if (k.charAt(0) !== '_' && port.you[k] != null && !Number.isNaN(port.you[k])) {
          base[k] = port.you[k];
        }
      });
      if (port.sleeves && port.sleeves.length) base.sleeves = port.sleeves;
    }
    return Object.assign(base, LIVE);
  }

  /* ── the controls ──────────────────────────────────────────────────────── */

  function slider(id, label, min, max, step, val, fmt, anchor) {
    const moved = LIVE[id] != null && LIVE[id] !== anchor;
    return '<label style="display:block;margin:0 0 14px">'
      + '<span style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">'
      + '<span>' + esc(label) + (moved ? ' <b style="color:#B17930">· moved</b>' : '') + '</span>'
      + '<b>' + fmt(val) + '</b></span>'
      + '<input type="range" data-rw="' + id + '" min="' + min + '" max="' + max
      + '" step="' + step + '" value="' + val + '" style="width:100%">'
      + (moved ? '<span class="note" style="font-size:11px">your sheet says ' + fmt(anchor) + '</span>' : '')
      + '</label>';
  }

  function panelControls(C) {
    const anyMoved = Object.keys(LIVE).length > 0;
    let h = '<div class="card"><h2>The assumptions</h2>'
      + '<p class="note">Everything here starts from your sheet and can be moved without '
      + 'editing it. A moved control says so, and says what the sheet said, so a what-if is '
      + 'never mistaken for what you actually wrote down. Nothing is saved — reload and '
      + 'you are back to your own numbers.</p>';

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:0 24px;margin-top:14px">';
    h += slider('stopYear', 'Stop work in', DEMO.stopYear - 10, DEMO.stopYear + 12, 1,
      C.stopYear, (v) => String(v), DEMO.stopYear);
    h += slider('spend', 'Annual spend target', Math.round(DEMO.spend * 0.5),
      Math.round(DEMO.spend * 1.5), 5000, C.spend, money, DEMO.spend);
    h += slider('floorSpend', 'Floor: the must-have', Math.round(DEMO.floorSpend * 0.5),
      Math.round(DEMO.floorSpend * 1.5), 5000, C.floorSpend, money, DEMO.floorSpend);
    h += slider('benefitAge', 'Claim the benefit at', 62, 70, 1,
      C.benefitAge, (v) => 'age ' + v, DEMO.benefitAge);
    h += '</div>';

    h += '<div style="margin-top:6px"><div style="font-size:13px;margin-bottom:6px">How the plan spends</div>'
      + '<div class="row">'
      + MODES.map(([k, l]) => '<button data-rwmode="' + k + '"'
          + (C.mode === k || (!C.mode && k === 'guard') ? ' class="on"' : '') + '>' + l + '</button>').join('')
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + esc((MODES.find(([k]) => k === (C.mode || 'guard')) || MODES[1])[2]) + '</p></div>';

    /* HOW THE PORTFOLIO IS MANAGED. Two settings that interact, and the interaction is the
       thing worth knowing: rebalancing restores the mix at the end of every year, which
       erases where the withdrawal came from, so with it on the draw order does nothing at
       all. Presenting them as two independent choices would invite a reader to fiddle with
       one that cannot move. */
    const reb = LIVE.rebalance === undefined ? 'annual' : LIVE.rebalance;
    const ORD = (root.Runway && root.Runway.DRAW_ORDERS) || {};
    const ordKey = LIVE.drawOrder || 'safe-first';

    h += '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--rule)">'
      + '<div style="font-size:13px;margin-bottom:6px">Rebalancing</div>'
      + '<div class="row">'
      + '<button data-rwreb="annual"' + (reb === 'annual' ? ' class="on"' : '') + '>Rebalance every year</button>'
      + '<button data-rwreb="none"' + (reb === 'none' ? ' class="on"' : '') + '>Never rebalance</button>'
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + (reb === 'annual'
          ? 'Each year the mix is restored to the one on your Balances tab. This is what most '
            + 'people actually do, and it stops the growth sleeve quietly taking over until '
            + 'the plan is riskier than the one you described.'
          : '<span class="warn">The mix is left to drift.</span> Growth compounds and the '
            + 'safer sleeves get spent, so a plan that starts balanced can end up almost '
            + 'entirely in equities. It scores better here and it is a stronger claim than it '
            + 'looks.')
      + '</p></div>';

    h += '<div style="margin-top:14px">'
      + '<div style="font-size:13px;margin-bottom:6px">Which sleeve pays first'
      + (reb === 'annual' ? ' <span style="color:var(--muted);font-weight:400">— no effect while rebalancing</span>' : '')
      + '</div>'
      + '<div class="row"' + (reb === 'annual' ? ' style="opacity:.45"' : '') + '>'
      + Object.keys(ORD).map((k) => '<button data-rword="' + k + '"'
          + (ordKey === k ? ' class="on"' : '') + '>' + esc(ORD[k].label) + '</button>').join('')
      + '</div>'
      + '<p class="note" style="margin-top:8px">'
      + (reb === 'annual'
          ? '<b>While you rebalance, this choice does nothing.</b> Restoring the mix at the '
            + 'end of each year erases where the money came from, so all three give the same '
            + 'answer. Turn rebalancing off and they differ by tens of points.'
          : esc((ORD[ordKey] || {}).note || ''))
      + '</p></div>';

    if (anyMoved) {
      h += '<div class="row" style="margin-top:10px"><button data-rwreset="1">Reset to my sheet</button></div>';
    }
    return h + '</div>';
  }

  /* ── the answer ────────────────────────────────────────────────────────── */

  function panelHeadline(r) {
    const kpi = (l, v, note) => '<div style="flex:1;min-width:150px">'
      + '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + l + '</div>'
      + '<div style="font-size:26px;font-weight:700;margin:2px 0">' + v + '</div>'
      + (note ? '<div class="note" style="font-size:11px">' + note + '</div>' : '') + '</div>';

    const mode = (MODES.find(([k]) => k === r.cfg.mode) || MODES[1])[1];
    return '<div class="card"><h2>Will the money last</h2>'
      + '<p class="note">' + r.cfg.paths.toLocaleString('en-US') + ' simulated lifetimes, '
      + 'from age ' + r.stopAge + ' to ' + r.endAge + ', spending under <b>' + esc(mode)
      + '</b>. <b>Never short</b> means the plan met what it asked for in every single year '
      + 'of that lifetime — one thin year is enough to fail it, which is a harder test '
      + 'than it sounds.</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:14px">'
      + kpi('Never short', pct(r.neverShort), 'of ' + r.cfg.paths.toLocaleString('en-US') + ' lifetimes')
      + kpi('Of the full target', pct(r.share), 'typical run')
      + kpi('Worst thin run', r.worstRun + (r.worstRun === 1 ? ' year' : ' years'), 'below 90% of the ask')
      + kpi('Left at the end', money(real(r.terminal.p50, r.cfg.birthYear + r.endAge, r.cfg)),
            'in today money · ' + money(r.terminal.p50) + ' of ' + (r.cfg.birthYear + r.endAge) + ' dollars')
      + '</div>'
      + '<p class="note" style="margin-top:14px"><b>Read the two together.</b> A plan can be '
      + 'never-short simply by asking for little: the income-floor mode does exactly that, '
      + 'and its share of the full target is where the cost shows up. Neither number means '
      + 'much without the other.</p>'
      + (r.hasDeals
          ? '<p class="note"><b class="pos">Your private deals are in these figures.</b> '
            + 'Each lifetime here spends one coherent future of that book — the same '
            + 'model the other tabs run, not an average of it.</p>'
          : '<p class="note"><span class="warn">No private deals are feeding this.</span> '
            + 'The runway is running on the liquid sleeves alone.</p>')
      + '</div>';
  }

  /* ── where each year's money comes from ────────────────────────────────── */

  function compositionChart(r) {
    const rows = r.byYear;
    const W = 860, H = 300, L = 62, B = 30, T = 14, R = 10;
    const keys = ['benefit', 'dated', 'deals'].concat(r.sleeves.map((s) => s.id));
    const COL = { benefit: '#2E6B52', dated: '#1F3864', deals: '#7B5EA7', growth: '#4C7BD9',
                  income: '#B17930', cash: '#6B7A8C', bonds: '#3E8C7A' };
    const colOf = (k) => COL[k] || '#8FA8C8';

    let top = 0;
    rows.forEach((y) => {
      let t = 0; keys.forEach((k) => { t += (y.from[k] || 0); });
      if (t > top) top = t;
      if (y.need > top) top = y.need;
    });
    if (top <= 0) return '';

    const iw = W - L - R, ih = H - T - B;
    const bw = Math.max(2, (iw / rows.length) * 0.74);
    const x = (i) => L + (iw / rows.length) * (i + 0.5);
    const y = (v) => T + ih - (v / top) * ih;

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" '
      + 'role="img" aria-label="Where each year’s money comes from, by sleeve">';
    for (let g = 0; g <= 4; g++) {
      const v = top * g / 4;
      s += '<line x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v)
        + '" stroke="#E4E9F0" stroke-width="1"/>'
        + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" '
        + 'fill="#6B7A8C">' + (v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$0') + '</text>';
    }
    rows.forEach((row, i) => {
      let acc = 0;
      keys.forEach((k) => {
        const v = row.from[k] || 0;
        if (v <= 0) return;
        const y1 = y(acc + v), y0 = y(acc);
        s += '<rect x="' + (x(i) - bw / 2) + '" y="' + y1 + '" width="' + bw
          + '" height="' + Math.max(0, y0 - y1) + '" fill="' + colOf(k) + '"'
          + ' stroke="#fff" stroke-width="0.5"><title>' + row.year + ' · ' + k
          + ' · ' + money(v) + '</title></rect>';
        acc += v;
      });
    });
    /* The ask, as a line over the bars: the gap between them IS the shortfall. */
    let d = '';
    rows.forEach((row, i) => { d += (i ? 'L' : 'M') + x(i) + ' ' + y(row.need); });
    s += '<path d="' + d + '" fill="none" stroke="#141A22" stroke-width="2" '
      + 'stroke-dasharray="5 3"/>';
    rows.forEach((row, i) => {
      if (i % 5 && i !== rows.length - 1) return;
      s += '<text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" '
        + 'fill="#6B7A8C">' + row.year + '</text>';
    });
    return s + '</svg>';
  }

  function panelComposition(r) {
    const key = (k, label) => '<span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px">'
      + '<span style="width:10px;height:10px;border-radius:2px;background:' + k + ';display:inline-block"></span>'
      + '<span style="font-size:12px">' + esc(label) + '</span></span>';
    return '<div class="card"><h2>Where each year’s money comes from</h2>'
      + '<p class="note">One bar per year of the plan, stacked by what paid for it. The '
      + 'dashed line is the full target, so <b>the gap between the bars and the line is the '
      + 'shortfall</b>. This is the panel that shows what the private deals are for: they '
      + 'arrive in lumps, in particular years, and either cover a gap the liquid sleeves '
      + 'could not or they do not.</p>'
      + '<div style="margin:10px 0 4px">'
      + key('#2E6B52', 'Benefit') + key('#1F3864', 'Property, pensions, one-offs')
      + key('#7B5EA7', 'Private deals')
      + key('#4C7BD9', 'Growth') + key('#B17930', 'Income') + key('#6B7A8C', 'Cash')
      + '</div>'
      + compositionChart(r)
      + '<p class="note" style="margin-top:10px">Each bar is the <b>typical</b> amount from '
      + 'that source in that year, so the bars are a picture of a normal run rather than a '
      + 'total you can add across the chart.</p></div>';
  }

  /* WHERE EVERY NUMBER CAME FROM. A page that mixes the reader's own figures with invented
     ones and does not distinguish them is worse than one that invents everything, because
     there is no way to tell which half to trust. */
  function sourceNote(port) {
    if (!port) {
      return '<p class="note"><b>These are ' + esc(DEMO.label) + '.</b> They are real '
        + 'figures, which is what makes the page worth reading before you have typed '
        + 'anything — and they are <b>somebody else’s</b>. Add a '
        + '<b>You</b> tab and a <b>Balances</b> tab to your tracker and the runway runs on '
        + 'yours instead.</p>';
    }
    const bits = [];
    if (port.you) {
      bits.push('the <b>' + esc(port.you._sheet) + '</b> tab supplied '
        + port.you._fields.length + ' of your own figures');
    }
    if (port.balances) {
      const tot = port.sleeves.reduce((a, s) => a + s.balance, 0);
      bits.push('<b>' + esc(port.balances.sheet) + '</b> supplied '
        + port.balances.rows.length + ' holdings worth ' + money(tot)
        + ' across ' + port.sleeves.length + ' sleeve' + (port.sleeves.length === 1 ? '' : 's'));
    }
    let h = '<p class="note"><b class="pos">Running on your sheet.</b> ' + bits.join(', and ')
      + '. Anything your sheet did not say still comes from the author’s own '
      + 'figures, so a blank on your sheet is not a blank on this page.</p>';

    /* A sleeve with no stated return runs on the model's opinion, and that is worth a line
       rather than a footnote nobody reads. */
    const defaulted = (port.sleeves || []).filter((s) => s.mu == null).map((s) => s.label);
    if (defaulted.length) {
      h += '<p class="note">No expected return was given for <b>' + esc(defaulted.join(', '))
        + '</b>, so ' + (defaulted.length === 1 ? 'it uses' : 'they use')
        + ' the model’s own assumption. Put a figure in the <b>Expected return %</b> '
        + 'column to argue with it.</p>';
    }
    const odd = (port.sleeves || []).filter((s) => s.unknownSleeveValue > 0);
    if (odd.length) {
      h += '<p class="note"><span class="warn">Sleeve names not recognised.</span> '
        + money(odd.reduce((a, s) => a + s.unknownSleeveValue, 0)) + ' was filed as Growth '
        + 'because its sleeve did not match Growth, Income, Bonds or Cash.</p>';
    }
    if (port.dealsWithoutAccount > 0) {
      h += '<p class="note">' + port.dealsWithoutAccount + ' of your ' + port.dealCount
        + ' deals carry no <b>Account</b>, so they cannot be tied to the balances beside '
        + 'them. Their proceeds still count.</p>';
    }
    return h;
  }

  /* ── the whole life, as a shape ────────────────────────────────────────── */

  function fanChart(r) {
    const rows = r.curve;
    if (!rows || rows.length < 2) return '';
    const W = 860, H = 320, L = 66, R = 12, T = 16, B = 34;
    const iw = W - L - R, ih = H - T - B;
    let top = 0;
    rows.forEach((c) => { if (c.p90 > top) top = c.p90; });
    if (top <= 0) return '';
    const x = (i) => L + (iw / (rows.length - 1)) * i;
    const y = (v) => T + ih - (v / top) * ih;

    let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" '
      + 'role="img" aria-label="Portfolio value over time, from today to the plan age">';

    for (let g = 0; g <= 4; g++) {
      const v = top * g / 4;
      s += '<line x1="' + L + '" y1="' + y(v) + '" x2="' + (W - R) + '" y2="' + y(v)
        + '" stroke="#E4E9F0" stroke-width="1"/>'
        + '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="10" '
        + 'fill="#6B7A8C">' + (v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M'
            : v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$0') + '</text>';
    }

    /* The band, as one filled path: up the good edge, back down the bad one. */
    let up = '', dn = '';
    rows.forEach((c, i) => { up += (i ? 'L' : 'M') + x(i) + ' ' + y(c.p90); });
    for (let i = rows.length - 1; i >= 0; i--) dn += 'L' + x(i) + ' ' + y(rows[i].p10);
    s += '<path d="' + up + dn + 'Z" fill="#4C7BD9" fill-opacity="0.16"/>';

    let mid = '';
    rows.forEach((c, i) => { mid += (i ? 'L' : 'M') + x(i) + ' ' + y(c.p50); });
    s += '<path d="' + mid + '" fill="none" stroke="#1F3864" stroke-width="2"/>';

    /* WHERE EARNING STOPS AND DRAWING BEGINS. The single most important line on the chart,
       and the one a reader looks for first. */
    const si = rows.findIndex((c) => c.phase === 'drawing');
    if (si > 0) {
      s += '<line x1="' + x(si) + '" y1="' + T + '" x2="' + x(si) + '" y2="' + (T + ih)
        + '" stroke="#A33A1F" stroke-width="1.5" stroke-dasharray="4 3"/>'
        + '<text x="' + (x(si) + 5) + '" y="' + (T + 11) + '" font-size="10" fill="#A33A1F">'
        + 'stop work · ' + rows[si].year + '</text>';
    }

    rows.forEach((c, i) => {
      if (i % 6 && i !== rows.length - 1) return;
      s += '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="middle" font-size="10" '
        + 'fill="#6B7A8C">' + c.year + '</text>';
    });
    return s + '</svg>';
  }

  function panelCurve(r) {
    const rows = r.curve;
    const peak = rows.reduce((a, c) => (c.p50 > a.p50 ? c : a), rows[0]);
    const atStop = rows.find((c) => c.phase === 'drawing') || rows[rows.length - 1];
    const last = rows[rows.length - 1];
    const bust = rows.filter((c) => c.phase === 'drawing' && c.p10 <= 0)[0];

    return '<div class="card"><h2>Your money over time</h2>'
      + '<p class="note">Every year from today to age ' + r.cfg.planToAge + ', across '
      + r.cfg.paths.toLocaleString('en-US') + ' simulated lifetimes. The band runs from a bad '
      + 'run (10th percentile) to a good one (90th), with the typical run through it. The '
      + 'dashed line is the year you stop working — <b>everything left of it is saving, '
      + 'everything right of it is drawing</b>.</p>'
      + fanChart(r)
      + '<p class="note" style="margin-top:10px">Typically <b>' + money(atStop.p50)
      + '</b> at the stop year'
      /* Only worth saying when the peak is not simply the last year, which it often is on
         a plan whose growth outruns its drawing. "Peaking in the final year" is not a
         peak, it is a trend, and printing it as one reads like a finding. */
      + (peak.year < last.year - 1
          ? ', peaking around <b>' + money(peak.p50) + '</b> in ' + peak.year
          : ', and rising throughout')
      + ', ending with <b>' + money(last.p50) + '</b>. '
      + (bust
          ? '<span class="warn">In a bad run the money is gone by ' + bust.year
            + '</span>, which is the failure the headline probability counts.'
          : '<b class="pos">Even the bad run never reaches zero</b> inside the calendar.')
      + '</p>'
      + '<p class="note"><b>These are the dollars of each year, not today money.</b> '
      + money(last.p50) + ' in ' + last.year + ' is about <b>'
      + money(real(last.p50, last.year, r.cfg)) + '</b> in what you can buy now, at '
      + pct(r.cfg.inflPost || 0.03) + ' inflation. The chart has to run in future dollars '
      + 'because the spending it pays for does too; the headline above is converted back.</p>'
      + '</div>';
  }

  /* ── when can you stop? ─────────────────────────────────────────────────── */

  function panelWhen(r, ctx, C, port, sim) {
    /* The question a simulator exists to answer, and the one a single probability cannot:
       not "will this work" but "how much does waiting buy me". APEX sweeps retirement ages
       in a table for the same reason. */
    const years = [];
    for (let d = -4; d <= 6; d += 2) years.push(C.stopYear + d);
    const rows = years.map((sy) => {
      const rr = root.Runway.simulate(Object.assign({}, C, {
        stopYear: sy, dealSim: sim, dated: port ? port.dated : null, paths: 500,
      }));
      return rr ? { year: sy, age: sy - C.birthYear, r: rr } : null;
    }).filter(Boolean);
    if (rows.length < 2) return '';

    const body = rows.map((o) => {
      const on = o.year === C.stopYear;
      return '<tr' + (on ? ' class="hi"' : '') + '>'
        + '<td class="l b">' + o.year + '</td>'
        + '<td>' + o.age + '</td>'
        + '<td class="b">' + pct(o.r.neverShort) + '</td>'
        + '<td>' + pct(o.r.share) + '</td>'
        + '<td>' + (o.r.breaks ? 'age ' + o.r.breaks.ageP50 : '—') + '</td>'
        + '<td>' + money(real(o.r.terminal.p50, C.birthYear + C.planToAge, C)) + '</td></tr>';
    }).join('');

    return '<div class="card"><h2>When can you stop?</h2>'
      + '<p class="note">The same plan, run again for each stop year. <b>Waiting is the one '
      + 'lever that works on both sides at once</b> — another year of saving and one '
      + 'fewer of drawing — which is why it usually moves the number more than anything '
      + 'except spending less. Your current year is highlighted.</p>'
      + '<table style="margin-top:10px"><tr>'
      + '<th class="l">Stop in</th><th>Age</th><th>Never short</th>'
      + '<th>Of full target</th><th>Typically breaks</th><th>Left, in today money</th></tr>'
      + body + '</table>'
      + '<p class="note" style="margin-top:10px">500 lifetimes per row, fewer than the '
      + 'headline, so read the direction rather than the last point of each figure.</p></div>';
  }

  /* ── what breaks first, and what moves it ──────────────────────────────── */

  function panelBreaks(r) {
    if (!r.breaks) {
      return '<div class="card"><h2>What breaks first</h2>'
        + '<p class="note"><b class="pos">Nothing broke.</b> Every one of the '
        + r.cfg.paths.toLocaleString('en-US') + ' lifetimes met what the plan asked for in '
        + 'every year. That is a statement about these assumptions, not a guarantee — '
        + 'move the spend target up, or the returns down, and this panel will have '
        + 'something to say.</p></div>';
    }
    const b = r.breaks;
    const firstDry = b.empty[0];
    const stat = (l, v, n) => '<div style="flex:1;min-width:140px">'
      + '<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)">' + l + '</div>'
      + '<div style="font-size:24px;font-weight:700;margin:2px 0">' + v + '</div>'
      + (n ? '<div class="note" style="font-size:11px">' + n + '</div>' : '') + '</div>';

    let h = '<div class="card"><h2>What breaks first</h2>'
      + '<p class="note">Of ' + r.cfg.paths.toLocaleString('en-US') + ' lifetimes, <b>'
      + pct(b.share) + ' fell short at some point</b>. These figures describe those runs '
      + 'only — averaging in the ones that went fine would drag every number toward '
      + '"nothing went wrong", which is the run you need no help with.</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:20px;margin-top:14px">'
      + stat('Typically breaks at', 'age ' + b.ageP50, 'age ' + b.ageP10 + ' in the earliest tenth')
      + stat('First gap', money(b.gapP50), 'what was missing that year')
      + (b.dryAgeP50 != null && firstDry
          ? stat('First sleeve empty', firstDry.what, 'typically at age ' + b.dryAgeP50)
          : '')
      + '</div>';

    if (b.dryAgeP50 != null && firstDry && b.dryAgeP50 < b.ageP50) {
      h += '<p class="note" style="margin-top:14px"><b>You get ' + (b.ageP50 - b.dryAgeP50)
        + ' years of warning.</b> ' + esc(firstDry.what) + ' typically empties at '
        + b.dryAgeP50 + ' and the money does not actually run out until ' + b.ageP50
        + '. A sleeve hitting zero is the early signal; by the time a year goes unpaid the '
        + 'decision that would have helped is long behind you.</p>';
    }
    return h + '</div>';
  }

  function panelLevers(lv) {
    if (!lv || !lv.levers.length) return '';
    const rows = lv.levers.map((l) => {
      const d = l.delta * 100;
      const up = d >= 0;
      const w = Math.min(100, Math.abs(d) * 2.2);
      return '<tr>'
        + '<td class="l" style="padding:7px 12px 7px 0"><b>' + esc(l.label) + '</b>'
        + (l.note ? '<div class="note" style="font-size:11px;margin-top:1px">' + esc(l.note) + '</div>' : '')
        + '</td>'
        + '<td style="padding:7px 0;width:190px">'
        + '<div style="display:flex;align-items:center;gap:8px">'
        + '<div style="flex:1;height:8px;background:#EDF1F6;border-radius:4px;overflow:hidden">'
        + '<div style="width:' + w + '%;height:100%;background:' + (up ? '#2E6B52' : '#A33A1F') + '"></div>'
        + '</div>'
        + '<b style="width:58px;text-align:right;color:' + (up ? '#2E6B52' : '#A33A1F') + '">'
        + (up ? '+' : '') + d.toFixed(0) + ' pts</b></div></td>'
        + '<td style="padding:7px 0 7px 14px;text-align:right;width:70px">' + pct(l.neverShort) + '</td>'
        + '</tr>';
    }).join('');

    return '<div class="card"><h2>What moves it most</h2>'
      + '<p class="note">Each row is <b>the same plan re-run with one thing changed</b>, on '
      + 'the same seed, so the difference is the change and not a different random world. '
      + 'This is measured rather than attributed: a model with this many moving parts can '
      + 'always be told a plausible story about why it failed, and a re-run cannot.</p>'
      + '<table style="margin-top:10px"><tr><th class="l">Change</th>'
      + '<th class="l">Effect on never short</th><th style="text-align:right">Then</th></tr>'
      + rows + '</table>'
      + '<p class="note" style="margin-top:12px"><b>These are not recommendations.</b> The '
      + 'tool has no view on whether you should work two more years; it can only say what '
      + 'two more years did to the number. Run on ' + lv.paths.toLocaleString('en-US')
      + ' lifetimes per row, fewer than the headline above, so a row within a point or two '
      + 'of zero is noise rather than a finding.</p></div>';
  }

  /* ── how it works, and what it assumes ─────────────────────────────────── */

  /* EVERY NUMBER HERE IS READ FROM THE MODEL, not typed into the prose. A methodology note
     that is maintained by hand drifts away from the code it describes, and then it is worse
     than nothing: it is a confident description of a model that no longer exists. The same
     discipline the deal tabs use for their outcome odds. */
  function panelMethod(r, C) {
    const K = root.Runway.SLEEVE_KINDS || {};
    /* The order ACTUALLY IN FORCE, not the default. Printing the default while the reader
       has chosen another would be a methodology note describing somebody else's run. */
    const ORDS = root.Runway.DRAW_ORDERS || {};
    const chosen = ORDS[r.drawOrder] || ORDS['safe-first'] || {};
    const order = chosen.order || root.Runway.DRAW_ORDER || [];
    const used = {};
    (r.sleeves || []).forEach((s) => { used[s.kind] = true; });

    const step = (nn, t, d) => '<div class="glos"><div class="t">' + nn + '. ' + t
      + '</div><div class="d">' + d + '</div></div>';

    const kindRows = order.filter((k) => K[k]).map((k) => {
      const on = used[k];
      return '<tr' + (on ? '' : ' style="opacity:.5"') + '>'
        + '<td class="l b">' + k.charAt(0).toUpperCase() + k.slice(1) + '</td>'
        + '<td>' + (K[k].mu * 100).toFixed(1) + '%</td>'
        + '<td>' + (K[k].sd * 100).toFixed(1) + '%</td>'
        + '<td>' + (K[k].yield * 100).toFixed(1) + '%</td>'
        + '<td class="l">' + (on ? 'in your plan' : 'not used') + '</td></tr>';
    }).join('');

    return '<div class="card" id="fpos-method"><h2>How this works, and what it assumes</h2>'
      + '<p class="note">Every figure below is read out of the model as it runs, not typed '
      + 'into this text. A methodology note kept by hand drifts away from the code it '
      + 'describes, and then it is worse than nothing — a confident description of a '
      + 'model that no longer exists.</p>'

      + '<h3 style="margin-top:18px">What it does</h3>'
      + '<p class="note">It runs one life ' + r.cfg.paths.toLocaleString('en-US')
      + ' times and counts how often the money lasted. Each run has two phases. '
      + '<b>Saving</b>, from today to ' + r.stopYear + ': nothing is drawn, everything '
      + 'compounds. <b>Drawing</b>, from ' + r.stopYear + ' to age ' + r.cfg.planToAge
      + ': each year it works out what the plan needs and pays it in a fixed order.</p>'
      + '<p class="note">The seed is fixed, so the same inputs always give the same answer. '
      + 'If a number moves, something moved it.</p>'

      + '<h3 style="margin-top:18px">How one year gets paid</h3>'
      + '<p class="note">In this order, stopping as soon as the year is covered.</p>'
      + step(1, 'The benefit', 'Social Security or a pension. It arrives whatever the '
          + 'markets did, which is why it goes first.')
      + step(2, 'Dated money', 'A property sale, a pension, an inheritance. A '
          + '<b>negative</b> entry — a new roof, a tuition bill — instead RAISES '
          + 'what the year needs.')
      + step(3, 'Private deal proceeds landing that year', '<b>Only what actually pays out '
          + 'in that year.</b> Money still locked in a deal cannot fund anything: a deal is '
          + 'never treated as a balance you can draw on, only as cash on the date it '
          + 'arrives. Someone holding a million in deals that have not exited is short that '
          + 'year, and this model says so.')
      + step(4, 'Sleeve income', 'The yield from <b>every</b> sleeve is spent before '
          + '<b>any</b> principal is touched anywhere. Selling a position to fund a year you '
          + 'could have covered from income is the one avoidable way a plan shortens its '
          + 'own life.')
      + step(5, 'Growth', 'Each sleeve is then moved by its own return draw for that year, '
          + 'good or bad.')
      + step(6, 'Sleeve principal', 'Only if the year is still not covered. '
          + (r.rebalancing
              ? 'You are rebalancing every year, so <b>which sleeve pays makes no difference</b>: '
                + 'the mix is restored afterwards either way.'
              : 'In the order <b>' + order.join(' → ') + '</b>, and with no rebalancing '
                + 'that choice is worth tens of points.'))
      + '<p class="note">Anything still unmet after all six is a <b>short year</b>, and one '
          + 'short year is enough to fail a lifetime on the headline figure.</p>'

      + '<h3 style="margin-top:18px">What the model invents</h3>'
      + '<p class="note">None of this comes from you. It is the model’s opinion and all '
      + 'of it is arguable — put a figure in the <b>Expected return %</b> or '
      + '<b>Yield %</b> column of your Balances tab and yours is used instead.</p>'
      + '<table style="margin-top:8px"><tr><th class="l">Sleeve</th><th>Return</th>'
      + '<th>Volatility</th><th>Yield</th><th class="l">&nbsp;</th></tr>'
      + kindRows + '</table>'
      + '<table style="margin-top:14px"><tr><th class="l">Assumption</th><th class="l">Value</th></tr>'
      + '<tr><td class="l">Inflation before you stop</td><td class="l">' + pct(C.inflPre || 0.035) + '</td></tr>'
      + '<tr><td class="l">Inflation after</td><td class="l">' + pct(C.inflPost || 0.03) + '</td></tr>'
      + '<tr><td class="l">Guardrail bands</td><td class="l">'
        + (C.guard || []).map((g) => g[0] + '× cover → ' + pct(g[1])).join(' · ')
        + '</td></tr>'
      + '<tr><td class="l">Worst single year a sleeve can have</td><td class="l">−75%</td></tr>'
      + '<tr><td class="l">Volatility of the yield itself</td><td class="l">a quarter of price volatility</td></tr>'
      + '<tr><td class="l">Simulated lifetimes</td><td class="l">'
        + r.cfg.paths.toLocaleString('en-US') + ' here · 700 per lever · 500 per stop-year row</td></tr>'
      + '</table>'

      + '<h3 style="margin-top:18px">What it cannot tell you</h3>'
      + '<p class="note"><b>Anything about tax.</b> Withdrawals are treated as spendable in '
      + 'full, so a plan leaning on a large pre-tax balance reads better here than it will in '
      + 'life. This is the biggest single distortion in the model.</p>'
      + '<p class="note"><b>What happens when you move money between sleeves.</b> Each sleeve '
      + 'grows and drains on its own — nothing is rebalanced. Cash can empty while growth '
      + 'compounds untouched beside it, which a real person would not allow, so the '
      + '“first sleeve empty” warning fires earlier than it should.</p>'
      + '<p class="note"><b>What happens when everything goes wrong at once.</b> Each sleeve '
      + 'is drawn independently, so a bad year for shares is not a bad year for credit. In a '
      + 'real downturn they move together, which flatters every downside figure here.</p>'
      + '<p class="note"><b>Whether any of this is a good idea.</b> It takes your plan as '
      + 'given and says whether the money lasts. It has no view on the plan.</p>'
      + '</div>';
  }

  /* ── render ────────────────────────────────────────────────────────────── */

  function render(host, ctx) {
    const port = fromSheet(ctx);
    const C = cfg(port);
    /* Same trap as runway.js: `window.Engine` is undefined because engine.js uses
       const at script scope. Reading it that way silently produced a runway with no deals
       in it, which is the one thing this tab exists to include. */
    const E = (typeof Engine !== 'undefined' && Engine) ? Engine : (root.Engine || null);
    let sim = null;
    if (ctx && ctx.book && ctx.book.length && E) {
      sim = E.simulate(ctx.book, { paths: 400, capturePaths: true });
    }
    const runCfg = Object.assign({}, C, { dealSim: sim, dated: port ? port.dated : null });
    const r = root.Runway.simulate(Object.assign({}, runCfg, { paths: 1200 }));
    /* The levers re-run the whole model once per row, so they get fewer paths. Six runs at
       1,200 would be six times the wait for a panel whose job is a rough ranking. */
    const lv = r ? root.Runway.levers(runCfg, { paths: 700 }) : null;

    if (!r) {
      host.innerHTML = '<div class="card"><h2>Retirement Simulator</h2>'
        + '<p class="note">This needs at least one sleeve with a balance, and a stop year '
        + 'before the plan age.</p></div>';
      return;
    }

    host.innerHTML =
      '<div class="card"><h2>Retirement Simulator</h2>'
      + '<p class="note">How long the money lasts, and what it leans on to get there.</p>'
      + sourceNote(port)
      + '<p class="note"><b>It does not model tax</b>, and each stress is drawn '
      + 'independently. Both flatter the result. <a href="#fpos-method">How this works and '
      + 'what it assumes</a> is at the foot of this tab.</p></div>'
      + panelControls(C)
      + panelHeadline(r)
      + panelCurve(r)
      + panelWhen(r, ctx, C, port, sim)
      + panelBreaks(r)
      + panelLevers(lv)
      + panelComposition(r)
      + panelMethod(r, C);

    host.querySelectorAll('[data-rw]').forEach((el) => {
      el.oninput = () => {
        LIVE[el.getAttribute('data-rw')] = Number(el.value);
        render(host, ctx);
      };
    });
    host.querySelectorAll('[data-rwmode]').forEach((el) => {
      el.onclick = () => { LIVE.mode = el.getAttribute('data-rwmode'); render(host, ctx); };
    });
    host.querySelectorAll('[data-rwreb]').forEach((el) => {
      el.onclick = () => { LIVE.rebalance = el.getAttribute('data-rwreb'); render(host, ctx); };
    });
    host.querySelectorAll('[data-rword]').forEach((el) => {
      el.onclick = () => { LIVE.drawOrder = el.getAttribute('data-rword'); render(host, ctx); };
    });
    const rst = host.querySelector('[data-rwreset]');
    if (rst) rst.onclick = () => { Object.keys(LIVE).forEach((k) => delete LIVE[k]); render(host, ctx); };
  }

  root.APP_PLUGINS = (root.APP_PLUGINS || []).concat([{
    id: 'runway',
    label: 'Retirement Simulator',
    after: 'outlook',
    render,
  }]);
}(window));
