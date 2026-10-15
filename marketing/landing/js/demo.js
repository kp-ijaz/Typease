/* TypEase Landing — demo.js: one-click demo logins.
   Each button opens <app>/sign-in?demo=<email> (portals also get ?tenant=<centre>). The app signs in with the
   shared demo password from its own NEXT_PUBLIC_DEMO_PASSWORD, so no password ever travels in a URL.
   Point APPS at the deployed demo (or set window.TYPEASE_DEMO_APPS before this script) when it is hosted. */
(function () {
  'use strict';
  var APPS = window.TYPEASE_DEMO_APPS || {
    centre: { url: 'http://localhost:3001', path: '/sign-in' },
    customer: { url: 'http://localhost:3002', path: '/login' },
    corporate: { url: 'http://localhost:3003', path: '/sign-in' },
    platform: { url: 'http://localhost:3004', path: '/sign-in' }
  };
  var APP_TEXT = {
    centre: 'The staff app of each centre. Every role sees its own menu, its own branch and its own work.',
    customer: "The centre's portal for individual customers — also available as the Flutter app for iOS and Android.",
    corporate: 'The portal for client companies: their employees, requests, approvals and invoices on account.',
    platform: 'The TypEase operator console: every centre, plan, subscription, support access and integration.'
  };
  var CENTRES = {
    'al-noor': 'Al Noor Typing Centre · Business plan, two branches, white label',
    'gulf-star': 'Gulf Star Document Services · Professional plan, one branch',
    'desert-rose': 'Desert Rose Typing · Starter plan, in its trial',
    platform: 'TypEase platform'
  };
  // [app, centre, role, name, email, what to look at]
  var A = [
    ['centre', 'al-noor', 'Owner', 'Salem Al Marri', 'owner@al-noor.test', 'Everything, both branches: dashboard, board, finance, accounting, payroll, settings.'],
    ['centre', 'al-noor', 'Branch manager', 'Priya Nair', 'manager@al-noor.test', 'Sharjah branch only: its requests, staff and reports.'],
    ['centre', 'al-noor', 'Receptionist', 'Maria Santos', 'reception.dubai@al-noor.test', 'Deira head office: new requests, customers, WhatsApp inbox, payments.'],
    ['centre', 'al-noor', 'Receptionist', 'Ahmed Farouk', 'reception.sharjah@al-noor.test', 'Sharjah branch counter.'],
    ['centre', 'al-noor', 'Typing operator', 'Rahul Menon', 'operator1@al-noor.test', 'Deira: visas, family files, Emirates ID.'],
    ['centre', 'al-noor', 'Typing operator', 'Fatima Zahra Idrissi', 'operator2@al-noor.test', 'Both branches: licences, attestation, translation.'],
    ['centre', 'al-noor', 'Typing operator', 'Bilal Chaudhry', 'operator3@al-noor.test', 'Sharjah: tenancy, Emirates ID, medical bundle.'],
    ['centre', 'al-noor', 'Document reviewer', 'Lakshmi Iyer', 'reviewer@al-noor.test', 'Document reviews and final checks.'],
    ['centre', 'al-noor', 'Accountant', 'Omar Haddad', 'accountant@al-noor.test', 'Invoices, payments, accounting, VAT and payroll.'],
    ['centre', 'gulf-star', 'Owner', 'Shaima Al Ali', 'owner@gulf-star.test', 'A centre on TypEase branding.'],
    ['centre', 'gulf-star', 'Receptionist', 'John Fernandes', 'reception@gulf-star.test', 'Counter work at a one-branch centre.'],
    ['centre', 'gulf-star', 'Typing operator', 'Usman Tariq', 'operator@gulf-star.test', 'Requests are assigned automatically.'],
    ['centre', 'gulf-star', 'Accountant', 'Meera Joshi', 'accountant@gulf-star.test', 'Finance for Gulf Star.'],
    ['centre', 'desert-rose', 'Owner', 'Mona Abdulla', 'owner@desert-rose.test', 'Trial banner and plan limits.'],
    ['centre', 'desert-rose', 'Receptionist', 'Carlos Reyes', 'reception@desert-rose.test', 'Counter work during the trial.'],
    ['customer', 'al-noor', 'Customer', 'Aisha Rahman', 'aisha.rahman@example.test', 'A request with the partner and one waiting for payment.'],
    ['customer', 'al-noor', 'Customer · Arabic', 'Noura Al Ketbi', 'noura.al.ketbi@example.test', 'Arabic portal; a quotation with a discount to accept.'],
    ['customer', 'al-noor', 'Customer', 'Grace Mendoza', 'grace.mendoza@example.test', 'Registered online; a draft to finish.'],
    ['customer', 'al-noor', 'Customer', 'Emily Carter', 'emily.carter@example.test', 'A quotation to accept or reject.'],
    ['customer', 'al-noor', 'Customer', 'Joseph Mathew', 'joseph.mathew@example.test', 'A rejected photo to replace.'],
    ['customer', 'al-noor', 'Customer', 'Rowena Castillo', 'rowena.castillo@example.test', 'Registered online; a draft.'],
    ['customer', 'al-noor', 'Customer · Arabic', 'Hassan El Sayed', 'hassan.el.sayed@example.test', 'Arabic; an invoice to pay online.'],
    ['customer', 'al-noor', 'Customer', 'Daniel Okafor', 'daniel.okafor@example.test', 'A new request, a cancelled one and a blocked deletion request.'],
    ['customer', 'gulf-star', 'Customer', 'Anita DSouza', 'anita.dsouza@example.test', 'An invoice to pay.'],
    ['customer', 'gulf-star', 'Customer', 'Marilou Ramos', 'marilou.ramos@example.test', 'Registered online; a draft.'],
    ['customer', 'gulf-star', 'Customer', 'Olivia Bennett', 'olivia.bennett@example.test', 'One completed request.'],
    ['customer', 'desert-rose', 'Customer', 'Liza Soriano', 'liza.soriano@example.test', 'One request waiting for payment.'],
    ['corporate', 'al-noor', 'Company administrator', 'Deepa Krishnan', 'admin@falcon-demo.test', 'Falcon Demo Logistics LLC: verified, credit approved, 6 employees.'],
    ['corporate', 'al-noor', 'Company administrator', 'Elias Haddad', 'admin@marsa-demo.test', 'Marsa Demo Catering LLC: suspended — can read, cannot order.'],
    ['corporate', 'gulf-star', 'Company administrator', 'Sanjay Kapoor', 'admin@pearl-demo.test', 'Pearl Demo Contracting LLC: two unpaid invoices on account.'],
    ['platform', 'platform', 'Super admin', 'Platform Admin', 'admin@typease.test', 'Centres, plans, subscriptions, coupons, integrations, authority fees.'],
    ['platform', 'platform', 'Support agent', 'Platform Support Agent', 'support@typease.test', 'Support tickets and time-limited access requests.']
  ];

  /** The sign-in address that logs straight in as this account. */
  function href(app, email, centre) {
    var a = APPS[app];
    var q = (app === 'customer' || app === 'corporate') && centre ? 'tenant=' + encodeURIComponent(centre) + '&' : '';
    return a.url + a.path + '?' + q + 'demo=' + encodeURIComponent(email);
  }
  window.TypEaseDemo = { href: href };

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var initials = function (n) { return n.split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); };

  // Links elsewhere on the page: data-login="app:email[:centre]".
  Array.prototype.forEach.call(document.querySelectorAll('[data-login]'), function (el) {
    var p = el.getAttribute('data-login').split(':');
    el.href = href(p[0], p[1], p[2]);
  });

  var list = document.querySelector('[data-js="demo-list"]');
  var appText = document.querySelector('[data-js="demo-app-text"]');
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-demo-tab]'));
  if (!list) return;
  tabs.forEach(function (t) {
    var app = t.getAttribute('data-demo-tab');
    var n = A.filter(function (r) { return r[0] === app; }).length;
    var c = t.querySelector('[data-demo-count]'); if (c) c.textContent = n;
  });
  function render(app) {
    tabs.forEach(function (t) { var on = t.getAttribute('data-demo-tab') === app; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on); });
    if (appText) appText.textContent = APP_TEXT[app];
    var html = '', group = null;
    A.forEach(function (r) {
      if (r[0] !== app) return;
      if (r[1] !== group) {
        if (group !== null) html += '</div>';
        group = r[1];
        html += '<h3 class="te-demo-centre">' + esc(CENTRES[group]) + '</h3><div class="te-demo-grid">';
      }
      var role = r[2].split(' · ')[0];
      html += '<article class="te-demo-card">' +
        '<div class="te-demo-who"><span class="te-demo-avatar" aria-hidden="true">' + esc(initials(r[3])) + '</span>' +
        '<div><div class="te-demo-role">' + esc(r[2]) + '</div><div class="te-demo-name">' + esc(r[3]) + '</div></div></div>' +
        '<div class="te-demo-email">' + esc(r[4]) + '</div>' +
        '<p class="te-demo-note">' + esc(r[5]) + '</p>' +
        '<a class="te-demo-btn" target="_blank" rel="noopener" href="' + esc(href(r[0], r[4], r[1])) + '">Log in as ' + esc(role) + ' <span aria-hidden="true">&rarr;</span></a>' +
        '</article>';
    });
    list.innerHTML = html + '</div>';
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { render(t.getAttribute('data-demo-tab')); }); });
  render('centre');
})();
