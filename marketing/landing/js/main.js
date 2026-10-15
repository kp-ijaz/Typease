/* TypEase Landing — main.js */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var vh = function () { return window.innerHeight; };

  /* ---------- Customer app walkthrough ---------- */
  var CUST = [
    ['m-login', 'Centre-branded sign-in'], ['m-dashboard', 'Waiting for you'], ['m-new', 'New request'],
    ['m-requests', 'Track every request'], ['m-documents', 'My documents'], ['m-payments', 'Pay online'], ['m-statement', 'Statement of account']
  ];
  var CUST_MS = 5000, ci = 1, custTimer = null;
  var steps = $$('[data-cust-step]'), shots = $$('[data-cust-shot]');
  var prevImg = $('[data-js="cust-prev"]'), nextImg = $('[data-js="cust-next"]'), label = $('[data-js="cust-label"]');
  function renderCust() {
    var n = CUST.length;
    steps.forEach(function (b, k) {
      var on = k === ci;
      b.classList.toggle('is-active', on);
      if (on) { var bar = b.querySelector('.cust-step-bar'); if (bar) { var nb = bar.cloneNode(false); bar.parentNode.replaceChild(nb, bar); } }
    });
    shots.forEach(function (im, k) { im.classList.toggle('is-active', k === ci); });
    if (prevImg) prevImg.src = 'assets/' + CUST[(ci - 1 + n) % n][0] + '.jpg';
    if (nextImg) nextImg.src = 'assets/' + CUST[(ci + 1) % n][0] + '.jpg';
    if (label) label.textContent = (ci + 1) + ' / ' + n + ' \u00b7 ' + CUST[ci][1];
  }
  function startCust() {
    clearInterval(custTimer);
    custTimer = setInterval(function () { ci = (ci + 1) % CUST.length; renderCust(); }, CUST_MS);
  }
  function setCust(i) { var n = CUST.length; ci = (i + n) % n; renderCust(); startCust(); }
  steps.forEach(function (b) { b.addEventListener('click', function () { setCust(+b.getAttribute('data-cust-step')); }); });
  var pb = $('[data-js="cust-prev-btn"]'), nbtn = $('[data-js="cust-next-btn"]');
  if (pb) pb.addEventListener('click', function () { setCust(ci - 1); });
  if (nbtn) nbtn.addEventListener('click', function () { setCust(ci + 1); });
  if (steps.length) { renderCust(); startCust(); }

  /* ---------- Admin panel roles ---------- */
  var ROLES = [
    { title: 'Owner', login: 'owner@al-noor.test', text: 'Everything, every branch: what needs attention today, revenue and collections, staff workload, the request board, finance, accounting, payroll and the centre\u2019s settings.', shots: [['assets/owner-dashboard.jpg', 'Dashboard'], ['assets/owner-board.jpg', 'Request board']] },
    { title: 'Branch manager', login: 'manager@al-noor.test', text: 'One branch, enforced in the database: its requests, its staff and its figures, with approvals and reports for that branch only.', shots: [['assets/manager-dashboard.jpg', 'Branch dashboard'], ['assets/manager-staff.jpg', 'Staff']] },
    { title: 'Receptionist', login: 'reception.dubai@al-noor.test', text: 'The counter: find or add the customer, start a request with the right documents and price, take payment, and answer WhatsApp.', shots: [['assets/reception-new.jpg', 'New request'], ['assets/reception-customers.jpg', 'Customers']] },
    { title: 'Typing operator', login: 'operator1@al-noor.test', text: 'My work: requests assigned to me with their documents and form, the time left at each stage, and the next status in one click.', shots: [['assets/operator-dashboard.jpg', 'My work'], ['assets/operator-requests.jpg', 'Requests']] },
    { title: 'Reviewer', login: 'reviewer@al-noor.test', text: 'Documents to review and final checks before submission, with rejection reasons that go straight to the customer.', shots: [['assets/reviewer-dashboard.jpg', 'Review queue'], ['assets/owner-paperwork-issued.jpg', 'Ready-made document']] },
    { title: 'Accountant', login: 'accountant@al-noor.test', text: 'Invoices, payments and refunds, cash register shifts, the books with profit and loss, balance sheet and VAT return, and monthly payroll.', shots: [['assets/accountant-invoices.jpg', 'Invoices'], ['assets/owner-pl.jpg', 'Profit and loss']] },
    { title: 'Platform console', login: 'admin@typease.test', app: 'platform', url: 'admin.typease.ae', text: 'The operator of the platform: every centre with its plan and status, subscriptions and coupons, support access, integrations and the authority fee catalogue.', shots: [['assets/platform-dashboard.jpg', 'Platform dashboard'], ['assets/platform-tenants.jpg', 'Centres']] }
  ];
  var role = 0, shot = 0, swapT = null;
  var tabs = $$('[data-role-tab]'), thumbs = $$('[data-role-thumb]');
  var shotImg = $('[data-js="role-shot"]'), rTitle = $('[data-js="role-title"]'), rText = $('[data-js="role-text"]');
  var rLogin = $('[data-js="role-login"]'), rUrl = $('[data-js="role-url"]');
  function renderRole() {
    var r = ROLES[role];
    tabs.forEach(function (t, k) { t.classList.toggle('is-active', k === role); });
    thumbs.forEach(function (t, k) {
      t.classList.toggle('is-active', k === shot);
      var im = t.querySelector('img'); if (im && r.shots[k]) { im.src = r.shots[k][0]; im.alt = r.shots[k][1]; }
    });
    if (rTitle) rTitle.textContent = r.title;
    if (rText) rText.textContent = r.text;
    if (shotImg) shotImg.src = r.shots[shot][0];
    if (rUrl) rUrl.textContent = r.url || 'app.typease.ae';
    if (rLogin && window.TypEaseDemo) { rLogin.href = window.TypEaseDemo.href(r.app || 'centre', r.login); rLogin.textContent = 'Log in as ' + r.title.replace(' console', ' admin') + ' \u2192'; }
  }
  function swap(nextRole, nextShot) {
    if (shotImg) shotImg.style.opacity = '0';
    clearTimeout(swapT);
    swapT = setTimeout(function () { role = nextRole; shot = nextShot; renderRole(); if (shotImg) shotImg.style.opacity = '1'; }, 180);
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { var i = +t.getAttribute('data-role-tab'); if (i !== role) swap(i, 0); }); });
  thumbs.forEach(function (t) { t.addEventListener('click', function () { var i = +t.getAttribute('data-role-thumb'); if (i !== shot) swap(role, i); }); });
  if (tabs.length) renderRole();

  /* ---------- "Live demo" links: scroll to hero demo buttons and highlight ---------- */
  var hlT = null;
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-demo-link]');
    if (!a) return;
    var box = document.getElementById('hero-demo');
    if (!box) return;
    e.preventDefault();
    window.scrollTo({ top: box.getBoundingClientRect().top + window.scrollY - 160, behavior: 'smooth' });
    clearTimeout(hlT);
    hlT = setTimeout(function () {
      if (!box.animate) return;
      box.animate([
        { boxShadow: '0 0 0 0 rgba(11,122,209,0)', background: 'rgba(11,122,209,0)' },
        { boxShadow: '0 0 0 1.5px rgba(11,122,209,.85), 0 0 50px 4px rgba(11,122,209,.25)', background: 'rgba(11,122,209,.10)', offset: .2 },
        { boxShadow: '0 0 0 1.5px rgba(11,122,209,.85), 0 0 50px 4px rgba(11,122,209,.25)', background: 'rgba(11,122,209,.10)', offset: .75 },
        { boxShadow: '0 0 0 0 rgba(11,122,209,0)', background: 'rgba(11,122,209,0)' }
      ], { duration: 2600, easing: 'ease-out' });
      $$('a', box).forEach(function (b, i) {
        b.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-4px)', background: '#0B7AD1', borderColor: '#0B7AD1' }, { transform: 'translateY(0)' }],
          { duration: 800, delay: 200 + i * 140, easing: 'cubic-bezier(.2,.7,.2,1)' });
      });
    }, Math.min(900, Math.abs(box.getBoundingClientRect().top - 160) / 3 + 200));
  });

  /* ---------- Cursor glow in dark sections ---------- */
  $$('[data-glow]').forEach(function (sec) {
    var spot = sec.querySelector('[data-glow-spot]'); if (!spot) return;
    var x = 0, y = 0, tx = 0, ty = 0, raf = 0, on = false;
    function tick() {
      x += (tx - x) * 0.14; y += (ty - y) * 0.14;
      spot.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      raf = (Math.abs(tx - x) > 0.3 || Math.abs(ty - y) > 0.3) ? requestAnimationFrame(tick) : 0;
    }
    sec.addEventListener('mousemove', function (e) {
      var r = sec.getBoundingClientRect();
      tx = e.clientX - r.left; ty = e.clientY - r.top;
      if (!on) { x = tx; y = ty; on = true; spot.classList.add('is-on'); }
      if (!raf) raf = requestAnimationFrame(tick);
    });
    sec.addEventListener('mouseleave', function () { on = false; spot.classList.remove('is-on'); });
  });

  /* ---------- Scroll reveal ---------- */
  var reveals = $$('[data-reveal]');
  if ('IntersectionObserver' in window) {
    reveals.forEach(function (el) {
      if (el.getBoundingClientRect().top > vh() * 0.92) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(36px)';
        el.style.transition = 'opacity .9s cubic-bezier(.2,.7,.2,1), transform .9s cubic-bezier(.2,.7,.2,1)';
        el.style.transitionDelay = (el.getAttribute('data-delay') || 0) + 'ms';
      }
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var el = en.target;
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
        io.unobserve(el);
        setTimeout(function () { el.style.removeProperty('opacity'); el.style.removeProperty('transform'); el.style.removeProperty('transition'); el.style.removeProperty('transition-delay'); }, 1000 + (+el.getAttribute('data-delay') || 0));
      });
    }, { threshold: 0.12 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Parallax, hero depth layers, back-to-top ---------- */
  var par = $$('[data-speed]');
  var layers = $$('[data-depth]').map(function (el) {
    var t = getComputedStyle(el).transform;
    return { el: el, d: parseFloat(el.getAttribute('data-depth')), base: (t && t !== 'none') ? t : '' };
  });
  var hero = $('[data-hero]'), mx = 0, my = 0, raf = 0;
  var topBtn = $('.back-to-top'), ring = $('[data-js="top-ring"]');
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var h = vh();
      par.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < -200 || r.top > h + 200) return;
        var c = r.top + r.height / 2 - h / 2;
        el.style.transform = 'translate3d(0,' + (-c * parseFloat(el.getAttribute('data-speed'))).toFixed(1) + 'px,0)';
      });
      var max = document.documentElement.scrollHeight - h;
      var sp = max > 0 ? Math.round(window.scrollY / max * 100) / 100 : 0;
      if (topBtn) topBtn.classList.toggle('is-visible', sp > 0.04);
      if (ring) ring.setAttribute('stroke-dashoffset', (163.4 * (1 - sp)).toFixed(1));
      var p = Math.min(1, Math.max(0, window.scrollY / 700));
      layers.forEach(function (L) {
        L.el.style.transform = L.base + ' translate3d(' + (mx * L.d * 14).toFixed(1) + 'px,' + (my * L.d * 14 - p * L.d * 40).toFixed(1) + 'px,0)';
      });
    });
  }
  if (hero) {
    hero.addEventListener('mousemove', function (e) {
      var r = hero.getBoundingClientRect();
      mx = (e.clientX - r.left) / r.width - 0.5;
      my = (e.clientY - r.top) / r.height - 0.5;
      onScroll();
    });
    hero.addEventListener('mouseleave', function () { mx = 0; my = 0; onScroll(); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
})();
