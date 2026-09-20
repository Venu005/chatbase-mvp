# WhatsApp Embedded Signup ("Connect with Facebook")

Embedded Signup lets your customers connect their own WhatsApp Business number by clicking a button, logging in to Facebook
and choosing (or creating) their WhatsApp Business account, instead of copying tokens out of Meta's developer console. You
operate **one Meta app for the whole platform**; each customer's number is attached to it.

> **Read this first.** Meta controls who may onboard customers this way. This guide follows Meta's public documentation
> (linked at the bottom); Meta renames menus and changes requirements often, so treat the click-paths as a map and check
> Meta's current guide when a screen differs. The code in this repository was tested against a fake Meta server that
> imitates the documented calls, **not against a live Meta app**. Do your first run with your own test number.

## What Meta requires (as documented)

- Your business must be a **Tech Provider**, Tech Partner or Solution Partner, and the app must be a **Business** type app.
- Before you can onboard real customers, the app needs **Advanced Access** (App Review) for the permissions the flow asks for
  (`whatsapp_business_management` and `whatsapp_business_messaging`).
- While the app is in development mode, the flow works for people with an admin, developer or tester role on the app. That is
  how you test.
- Completing **Business Verification** raises the number of customers you may onboard per week (Meta documents 10 without,
  200 with it).

If you are not a Tech Provider yet, keep using the **manual** connection ([whatsapp.md](whatsapp.md)); it needs none of this.

## Setup steps

### 1. Create the Meta app

In the Meta App Dashboard create an app of type **Business**, and add the **WhatsApp** product. Note the **App ID** and
**App secret** (App Dashboard, Settings, Basic):

```
META_APP_ID=...
META_APP_SECRET=...
```

### 2. Create the Embedded Signup configuration

Embedded Signup runs through **Facebook Login for Business**. Create a login *configuration* for the
**WhatsApp Embedded Signup** flow (App Dashboard, Facebook Login for Business, Configurations), choose the
permissions above, and copy its **Configuration ID**:

```
META_ES_CONFIG_ID=...
```

### 3. Allow your domain for the JavaScript SDK

In the app's Facebook Login (for Business) settings, enable login with the JavaScript SDK and add your app's public
address (the domain of `APP_URL`) to the allowed domains / redirect settings. The login popup only works from https addresses
(use a tunnel such as ngrok when testing locally, and set `APP_URL` to it).

### 4. Point Meta's webhook at the platform callback (once)

App Dashboard, WhatsApp, Configuration, Webhook:

- **Callback URL:** `APP_URL/api/whatsapp/webhook`
- **Verify token:** any random string you choose, the same value you put in `.env`:

```
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<openssl rand -hex 24>
```

Click *Verify and save*. The app must be running with the variable set, because Meta calls the URL during verification.
Subscribe the app to the **messages** field. Each customer's account is subscribed to your app automatically at signup.

### 5. Restart and check

```bash
pnpm preflight --live
```

It confirms Meta accepts `META_APP_ID` + `META_APP_SECRET`. (`META_ES_CONFIG_ID` and the webhook can only be proven by doing
a signup.) After a restart, the agent's WhatsApp tab shows a **Connect with Facebook** button; the manual form moves under
"Advanced".

### 6. Test with your own number

Log in to the dashboard as a user who is an admin, developer or tester of the Meta app, open an agent's WhatsApp tab, click
**Connect with Facebook**, and complete the popup. When it finishes the tab says "Connected". Send a message to that number
from another phone.

## What happens under the hood

1. The browser loads Facebook's JS SDK and calls `FB.login` with your configuration id and `response_type: "code"`.
2. When the customer finishes, Meta posts a `WA_EMBEDDED_SIGNUP` message (event `FINISH`) with the `phone_number_id`,
   `waba_id` and `business_id`, and the login callback returns a one-time **code** valid for about 30 seconds.
3. The browser sends those to `POST /api/agents/<id>/whatsapp/embedded`. The server **trusts none of it**:
   - it exchanges the code for the customer's business token using `META_APP_SECRET` (`GET /oauth/access_token`);
   - the token must be able to read the phone number, and the WhatsApp account must list that number;
   - it subscribes your app to the account's messages (`POST /<waba_id>/subscribed_apps`); if this fails nothing is saved;
   - it registers the number for the Cloud API with a random 6-digit PIN (`POST /<phone_number_id>/register`); if Meta says
     the number is already registered, the connection still succeeds and the owner sees a warning;
   - it saves the channel with the token and PIN encrypted.
4. Messages for all customers then arrive at `APP_URL/api/whatsapp/webhook`, are checked against `META_APP_SECRET`, and are
   routed to the right agent by phone number id.

Disconnecting an agent unsubscribes the account from your app (best effort) and deletes the channel.

## Open points to verify with Meta before you launch

- **Token lifetime.** The business token returned by the code exchange is stored as-is. If Meta's token for your setup
  expires, sending starts failing with an authentication error; the fix is for the customer to click Connect again. Check
  Meta's documentation for the token type you receive, and consider adding a re-connect reminder if it expires.
- **Registration PIN.** Meta may already register numbers created inside the flow. A registration error is shown as a warning,
  not a failure.
- **Payment method.** A customer's WhatsApp account needs a payment method in Meta Business Manager before it can send
  business-initiated conversations. That is a separate step Meta asks the customer to complete.
- **Coexistence / existing WhatsApp Business app numbers** and other flow variants (for example `FINISH_ONLY_WABA`) are not
  handled; only the standard Cloud API `FINISH` event with a phone number is.

## Meta documentation

- Embedded Signup overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
- Implementation: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- Onboarding customers as a Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
