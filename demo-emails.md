# PayrollBot — Demo Emails

## ⏱ Timesheet emails (hourly pay)

### ✅ Normal — auto-approved
**Subject:** `timesheet - Ana Petrovic`
```
Hi, I worked 23 hours this week on the website redesign project.
My rate is $45/hour.
My Solana wallet: REPLACE_WITH_DEVNET_ADDRESS
Thanks, Ana
```

### ⚠️ Flagged — too many hours
**Subject:** `timesheet - Marko Jovanovic`
```
Hi, please process my timesheet. I worked 72 hours this week on the mobile app.
My rate is $55/hour. Wallet: REPLACE_WITH_DEVNET_ADDRESS
```

### ❓ Clarification needed — vague email
**Subject:** `timesheet - Jelena Markovic`
```
Hey, timesheet for this week. Worked the usual amount, rate is the same as always.
```

---

## 📦 Submission emails (QA-gated project delivery)

### ✅ Full pass — all requirements met
**Subject:** `submission - ecommerce-checkout`
```
Hi,

I've completed the e-commerce checkout redesign. Here's what I delivered:

- Shopping cart now uses localStorage — persists on page reload ✓
- Integrated Stripe Elements — card, expiry, CVV fields present ✓
- Fully responsive from 320px up, tested on iPhone 12 and desktop ✓
- Order confirmation email triggers via SendGrid on payment success ✓
- Added loading spinners on Add to Cart and Checkout buttons ✓
- Inline validation with error messages before form submission ✓
- HTTPS enforced, no mixed content warnings ✓

GitHub: https://github.com/ana/ecommerce-checkout
Live demo: https://checkout-demo.vercel.app

Ana
```

### ⚠️ Partial pass — some requirements missing
**Subject:** `submission - ecommerce-checkout`
```
Hi,

Checkout redesign is done. Here's what I built:

- Cart persists using localStorage ✓
- Stripe Elements integrated for payment ✓
- Responsive layout built with CSS Grid ✓

I didn't get to the order confirmation email or the loading states yet,
will finish those next week.

GitHub: https://github.com/ana/checkout-v2
```

### ❌ Fail — major requirements missing
**Subject:** `submission - api-backend`
```
Hi,

The API is ready. I built the user CRUD endpoints and they work well.
No auth yet, planning to add JWT later. No tests written but the
code is clean. Documentation coming soon.

GitHub: https://github.com/marko/api
```

---

> **Note:** Replace `REPLACE_WITH_DEVNET_ADDRESS` with your actual devnet wallet address.
> Project IDs in submission subjects must match keys in `src/data/projects.json`.
