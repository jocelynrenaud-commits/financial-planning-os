/* LIQUIDITY RUNWAY — a generic decumulation model.
 *
 * Ported from APEX's retSimulate, which answers the same question against one person's
 * three named accounts. This one takes N sleeves and knows nothing about whose they are.
 *
 * WHAT IT DOES. Runs a lifetime a few thousand times. Each year it works out what the plan
 * needs, pays it from the sleeves in order, and records whether the money arrived. The
 * outputs are the odds it never falls short, how much of the target a typical run delivers,
 * and where each year's money came from.
 *
 * WHAT MAKES IT DIFFERENT FROM A RETIREMENT CALCULATOR. Illiquid positions do not pay on a
 * schedule you choose. A deal exits in a year, or it does not, and the whole point is
 * whether the liquid sleeves can carry the gap until it does. So the private book is not a
 * balance earning a return -- it is a stream of dated, uncertain arrivals, drawn from the
 * same model the Private Deals tabs use.
 *
 * ONE COHERENT FUTURE AT A TIME. Path 7 of the runway spends path 7 of the deal book: the
 * lifetime where those deals went that particular way. Feeding it per-year medians would
 * commit the error the cash-flow panel warns about in bold, because the middle future in
 * one year is a different future from the middle in the next.
 */
(function (root) {
  'use strict';

  /* Sleeve archetypes. A reader who fills in nothing gets these; a reader who fills in
     `Expected return %` on their own sheet overrides them. Deliberately unexciting: this
     is the model's opinion, and an opinion should be arguable rather than flattering. */
  const SLEEVE_KINDS = {
    growth:  { mu: 0.08, sd: 0.16, yield: 0.00, spendYieldFirst: false },
    income:  { mu: 0.02, sd: 0.05, yield: 0.06, spendYieldFirst: true },
    bonds: { mu: 0.03, sd: 0.06, yield: 0.03, spendYieldFirst: true },
    cash:    { mu: 0.00, sd: 0.002, yield: 0.04, spendYieldFirst: true },
  };

  /* The order money is taken in, and it is a real decision rather than an arrangement.
     Yield is spent before any principal, because selling a position to fund a year you
     could have covered from income is the one avoidable way a plan shortens its own life.
     Cash goes before growth so a bad year is not crystallised. Growth is last. */
  const DRAW_ORDER = ['cash', 'bonds', 'income', 'growth'];

  /* WHICH SLEEVE PAYS FIRST, and it is a real decision rather than an arrangement. Each of
     these did measurably differently in history and each costs something. */
  const DRAW_ORDERS = {
    'safe-first': {
      order: ['cash', 'bonds', 'income', 'growth'],
      label: 'Spend the safe money first',
      note: 'Let growth compound untouched. Best historical outcomes, and it leaves you '
          + 'holding almost nothing but equities late in life.',
    },
    'proportional': {
      order: null,                       /* pro rata across everything */
      label: 'Take a little from everything',
      note: 'What a rebalanced portfolio does naturally, and what the Trinity study '
          + 'measures. The middle answer on almost every count.',
    },
    'growth-first': {
      order: ['growth', 'income', 'bonds', 'cash'],
      label: 'Spend the risky money first',
      note: 'De-risks as you go, so the plan gets safer with age. Worst on average, and the '
          + 'gentlest ending.',
    },
  };

  const DEFAULTS = {
    birthYear: 1975,
    stopYear: 2040,
    planToAge: 92,
    spend: 180000,          // annual, today's money
    floorSpend: 120000,     // the must-have
    inflPre: 0.035,         // until the stop year
    inflPost: 0.03,         // after it
    benefitAge: 67,
    benefitAnnual: 40000,   // today's money
    mode: 'guard',          // 'fixed' | 'floor' | 'guard'
    guard: [[12, 1.00], [9, 0.90], [0, 0.80]],
    paths: 2000,
    seed: 20260929,
    sleeves: [],
    /* SIMPLE TAX, federal only, as effective rates rather than brackets. Deliberately not a
       tax engine: no brackets, no state, no RMDs, no conversion optimiser, and no basis
       tracking on the taxable sleeve. Set tax.on to false to see the old pre-tax figures. */
    tax: { on: true, preTax: 0.22, taxable: 0.15, roth: 0 },
  };

  /* engine.js declares `const Engine = {...}` at top-level script scope, and const does
     NOT create a window property -- it lives in the global lexical scope. So `Engine` works
     and `window.Engine` is undefined, which is how the runway came to render an empty state
     claiming the profile had no sleeves. The bare identifier first, the global as a fallback
     for node. `typeof` on an undeclared name is safe; a bare read of one throws. */
  function historyRef() {
    if (typeof History !== 'undefined' && History) return History;
    if (root && root.History) return root.History;
    return null;
  }

  function engineRef() {
    if (typeof Engine !== 'undefined' && Engine) return Engine;
    if (root && root.Engine) return root.Engine;
    return null;
  }

  function gauss(rnd, mu, sd) {
    /* Box-Muller. The same shape APEX uses, so a figure can be compared across the two. */
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function q(sorted, p) { return sorted[Math.floor(p * (sorted.length - 1))]; }
  function sortNum(a) { return a.slice().sort((x, y) => x - y); }

  /* Fill in whatever the sheet did not say, per sleeve. */
  function normSleeves(list, drawOrder) {
    const strat = DRAW_ORDERS[drawOrder] || DRAW_ORDERS['safe-first'];
    const ord = strat.order || DRAW_ORDER;
    return (list || []).filter((s) => s && Number(s.balance) > 0).map((s, i) => {
      const k = SLEEVE_KINDS[s.kind] || SLEEVE_KINDS.growth;
      return {
        id: s.id || ('sleeve' + i),
        label: s.label || s.id || ('Sleeve ' + (i + 1)),
        kind: SLEEVE_KINDS[s.kind] ? s.kind : 'growth',
        account: s.account || '',
        balance: Number(s.balance) || 0,
        mu: s.mu != null ? Number(s.mu) : k.mu,
        sd: s.sd != null ? Number(s.sd) : k.sd,
        yield: s.yield != null ? Number(s.yield) : k.yield,
        spendYieldFirst: k.spendYieldFirst,
        /* CARRIED THROUGH, or the tax rate silently falls back to the pre-tax default
           for every sleeve. normSleeves rebuilds each object field by field, so a
           field it does not name is dropped -- and a dropped tax mix does not throw,
           it just taxes a Roth account at 22% and reports a plausible number. Caught
           by checking that an all-Roth book and an all-pre-tax book gave DIFFERENT
           answers; they did not. */
        taxMix: s.taxMix || null,
      };
    }).sort((a, b) => ord.indexOf(a.kind) - ord.indexOf(b.kind));
  }

  /* The private book, as dated arrivals per path rather than a balance.
     `sim` is an Engine.simulate result taken with capturePaths:true. */
  function dealArrivals(sim) {
    if (!sim || !sim.pathRows || !sim.pathRows.length) return null;
    return { years: sim.years, rows: sim.pathRows };
  }

  function simulate(cfg) {
    const C = Object.assign({}, DEFAULTS, cfg || {});
    const sleeves = normSleeves(C.sleeves, C.drawOrder);
    const proportional = (DRAW_ORDERS[C.drawOrder] || {}).order === null;

    /* TARGET WEIGHTS for rebalancing, taken from the balances as typed. Rebalancing to
       today's mix is the only target the sheet actually states; a glidepath that shifts the
       mix with age is a different feature and would need its own column. */
    const total0 = sleeves.reduce((a, sv) => a + sv.balance, 0);
    const target = sleeves.map((sv) => (total0 > 0 ? sv.balance / total0 : 0));
    const rebalancing = (C.rebalance === undefined ? 'annual' : C.rebalance) === 'annual';
    const arr = dealArrivals(C.dealSim);

    /* THE EFFECTIVE RATE ON A WITHDRAWAL FROM EACH SLEEVE, blended from the accounts behind
       it, so a Growth sleeve that is 70% 401k and 30% brokerage is taxed as what it is. A
       sleeve with no stated mix is assumed PRE-TAX, because that is where most retirement
       money actually sits and assuming tax-free would flatter the plan. */
    const TAX = Object.assign({ on: true, preTax: 0.22, taxable: 0.15, roth: 0 }, C.tax || {});
    const taxRate = sleeves.map((sv) => {
      if (!TAX.on) return 0;
      const m = sv.taxMix || { preTax: 1, roth: 0, taxable: 0 };
      const r = (m.preTax || 0) * TAX.preTax + (m.taxable || 0) * TAX.taxable
        + (m.roth || 0) * TAX.roth;
      return Math.min(0.9, Math.max(0, r));     // a rate at 1 or above could never fund a year
    });
    /* GROSSED UP, NOT HAIRCUT, and the difference is the whole point. Funding $100,000 of
       spending from a 22% sleeve costs $128,205 of balance, because the tax comes out of the
       withdrawal and the spending has to survive it. Haircutting the balance instead would
       understate the damage. */
    const grossFor = (net, i) => net / (1 - taxRate[i]);
    const netOf = (gross, i) => gross * (1 - taxRate[i]);

    const stopAge = C.stopYear - C.birthYear;
    const endAge = C.planToAge;
    const nYears = endAge - stopAge + 1;
    /* 130 matches diagnose()'s cut-off: a four-digit plan age is a calendar year in an age
       box, and running it produces a two-thousand-year retirement that looks normal until you
       read the axis. Refusing here is what makes the panel show diagnose()'s message. */
    if (nYears < 1 || !sleeves.length || C.planToAge > 130) return null;

    const E = engineRef();
    const rnd = E ? E.makeRng(C.seed) : null;
    if (!rnd) return null;

    /* HOW RETURNS ARE DRAWN. 'historical' walks consecutive blocks of real years;
       'normal' draws each year independently from a normal distribution, which is what
       this model used to do exclusively and what made it optimistic under stress. */
    const H = historyRef();
    const HIST = (C.sampling === 'historical' || C.sampling === 'sequence') && H;
    /* In sequence mode the path count is not a choice: there are as many runs as history
       provides, and asking for more would just repeat them. */
    const SEQS = (C.sampling === 'sequence' && H)
      ? H.sequences((C.birthYear + C.planToAge) - (C.thisYear || new Date().getFullYear()) + 2)
      : null;

    /* One draw for one sleeve in one year, returned split into the part that is spendable
       income and the part that is a price move.

       History reports a TOTAL return, and this model spends yield separately from
       principal, so the sleeve's own yield is taken OUT of the total rather than added to
       it. Adding it would pay the yield twice. When the total is less than the yield --
       a bond fund down 17% still pays its coupon -- the price move simply goes negative,
       which is what actually happens. */
    function draw(s, hist, yi) {
      if (!HIST || !hist) {
        return {
          yield: Math.max(0, gauss(rnd, s.yield, s.sd * 0.25)),
          price: Math.max(-0.75, gauss(rnd, s.mu, s.sd)),
        };
      }
      const idx = hist[Math.max(0, Math.min(hist.length - 1, yi))];
      const series = H.SERIES[s.kind] || H.SERIES.growth;
      const total = series[idx];
      const y = Math.max(0, s.yield);
      return { yield: y, price: Math.max(-0.95, total - y) };
    }

    /* Inflation for one year: the sampled year's CPI, or the configured constant. */
    function inflAt(hist, yi, drawing) {
      if (HIST && hist) {
        const idx = hist[Math.max(0, Math.min(hist.length - 1, yi))];
        return H.cpi[idx];
      }
      return drawing ? (C.inflPost || 0.03) : (C.inflPre || 0.035);
    }

    /* The anatomy of the failures. Collected only for paths that DID fall short: mixing
       in the runs that went fine would pull every figure toward "nothing went wrong",
       which is the run a reader needs no help with. */
    const breakYear = [], breakGap = [], breakEmpty = {}, dryAges = [];
    /* One life, recorded step by step, when asked. Percentiles describe a population and
       hide the mechanism; some claims can only be checked by watching a single run. */
    const trace = C.trace ? [] : null;
    /* WHICH path gets recorded. Path 0 is an arbitrary future and could be a disaster,
       which is a poor thing to print as a year-by-year plan. medianTrace() below finds
       the median-ending path and asks for that one. */
    const traceAt = Math.max(0, Math.round(Number(C.traceAt) || 0));
    const okRuns = [];           // did this lifetime ever fall short
    const shares = [];           // share of target delivered
    const fulls = [];            // share of years paid in full
    const worsts = [];           // longest run of thin years
    const terms = [];            // what is left at the end
    let neverShort = 0;

    /* Per-year capture: who paid, and what was left. Arrays of per-path values, ranked
       once at the end. */
    const paidBy = {};
    sleeves.forEach((s) => { paidBy[s.id] = []; });
    paidBy.benefit = [];
    paidBy.dated = [];
    paidBy.deals = [];
    const wealth = [], needAt = [];

    /* The whole life, not just the drawing half. Indexed by calendar year from today to
       the plan age, so the accumulation run-up and the decumulation share one axis. */
    const curveFrom = C.thisYear || new Date().getFullYear();
    const curveTo = C.birthYear + C.planToAge;
    const curve = [];
    for (let y = curveFrom; y <= curveTo; y++) curve.push([]);
    for (let y = 0; y < nYears; y++) {
      sleeves.forEach((s) => { paidBy[s.id].push([]); });
      paidBy.benefit.push([]);
      paidBy.dated.push([]);
      paidBy.deals.push([]);
      wealth.push([]);
      needAt.push(0);
    }

    /* THE TARGET, INFLATED. This used to be precomputed as a constant compounded to the
       stop year. It is now accumulated per path, because historical sampling has to inflate
       by the CPI of the year it actually sampled -- the 1970s did their damage by pairing
       poor real returns with 11-13% inflation, and a constant cannot express that. Normal
       mode compounds its constant through the same machinery and is unchanged. */
    const thisYear = C.thisYear || new Date().getFullYear();
    const yearsToStop = Math.max(0, C.stopYear - thisYear);
    const baseSpend = C.spend;
    const baseFloor = C.floorSpend;
    const baseBenefit = C.benefitAnnual;

    function guardMult(coverage) {
      for (let i = 0; i < C.guard.length; i++) {
        if (coverage >= C.guard[i][0]) return C.guard[i][1];
      }
      return C.guard[C.guard.length - 1][1];
    }

    const nPaths = SEQS ? SEQS.length : C.paths;
    for (let p = 0; p < nPaths; p++) {
      const bal = sleeves.map((s) => s.balance);
      /* Compounded from today, through the saving years and on into the drawing ones. */
      let inflF = 1;
      let short = false, got = 0, want = 0, nFull = 0, run = 0, worst = 0;
      let firstShortAge = null, firstShortGap = 0, firstShortEmpty = '';
      let firstDry = null, firstDryAge = null;

      /* This lifetime's deal arrivals, by calendar year. Path p of the runway spends
         path p of the book, so the two describe one future rather than two. */
      /* THIS PATH'S WALK THROUGH HISTORY. One index per calendar year of the whole life,
         drawn in consecutive blocks so the runs survive. Null in normal mode. */
      let hist = null;
      if (HIST && H) {
        const span = (curveTo - curveFrom) + 2;
        if (C.sampling === 'sequence' && SEQS) {
          /* EVERY ACTUAL HISTORICAL RUN, each counted once. This is the Trinity study's own
             method: not a distribution but the real consecutive windows, so 1929 onward and
             1966 onward are each lived through intact. Block bootstrap re-stitches, and
             re-stitching averages away precisely the sequences that end retirements. */
          hist = SEQS[p % SEQS.length];
        } else {
          hist = H.blockPath(rnd, span, C.blockYears || 10);
        }
      }

      const mine = {};
      const early = {};
      if (arr) {
        const row = arr.rows[p % arr.rows.length];
        arr.years.forEach((yy, i) => {
          /* Proceeds landing BEFORE the stop year still exist. The book pays across years
             that mostly precede the plan date, so reading only the overlap threw away
             almost all of it -- the tell was terminal wealth identical to the dollar with
             and without a book. Banked and handed over at the stop year WITHOUT compounding
             in between, which is the conservative reading and what APEX does. */
          /* Kept by YEAR rather than lumped, so a proceed landing in 2030 compounds from
             2030 and not from today. Lumping them up front handed the run-up a decade of
             growth on money that had not arrived yet.

             Anything that landed BEFORE today is dropped: that cash is already sitting in
             the balances the reader typed, and adding it again would count it twice. */
          if (yy < thisYear) return;
          if (yy < C.birthYear + stopAge) early[yy] = row[i];
          else mine[yy] = row[i];
        });
      }

      /* THE YEARS BEFORE THE PLAN STARTS, which the model used to skip entirely.
       *
       * It began at the stop year holding TODAY'S balances, while inflating the spending
       * target all the way to that year -- so it compared tomorrow's costs against today's
       * money. On a fourteen-year run-up that is not a rounding error, it is most of the
       * portfolio, and it made every plan look far worse than it is. It also made "work
       * two more years" nearly worthless on the levers panel, because the extra years
       * could not do the one thing they are actually for.
       *
       * Same draws, same order, same sleeves as the decumulation loop below. Contributions
       * from the Cashflows tab land here too: a year of saving before the stop date is the
       * most ordinary thing in a plan and was silently discarded.
       */
      for (let y = thisYear; y < C.birthYear + stopAge; y++) {
        const contrib = (C.dated && C.dated[y]) ? C.dated[y].net : 0;
        if (contrib > 0) bal[0] += contrib;
        else if (contrib < 0) bal[0] = Math.max(0, bal[0] + contrib);
        /* Deal proceeds arriving DURING the run-up, in the year they arrive. */
        if (early[y] > 0) bal[0] += early[y];
        for (let i = 0; i < bal.length; i++) {
          const s = sleeves[i];
          /* Income is reinvested rather than spent: nobody is drawing yet. */
          const d = draw(s, hist, y - curveFrom);
          bal[i] = Math.max(0, (bal[i] * (1 + d.yield)) * (1 + d.price));
        }
        inflF *= (1 + inflAt(hist, y - curveFrom, false));
        if (rebalancing) {
          let t0 = 0;
          for (let i = 0; i < bal.length; i++) t0 += bal[i];
          if (t0 > 0) for (let i = 0; i < bal.length; i++) bal[i] = t0 * target[i];
        }
        let upTot = 0;
        for (let i = 0; i < bal.length; i++) upTot += bal[i];
        const ci = y - curveFrom;
        if (ci >= 0 && ci < curve.length) curve[ci].push(upTot);
      }

      for (let age = stopAge; age <= endAge; age++) {
        const yi = age - stopAge;
        const calYear = C.birthYear + age;
        /* THE OPENING BALANCE, captured before anything touches it. The ledger has to foot:
           last year's closing IS this year's opening, and reconstructing it afterwards from
           balanceAfter minus growth plus withdrawals does not come back to the same number,
           because rebalancing and the dated flows move money in between. Recorded rather
           than derived. */
        let openBal = 0;
        for (let i = 0; i < bal.length; i++) openBal += bal[i];
        const full = baseSpend * inflF;
        const floor = baseFloor * inflF;
        const benefit = age >= C.benefitAge ? baseBenefit * inflF : 0;

        let liquid = 0;
        for (let i = 0; i < bal.length; i++) liquid += bal[i];

        /* What the plan asks for this year, which is where the modes differ. */
        let need;
        if (C.mode === 'fixed') need = full;
        else if (C.mode === 'floor') need = floor;
        else need = full * guardMult((liquid + benefit) / Math.max(1, full));

        want += full;
        const asked = need;          // what THIS mode asked for, which is what it is judged on
        let rem = need, paid = 0;

        /* 1. The benefit, which arrives whatever the markets did. */
        const fromBenefit = Math.min(rem, benefit);
        rem -= fromBenefit; paid += fromBenefit;

        /* 2. Dated money landing THIS year: a property sale, a pension, an inheritance, a
           new roof. Kept SEPARATE from deal proceeds in the composition chart, because a
           contracted pension and a hoped-for exit are not the same kind of money and
           stacking them in one colour would say they were.

           A negative entry -- the roof, a tuition bill -- is an outgoing, so it raises what
           the year needs rather than paying for it. */
        let fromDated = 0;
        const dated = (C.dated && C.dated[calYear]) ? C.dated[calYear].net : 0;
        if (dated < 0) { rem += -dated; }
        else if (dated > 0) {
          fromDated = Math.min(rem, dated);
          rem -= fromDated; paid += fromDated;
          if (dated > fromDated) bal[0] += (dated - fromDated);
        }

        /* 3. Deal proceeds landing THIS year. They are cash on arrival; whatever is not
           needed is swept into the first sleeve rather than vanishing. */
        let fromDeals = 0;
        const arrived = Math.max(0, mine[calYear] || 0);
        if (arrived > 0) {
          fromDeals = Math.min(rem, arrived);
          rem -= fromDeals; paid += fromDeals;
          if (arrived > fromDeals) bal[0] += (arrived - fromDeals);
        }

        /* 3. The sleeves, in order. Yield before principal throughout. */
        const took = sleeves.map(() => 0);
        /* Kept apart for the trace. The two are the whole of the draw-order rule -- all
           yield, from every sleeve, before any principal from any of them. */
        const tookYield = sleeves.map(() => 0);
        const tookPrin = sleeves.map(() => 0);
        const grew = sleeves.map(() => 0);
        /* INCOME EARNED, as distinct from income SPENT. grew[] is price movement only,
           and the part of a yield that is not drawn stays invested, so a ledger built
           from opening + growth - withdrawals does not reach the closing balance. It
           was out by exactly the retained income. */
        const earned = sleeves.map(() => 0);
        for (let i = 0; i < sleeves.length; i++) {
          const s = sleeves[i];
          const d = draw(s, hist, calYear - curveFrom);
          const inc = Math.max(0, bal[i] * d.yield);
          earned[i] = inc;
          /* Income is taxed on the way out like everything else, so what reaches the
             spending is what survives the rate. */
          const net = Math.min(rem, netOf(inc, i));
          const take = grossFor(net, i);
          rem -= net; paid += net; took[i] += take; tookYield[i] = take;
          bal[i] += (inc - take);                       // unspent income stays invested
          const before = bal[i];
          bal[i] *= (1 + d.price);
          bal[i] = Math.max(0, bal[i]);
          grew[i] = bal[i] - before;
        }
        if (proportional) {
          /* Pro rata across whatever is left, in one pass, then a sweep for anything the
             rounding left behind. Taking a share of each sleeve is what a rebalanced
             portfolio does when it funds a withdrawal. */
          let pot = 0;
          for (let i = 0; i < bal.length; i++) pot += bal[i];
          if (pot > 0 && rem > 1) {
            const want = Math.min(rem, pot);
            for (let i = 0; i < sleeves.length; i++) {
              const gross = Math.min(bal[i], grossFor(want * (bal[i] / pot), i));
              const net = netOf(gross, i);
              rem -= net; paid += net; took[i] += gross; tookPrin[i] += gross;
              bal[i] = Math.max(0, bal[i] - gross);
            }
          }
        }
        for (let i = 0; i < sleeves.length && rem > 1; i++) {
          /* The gross the shortfall needs, or everything left, whichever is smaller. A sleeve
             that cannot cover the gross still pays what it can, net. */
          const gross = Math.min(bal[i], grossFor(rem, i));
          const net = netOf(gross, i);
          rem -= net; paid += net; took[i] += gross; tookPrin[i] += gross;
          bal[i] = Math.max(0, bal[i] - gross);
        }

        /* REBALANCE, after the year is funded and the returns are in. Restores the mix the
           reader typed, which is the whole point of having a mix: without it the growth
           sleeve quietly takes over and the plan ends up riskier than the one described. */
        if (rebalancing) {
          let tot = 0;
          for (let i = 0; i < bal.length; i++) tot += bal[i];
          if (tot > 0) for (let i = 0; i < bal.length; i++) bal[i] = tot * target[i];
        }

        /* Judged against what the mode asked for, not against the untrimmed target. A
           floor plan that covers its floor every year is succeeding; scoring it against
           the full target reported it as a 28-year failure. */
        if (rem > 1) {
          if (!short) {
            /* The FIRST failure only. A plan that runs dry at 71 and stays dry to 92 has
               one cause and twenty-one symptoms; recording every year would report the
               symptoms twenty-one times and bury the cause. */
            firstShortAge = age;
            firstShortGap = rem;
            /* NOT "what was empty here", which is always everything: a plan is short
               precisely BECAUSE every sleeve drained, so that question answers itself and
               tells the reader nothing. The diagnostic fact is which sleeve emptied FIRST
               and when, recorded as it happens below. */
            firstShortEmpty = firstDry || 'nothing emptied';
          }
          short = true;
        }

        /* The first sleeve to hit zero, whether or not the plan ever falls short. It is
           the earliest warning the model produces: cash gone at 71 says something is wrong
           long before the money actually runs out at 83. */
        if (!firstDry) {
          for (let i = 0; i < bal.length; i++) {
            if (bal[i] < 1 && sleeves[i].balance > 0) {
              firstDry = sleeves[i].label; firstDryAge = age; break;
            }
          }
        }

        let left = 0;
        for (let i = 0; i < bal.length; i++) left += bal[i];
        paidBy.benefit[yi].push(fromBenefit);
        paidBy.dated[yi].push(fromDated);
        paidBy.deals[yi].push(fromDeals);
        sleeves.forEach((s, i) => { paidBy[s.id][yi].push(took[i]); });
        wealth[yi].push(left);
        needAt[yi] = full;
        const cj = calYear - curveFrom;
        if (cj >= 0 && cj < curve.length) curve[cj].push(left);

        if (trace && p === traceAt) {
          trace.push({
            year: calYear, age, opening: openBal,
            fullTarget: full, asked, mode: C.mode,
            benefit: fromBenefit,
            dated: (C.dated && C.dated[calYear]) ? C.dated[calYear].net : 0,
            deals: fromDeals,
            dealsAvailable: Math.max(0, mine[calYear] || 0),
            sleeves: sleeves.map((sv, i) => ({
              label: sv.label, yield: tookYield[i], principal: tookPrin[i], income: earned[i],
              growth: grew[i], balanceAfter: bal[i],
            })),
            paid, unmet: rem > 1 ? rem : 0, short: rem > 1,
          });
        }

        /* Advance inflation for NEXT year, after this year's target has been set from the
           factor as it stood. At the stop year the factor is exactly the compounding of the
           saving years, which is what makes today money the unit the reader typed in. */
        inflF *= (1 + inflAt(hist, calYear - curveFrom, true));

        got += paid;
        const frac = paid / Math.max(1, asked);
        if (frac >= 0.999) nFull++;
        if (frac < 0.90) { run++; if (run > worst) worst = run; } else run = 0;
      }

      if (short) {
        breakYear.push(firstShortAge);
        breakGap.push(firstShortGap);
        const k = firstDry ? (firstDry + '|' + firstDryAge) : 'nothing emptied|0';
        breakEmpty[k] = (breakEmpty[k] || 0) + 1;
        if (firstDryAge != null) dryAges.push(firstDryAge);
      }
      if (!short) neverShort++;
      okRuns.push(short ? 0 : 1);
      /* A PLAN THAT ASKS FOR NOTHING GOT ALL OF NOTHING, which is 1, not NaN. `want` is
         zero whenever the whole horizon is covered by a benefit or by dated income, which is
         a real thing to model and not an error, and the panel prints this as a percentage so
         the one case that trivially succeeds was rendering as "NaN%". */
      shares.push(want > 0 ? got / want : 1);
      fulls.push(nFull / nYears);
      worsts.push(worst);
      let end = 0;
      for (let i = 0; i < bal.length; i++) end += bal[i];
      terms.push(end);
    }

    const byYear = [];
    for (let y = 0; y < nYears; y++) {
      const w = sortNum(wealth[y]);
      const row = {
        age: stopAge + y,
        year: C.birthYear + stopAge + y,
        need: needAt[y],
        wealth: { p10: q(w, 0.10), p50: q(w, 0.50), p90: q(w, 0.90) },
        from: {},
      };
      row.from.benefit = q(sortNum(paidBy.benefit[y]), 0.50);
      row.from.dated = q(sortNum(paidBy.dated[y]), 0.50);
      row.from.deals = q(sortNum(paidBy.deals[y]), 0.50);
      sleeves.forEach((s) => { row.from[s.id] = q(sortNum(paidBy[s.id][y]), 0.50); });
      byYear.push(row);
    }

    return {
      cfg: C,
      sleeves,
      rebalancing,
      drawOrder: C.drawOrder || 'safe-first',
      /* Every path's ending wealth, in path order, so a caller can find which future
         sat in the middle and ask for that one to be traced. */
      terminalByPath: terms.slice(),
      tax: { on: TAX.on, preTax: TAX.preTax, taxable: TAX.taxable, roth: TAX.roth,
             bySleeve: sleeves.map((sv, i) => ({ label: sv.label, rate: taxRate[i],
               mix: sv.taxMix || null })) },
      stopAge,
      endAge,
      neverShort: neverShort / nPaths,
      /* Share of the FULL target, always -- so a floor plan cannot look complete just
         because it met the smaller number it set itself. */
      share: q(sortNum(shares), 0.50),
      fullYears: q(sortNum(fulls), 0.50),
      worstRun: q(sortNum(worsts), 0.50),
      terminal: {
        p10: q(sortNum(terms), 0.10),
        p50: q(sortNum(terms), 0.50),
        p90: q(sortNum(terms), 0.90),
      },
      byYear,
      trace,
      /* THE WHOLE LIFE, one row per calendar year, with the stop year marked so a chart can
         show where earning ends and drawing begins. */
      curve: curve.map((vals, i) => {
        const v = sortNum(vals);
        return {
          year: curveFrom + i,
          age: curveFrom + i - C.birthYear,
          phase: (curveFrom + i) < (C.birthYear + stopAge) ? 'saving' : 'drawing',
          p10: v.length ? q(v, 0.10) : 0,
          p50: v.length ? q(v, 0.50) : 0,
          p90: v.length ? q(v, 0.90) : 0,
        };
      }),
      stopYear: C.birthYear + stopAge,
      hasDeals: !!arr,
      /* Null when nothing failed, which is a different statement from "it failed at zero"
         and has to read differently on screen. */
      breaks: breakYear.length ? {
        n: breakYear.length,
        share: breakYear.length / nPaths,
        ageP10: q(sortNum(breakYear), 0.10),
        ageP50: q(sortNum(breakYear), 0.50),
        gapP50: q(sortNum(breakGap), 0.50),
        dryAgeP50: dryAges.length ? q(sortNum(dryAges), 0.50) : null,
        empty: (function () {
          /* Grouped by WHICH sleeve emptied first, with the typical age it happened. */
          const by = {};
          Object.keys(breakEmpty).forEach((k) => {
            const nm = k.split('|')[0];
            by[nm] = (by[nm] || 0) + breakEmpty[k];
          });
          return Object.keys(by)
            .map((nm) => ({ what: nm, n: by[nm], share: by[nm] / breakYear.length }))
            .sort((a, b) => b.n - a.n);
        }()),
      } : null,
    };
  }

  /* WHAT ACTUALLY MOVES THE NUMBER.
   *
   * "Never short 76%" is the least actionable true sentence a tool can print: it tells a
   * reader they might fail and nothing about what to do. The obvious answer is to attribute
   * the failures to causes, but attribution in a model with this many interacting parts is
   * mostly storytelling -- you can always construct a plausible cause after the fact.
   *
   * So this does not attribute. It RE-RUNS the model with one thing changed at a time and
   * reports what happened, which is not a theory about causation but a measurement of it.
   * Same seed throughout, so a difference between two runs is the change and not a
   * different random world.
   *
   * These are sensitivities, not recommendations. The tool has no view on whether anyone
   * should work two more years; it can say what two more years did to the number.
   */
  function levers(cfg, opts) {
    const o = opts || {};
    const paths = o.paths || 700;
    const base = Object.assign({}, DEFAULTS, cfg, { paths });
    const run = (patch) => simulate(Object.assign({}, base, patch));

    const b = run({});
    if (!b) return null;

    const out = [];
    const add = (label, patch, note) => {
      const r = run(patch);
      if (!r) return;
      out.push({
        label,
        note: note || '',
        neverShort: r.neverShort,
        delta: r.neverShort - b.neverShort,
        share: r.share,
      });
    };

    add('Spend 10% less', { spend: base.spend * 0.9 },
        'the biggest lever in almost every plan, and the least popular');
    add('Work two more years', { stopYear: base.stopYear + 2 },
        'two more years of earning, two fewer of drawing');
    if (base.benefitAge < 70) {
      /* Claiming later is worth roughly 8% a year in the US and similar elsewhere. Modelled
         as a straight uplift rather than a schedule, because the schedule is jurisdictional
         and the point here is the direction and rough size. */
      const yrs = 70 - base.benefitAge;
      add('Claim the benefit at 70', { benefitAge: 70, benefitAnnual: base.benefitAnnual * (1 + 0.08 * yrs) },
          'later but larger, at roughly 8% a year of waiting');
    }
    if (base.mode !== 'guard') {
      add('Use guardrails', { mode: 'guard' },
          'trim the ask in thin years instead of drawing through them');
    }
    if (base.mode !== 'floor') {
      add('Spend only the floor', { mode: 'floor' },
          'never short, at the price of never spending the full target');
    }
    if (base.dealSim) {
      add('Without the private deals', { dealSim: null },
          'what the book is actually worth to the plan');
    }
    if (base.dated) {
      add('Without property and pensions', { dated: null },
          'what the house, the pension and the one-offs are worth');
    }

    /* Ranked by effect, largest first. A list in declaration order would bury the one that
       matters under the ones that happened to be written first. */
    out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return { base: b, levers: out, paths };
  }

  const Runway = { simulate, levers, DEFAULTS, SLEEVE_KINDS, DRAW_ORDER, DRAW_ORDERS,
                   normSleeves };
  /* WHY THERE IS NOTHING TO SHOW, specifically. simulate() returns null for four different
     reasons and the panel named two of them, which tells a reader with the third or fourth
     nothing at all. The author knows which of his own numbers is odd; somebody running their
     own sheet for the first time does not, and that is who this is for. */
  function diagnose(cfg) {
    const C = Object.assign({}, DEFAULTS, cfg || {});
    const sl = (C.sleeves || []).filter((s) => Number(s && s.balance) > 0);
    const stopAge = C.stopYear - C.birthYear;
    if (!(C.sleeves || []).length) {
      return { ok: false, why: 'no-sleeves',
        msg: 'There are no balances to run this on. Add a <b>Balances</b> tab to your tracker '
          + 'with one row per account and what is in it.' };
    }
    if (!sl.length) {
      return { ok: false, why: 'zero-balances',
        msg: 'Every balance on the Balances tab is zero, so there is nothing to draw on. If '
          + 'that is a placeholder sheet, fill in the amounts and run it again.' };
    }
    if (!(stopAge > 0)) {
      return { ok: false, why: 'stop-before-birth',
        msg: 'The stop-work year (' + C.stopYear + ') is at or before the birth year ('
          + C.birthYear + '). Check both on the <b>You</b> tab.' };
    }
    /* A FOUR-DIGIT PLAN AGE IS A YEAR IN AN AGE BOX. Somebody who has just typed 1968 for a
       birth year and 2030 for a stop year is thinking in years, and the next field is an age.
       Taken literally it ran a two-thousand-year retirement and said nothing. Refused rather
       than corrected, because reading 2095 as 95 would be the tool guessing at an input, but
       the message names what it probably meant. 130 is the cut-off: the oldest verified human
       age is 122, so this leaves room for the most optimistic real plan. */
    if (C.planToAge > 130) {
      const guess = C.planToAge > 1900 && C.planToAge < 2200
        ? C.planToAge - C.birthYear : null;
      return { ok: false, why: 'plan-age-is-a-year',
        msg: 'The plan runs to age <b>' + C.planToAge + '</b>, which is a year rather than an '
          + 'age. ' + (guess && guess > 0 && guess < 130
            ? 'Living to ' + C.planToAge + ' from a ' + C.birthYear + ' birth year is age <b>'
              + guess + '</b>, which is probably what was meant.'
            : 'Plan to age is an age, like 92, not a calendar year.') };
    }
    if (C.planToAge <= stopAge) {
      return { ok: false, why: 'plan-age-too-low',
        msg: 'The plan runs to age ' + C.planToAge + ', and work stops at age ' + stopAge
          + ', so there are no retirement years to model. Either plan to a later age or stop '
          + 'work sooner. A common cause is typing a YEAR where the plan age goes.' };
    }
    return { ok: true, why: null, msg: '' };
  }

  /* ONE COHERENT FUTURE, the middle one, as a year-by-year ledger.

     The byYear rows are percentiles and cannot be read down: the median wealth in 2040 and the
     median wealth in 2041 belong to different futures, so the difference between them is not a
     cash flow. A table built from those would invite exactly the arithmetic it cannot survive.

     This runs the model, finds the path whose ENDING wealth is the median, and runs it again
     asking for that path to be recorded. The generator is seeded, so the second pass reproduces
     the same futures exactly. What comes back is a real future that happened, which adds up
     line by line, and which is representative in the only sense that matters for a plan. */
  function medianTrace(cfg) {
    const first = simulate(Object.assign({}, cfg || {}));
    if (!first || !first.terminalByPath || !first.terminalByPath.length) return null;
    const idx = first.terminalByPath
      .map((v, i) => [v, i])
      .sort((a, b) => a[0] - b[0])[Math.floor(first.terminalByPath.length / 2)][1];
    const second = simulate(Object.assign({}, cfg || {}, { trace: true, traceAt: idx }));
    if (!second || !second.trace) return null;
    return { pathIndex: idx, rows: second.trace, terminal: first.terminalByPath[idx],
             of: first.terminalByPath.length };
  }

  Runway.medianTrace = medianTrace;
  Runway.diagnose = diagnose;
  root.Runway = Runway;
  if (typeof module !== 'undefined' && module.exports) module.exports = Runway;
}(typeof window !== 'undefined' ? window : globalThis));
